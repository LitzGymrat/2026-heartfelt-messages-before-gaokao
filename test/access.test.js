const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

process.env.SITE_ACCESS_PASSWORD = 'test-password-only';
process.env.ACCESS_TOKEN_SECRET = 'test-token-secret-with-enough-entropy';
process.env.R2_ACCOUNT_ID = 'test-account';
process.env.R2_ACCESS_KEY_ID = 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';

const app = require('../api/index.js');
const vercelConfig = require('../vercel.json');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

async function signIn() {
  const response = await fetch(`${baseUrl}/api/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.SITE_ACCESS_PASSWORD }),
  });
  assert.equal(response.status, 204);
  return response.headers.get('set-cookie').split(';')[0];
}

test('public front-end files do not expose passwords, credentials, or object keys', async () => {
  for (const pathname of ['/', '/app.js', '/site-config.js']) {
    const response = await fetch(`${baseUrl}${pathname}`);
    const body = await response.text();
    assert.equal(response.status, 200, pathname);
    assert.equal(body.includes(process.env.SITE_ACCESS_PASSWORD), false, pathname);
    assert.equal(body.includes(process.env.R2_ACCOUNT_ID), false, pathname);
    assert.equal(body.includes('courses/chinese.mp4'), false, pathname);
    assert.equal(body.includes('R2_SECRET_ACCESS_KEY'), false, pathname);
  }
});

test('session uses a non-expiring signed HttpOnly strict cookie', async () => {
  const denied = await fetch(`${baseUrl}/api/video-url?course=chinese`);
  assert.equal(denied.status, 403);

  const wrongPassword = await fetch(`${baseUrl}/api/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(wrongPassword.status, 401);

  const accepted = await fetch(`${baseUrl}/api/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.SITE_ACCESS_PASSWORD }),
  });
  assert.equal(accepted.status, 204);
  const setCookie = accepted.headers.get('set-cookie');
  assert.match(setCookie, /gaoyi_bridge_access=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Max-Age=2147483647/i);

  const token = decodeURIComponent(setCookie.split(';')[0].split('=')[1]);
  assert.match(token, /^v2\.access\.[A-Za-z0-9_-]+$/);

  const cookie = setCookie.split(';')[0];
  const session = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: cookie } });
  assert.deepEqual(await session.json(), { accessGranted: true });
});

test('each known course receives a signed URL for only its configured object', async () => {
  const cookie = await signIn();
  const expectedKeys = {
    chinese: 'Courses/chinese.mp4',
    math: 'Courses/math.mp4',
    english: 'Courses/english.mp4',
  };

  for (const [course, objectKey] of Object.entries(expectedKeys)) {
    const response = await fetch(`${baseUrl}/api/video-url?course=${course}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, course);
    const payload = await response.json();
    const signedUrl = new URL(payload.url);
    assert.equal(payload.course, course);
    assert.equal(signedUrl.hostname, 'test-account.r2.cloudflarestorage.com');
    assert.equal(signedUrl.pathname, `/gaoyi-summer-transition-2026/${objectKey}`);
    assert.ok(signedUrl.searchParams.get('X-Amz-Signature'));
    assert.equal(payload.expiresInSeconds, 3600);
  }

  const unknown = await fetch(`${baseUrl}/api/video-url?course=physics`, { headers: { Cookie: cookie } });
  assert.equal(unknown.status, 400);
});

test('logout invalidates the browser cookie', async () => {
  const cookie = await signIn();
  const response = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/i);
});

test('only the explicit public assets are served', async () => {
  const stylesheet = await fetch(`${baseUrl}/styles.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type'), /text\/css/);

  for (const pathname of ['/api/index.js', '/package.json', '/README.md', '/url.txt', '/26%E5%B1%8A%E5%8A%A0%E6%B2%B9%E8%A7%86%E9%A2%916.4(4).mp4']) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
  }
});

test('Vercel function assets use the current string glob schema', () => {
  const includeFiles = vercelConfig.functions['api/index.js'].includeFiles;
  assert.equal(typeof includeFiles, 'string');
  for (const file of ['index.html', 'styles.css', 'app.js', 'site-config.js']) {
    assert.match(includeFiles, new RegExp(file.replace('.', '\\.')));
  }
});
