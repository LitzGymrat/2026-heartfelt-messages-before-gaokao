# 2026 新高一暑假衔接课

三科视频站点。前端负责课程选择和播放体验，Express/Vercel Function 负责服务端密码验证，并在验证成功后为对应课程生成短期 R2 签名地址。

## 保护边界

- 密码、R2 凭据、桶名和三个视频对象名称只存在于服务端环境变量中。
- 浏览器通过签名后的 `HttpOnly` Cookie 保持访问状态。
- `/api/video-url?course=...` 只接受语文、数学、英语三个课程标识。
- 每次播放拿到的是默认有效期一小时的临时 R2 地址，足以覆盖约 40 分钟的课程。
- 服务端只公开四个前端文件，不会公开项目源码、本地视频、配置文件或 R2 凭据。

密码保护无法阻止已经通过验证的用户在签名地址有效期内转发地址，但能避免密码和永久视频直链出现在前端源码中。

## 本地运行

1. 运行 `npm install`。
2. 将 `.env.example` 复制为 `.env`。
3. 填写密码、签名密钥、R2 凭据、私有桶名和三个视频对象名称。
4. 运行 `npm start`，打开 `http://localhost:3000`。

签名密钥可用以下命令生成：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

三个视频建议使用 MP4 容器、H.264 视频、AAC 音频，并启用 faststart。视频只上传至私有 R2 桶，不提交到 Git，也不要开启该桶的公开 `r2.dev` 入口。

## Vercel 部署

- Git 分支：`gaoyi-summer-transition`
- 新建独立 Vercel Project，将 Production Branch 指向本分支。
- 在 Production、Preview 和 Development 环境配置 `.env.example` 中的全部必填变量。
- 新域名绑定到这个新 Project；旧 Project 和 `main` 不变。
- 环境变量变更后重新部署。

`vercel.json` 会把页面、静态资源和 API 请求统一交给 `api/index.js`，因此密码校验和静态文件白名单在本地与 Vercel 上保持一致。
