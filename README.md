# 2026 新高一暑假衔接课

三科视频站点。前端负责课程选择和播放体验，Express/Vercel Function 负责服务端密码验证，并在验证成功后为对应课程生成短期 R2 签名地址。

## 保护边界

- 密码和 R2 凭据只存在于服务端环境变量中。
- 浏览器通过签名后的 `HttpOnly` Cookie 长期保持访问状态；服务端登录令牌不设到期时间。
- `/api/video-url?course=...` 只接受语文、数学、英语三个课程标识。
- 每次播放拿到的是默认有效期一小时的临时 R2 地址，足以覆盖约 40 分钟的课程。
- 服务端只公开四个前端文件，不会公开项目源码、本地视频、配置文件或 R2 凭据。

密码保护无法阻止已经通过验证的用户在签名地址有效期内转发地址，但能避免密码和永久视频直链出现在前端源码中。

## 本地运行

1. 运行 `npm install`。
2. 将 `.env.example` 复制为 `.env`。
3. 填写密码、签名密钥和三个 R2 凭据。
4. 运行 `npm start`，打开 `http://localhost:3000`。

签名密钥可用以下命令生成：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

三个视频建议使用 MP4 容器、H.264 视频、AAC 音频，并启用 faststart。视频只上传至私有 R2 桶，不提交到 Git，也不要开启该桶的公开 `r2.dev` 入口。

## Vercel 部署

- Git 分支：`gaoyi-summer-transition`
- 新建独立 Vercel Project，将 Production Branch 指向本分支。
- 在 Production 环境配置 `.env.example` 中的 5 个必填变量。
- 新域名绑定到这个新 Project；旧 Project 和 `main` 不变。
- 环境变量变更后重新部署。

`vercel.json` 会把页面、静态资源和 API 请求统一交给 `api/index.js`，因此密码校验和静态文件白名单在本地与 Vercel 上保持一致。

服务端固定使用私有桶 `gaoyi-summer-transition-2026`，三个对象路径分别为 `Courses/chinese.mp4`、`Courses/math.mp4` 和 `Courses/english.mp4`。R2 对象路径区分大小写。登录后无需定期重新输入密码；只有主动退出、清除浏览器数据或更换 `ACCESS_TOKEN_SECRET` 才会失效。临时视频地址由程序自动获取和更新，不需要环境变量或人工管理。
