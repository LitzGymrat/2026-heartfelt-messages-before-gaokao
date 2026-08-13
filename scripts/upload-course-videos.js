'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HeadObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');

const bucket = 'hyzxcgxj';
const allowedCourses = new Set(['math', 'english', 'physics']);

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`缺少本地环境变量 ${name}。请先配置项目根目录下的 .env。`);
  return value;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value == null) throw new Error(`无效参数：${flag || ''}`);
    values[flag.slice(2)] = value;
  }

  const input = path.resolve(values.input || '');
  const envFile = path.resolve(values['env-file'] || '');
  const courses = String(values.courses || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!input || !envFile || !courses.length) throw new Error('必须提供 --input、--courses 和 --env-file。');
  for (const course of courses) {
    if (!allowedCourses.has(course)) throw new Error(`不允许上传未知课程：${course}`);
  }
  return { input, envFile, courses };
}

function createR2Client() {
  const accountIdOrEndpoint = requiredEnv('R2_ACCOUNT_ID');
  let endpoint = accountIdOrEndpoint;
  if (!/^https?:\/\//i.test(endpoint)) {
    endpoint = endpoint.includes('.r2.cloudflarestorage.com')
      ? `https://${endpoint}`
      : `https://${endpoint}.r2.cloudflarestorage.com`;
  }

  return new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
}

async function main() {
  const { input, envFile, courses } = parseArguments(process.argv.slice(2));
  const loaded = dotenv.config({ path: envFile, quiet: true });
  if (loaded.error) throw new Error(`无法读取 R2 配置：${envFile}`);
  const client = createR2Client();

  for (const course of courses) {
    const filePath = path.join(input, `${course}.mp4`);
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) throw new Error(`不是有效文件：${filePath}`);

    const key = `Courses/${course}.mp4`;
    try {
      const existing = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (Number(existing.ContentLength) === stats.size && existing.ContentType === 'video/mp4') {
        console.log(`[${course}] R2 已存在同尺寸成品，跳过：${bucket}/${key}`);
        continue;
      }
    } catch (error) {
      const status = Number(error?.$metadata?.httpStatusCode || 0);
      if (status && status !== 404) throw error;
    }

    const maximumAttempts = 4;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      console.log(`[${course}] 上传 ${filePath} -> ${bucket}/${key}（第 ${attempt}/${maximumAttempts} 次）`);
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: fs.createReadStream(filePath),
          ContentLength: stats.size,
          ContentType: 'video/mp4',
          CacheControl: 'private, no-store',
        }));
        break;
      } catch (error) {
        const status = Number(error?.$metadata?.httpStatusCode || 0);
        const retriable = !status || status === 408 || status === 429 || status >= 500;
        if (!retriable || attempt === maximumAttempts) throw error;
        const delayMs = 2000 * attempt;
        console.warn(`[${course}] 网络上传中断，${delayMs / 1000} 秒后重试。`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    const remote = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (Number(remote.ContentLength) !== stats.size) {
      throw new Error(`[${course}] 上传后大小不一致：本地 ${stats.size}，R2 ${remote.ContentLength}`);
    }
    console.log(`[${course}] R2 上传完成，${(stats.size / 1024 / 1024).toFixed(1)} MB`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
