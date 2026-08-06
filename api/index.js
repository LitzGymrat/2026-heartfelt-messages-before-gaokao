const crypto = require('node:crypto');
const path = require('node:path');
const { GetObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const express = require('express');
require('dotenv').config({ quiet: true });

const app = express();
const port = Number(process.env.PORT || 3000);
const projectRoot = path.join(__dirname, '..');
const accessCookieName = 'gaoyi_bridge_access';
const loginWindowMs = 15 * 60 * 1000;
const maxFailedLogins = 10;
const persistentCookieMaxAgeSeconds = 2147483647;
const videoUrlTtlSeconds = 60 * 60;
const r2BucketName = 'gaoyi-summer-transition-2026';
const failedLogins = new Map();
let r2Client;

const courseObjectKeys = Object.freeze({
  chinese: 'Courses/chinese.mp4',
  math: 'Courses/math.mp4',
  english: 'Courses/english.mp4',
});

const publicFiles = Object.freeze({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8', cache: 'public, max-age=300' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8', cache: 'public, max-age=300' },
  '/site-config.js': { file: 'site-config.js', type: 'application/javascript; charset=utf-8', cache: 'public, max-age=300' },
});

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '4kb', strict: true }));
app.use((_request, response, next) => {
  response.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' https: blob:; connect-src 'self' https:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  next();
});

function getRequiredConfig(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    const error = new Error(`Missing required environment variable: ${name}`);
    error.code = 'CONFIGURATION_ERROR';
    throw error;
  }
  return value;
}

function getAccessTokenSecret() {
  const secret = getRequiredConfig('ACCESS_TOKEN_SECRET');
  if (secret.length < 32) {
    const error = new Error('ACCESS_TOKEN_SECRET must contain at least 32 characters.');
    error.code = 'CONFIGURATION_ERROR';
    throw error;
  }
  return secret;
}

function getR2Client() {
  if (!r2Client) {
    const accountId = getRequiredConfig('R2_ACCOUNT_ID');
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: getRequiredConfig('R2_ACCESS_KEY_ID'),
        secretAccessKey: getRequiredConfig('R2_SECRET_ACCESS_KEY'),
      },
    });
  }
  return r2Client;
}

function safelyMatches(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function signAccessToken() {
  const payload = 'v2.access';
  const signature = crypto.createHmac('sha256', getAccessTokenSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyAccessToken(token) {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v2' || parts[1] !== 'access') return false;

  const payload = `${parts[0]}.${parts[1]}`;
  const expectedSignature = crypto.createHmac('sha256', getAccessTokenSecret()).update(payload).digest('base64url');
  return safelyMatches(parts[2], expectedSignature);
}

function parseCookies(request) {
  const cookies = {};
  for (const item of String(request.headers.cookie || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    try {
      cookies[name] = decodeURIComponent(item.slice(separator + 1).trim());
    } catch (_error) {
      cookies[name] = '';
    }
  }
  return cookies;
}

function hasAccess(request) {
  return verifyAccessToken(parseCookies(request)[accessCookieName]);
}

function isSecureRequest(request) {
  const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return request.secure || forwardedProtocol === 'https' || process.env.NODE_ENV === 'production';
}

function buildAccessCookie(request, token, maxAge) {
  const attributes = [
    `${accessCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(request)) attributes.push('Secure');
  return attributes.join('; ');
}

function getLoginRecord(request) {
  const key = request.ip || request.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const record = failedLogins.get(key);
  if (!record || now - record.startedAt >= loginWindowMs) {
    if (failedLogins.size > 5000) failedLogins.clear();
    const nextRecord = { count: 0, startedAt: now };
    failedLogins.set(key, nextRecord);
    return { key, record: nextRecord };
  }
  return { key, record };
}

function requireAccess(request, response, next) {
  try {
    if (!hasAccess(request)) {
      response.status(403).json({ error: '请先输入访问密码。' });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

app.get('/health', (_request, response) => {
  response.json({ ok: true });
});

app.get('/api/session', (request, response, next) => {
  try {
    response.set('Cache-Control', 'no-store');
    response.json({ accessGranted: hasAccess(request) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/access', (request, response, next) => {
  try {
    const { key, record } = getLoginRecord(request);
    if (record.count >= maxFailedLogins) {
      response.set('Retry-After', String(Math.ceil((loginWindowMs - (Date.now() - record.startedAt)) / 1000)));
      response.status(429).json({ error: '尝试次数过多，请稍后再试。' });
      return;
    }

    const suppliedPassword = String(request.body?.password || '');
    const configuredPassword = getRequiredConfig('SITE_ACCESS_PASSWORD');
    if (!safelyMatches(suppliedPassword, configuredPassword)) {
      record.count += 1;
      response.status(401).json({ error: '密码不正确，请重新输入。' });
      return;
    }

    failedLogins.delete(key);
    const token = signAccessToken();
    response.set('Cache-Control', 'no-store');
    response.set('Set-Cookie', buildAccessCookie(request, token, persistentCookieMaxAgeSeconds));
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.set('Set-Cookie', buildAccessCookie(request, '', 0));
  response.status(204).end();
});

app.get('/api/video-url', requireAccess, async (request, response, next) => {
  try {
    const courseId = String(request.query.course || '').trim();
    const objectKey = courseObjectKeys[courseId];
    if (!objectKey) {
      response.status(400).json({ error: '未知课程。' });
      return;
    }

    const command = new GetObjectCommand({
      Bucket: r2BucketName,
      Key: objectKey,
      ResponseContentType: 'video/mp4',
    });
    const videoUrl = await getSignedUrl(getR2Client(), command, { expiresIn: videoUrlTtlSeconds });
    response.set('Cache-Control', 'no-store');
    response.json({ course: courseId, url: videoUrl, expiresInSeconds: videoUrlTtlSeconds });
  } catch (error) {
    next(error);
  }
});

for (const [route, definition] of Object.entries(publicFiles)) {
  app.get(route, (_request, response) => {
    response.set('Cache-Control', definition.cache);
    response.type(definition.type);
    response.sendFile(path.join(projectRoot, definition.file));
  });
}

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'Not found' });
});

app.use((_request, response) => {
  response.status(404).send('Not found');
});

app.use((error, _request, response, _next) => {
  if (error?.code === 'CONFIGURATION_ERROR') {
    console.error(error.message);
    response.status(503).json({ error: '服务器尚未完成配置。' });
    return;
  }
  console.error(error);
  response.status(500).json({ error: '服务器内部错误。' });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

module.exports = app;
