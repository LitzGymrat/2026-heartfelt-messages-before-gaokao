# 2026 新高一暑假衔接课

四科视频站点。前端负责课程选择和播放体验，Express/Vercel Function 负责服务端密码验证，并在验证成功后为对应课程生成短期 R2 签名地址。

## 保护边界

- 密码和 R2 凭据只存在于服务端环境变量中。
- 浏览器通过签名后的 `HttpOnly` Cookie 长期保持访问状态；服务端登录令牌不设到期时间。
- `/api/video-url?course=...` 只接受语文、数学、英语、物理四个课程标识。
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

四个视频使用 MP4 容器、H.264 视频、AAC 音频，并启用 faststart。视频只上传至私有 R2 桶，不提交到 Git，也不要开启该桶的公开 `r2.dev` 入口。

## 视频转换与上传

源视频放在 `初高衔接视频`，文件名分别为 `数学原视频.mp4`、`英语原视频.mp4` 和 `物理原视频.mp4`。运行：

```powershell
npm run media:prepare
```

脚本会保留原视频，并把可直接流式播放的成品生成到 `初高衔接视频/streaming-ready`：

- 已经是 H.264/AAC 的数学、英语只做无损重封装和 faststart；
- HEVC/H.265 的物理转为 H.264/AAC 并加入 faststart；
- 已有成品默认跳过；需要重新生成时使用 `powershell -File scripts/prepare-course-videos.ps1 -Force`。

要在转换后自动上传，先按 `.env.example` 在项目根目录 `.env` 或 `初高衔接视频/.env` 填写 R2 凭据，再运行：

```powershell
npm run media:publish
```

上传脚本只允许写入私有桶 `hyzxcgxj` 的 `Courses/math.mp4`、`Courses/english.mp4` 和 `Courses/physics.mp4`。它会跳过同尺寸的已有对象，对连接中断自动重试，并在每次上传后核对对象大小；不会改动或删除源视频。

## Vercel 部署

- Git 分支：`gaoyi-summer-transition`
- 新建独立 Vercel Project，将 Production Branch 指向本分支。
- 在 Production 环境配置 `.env.example` 中的 5 个必填变量。
- `R2_ACCOUNT_ID` 可以填写纯 Account ID，也兼容 Cloudflare 显示的完整 S3 API 地址。
- 新域名绑定到这个新 Project；旧 Project 和 `main` 不变。
- 环境变量变更后重新部署。

`vercel.json` 会把页面、静态资源和 API 请求统一交给 `api/index.js`，因此密码校验和静态文件白名单在本地与 Vercel 上保持一致。

服务端固定使用私有桶 `hyzxcgxj`，四个对象路径分别为 `Courses/chinese.mp4`、`Courses/math.mp4`、`Courses/english.mp4` 和 `Courses/physics.mp4`。R2 对象路径区分大小写。登录后无需定期重新输入密码；只有主动退出、清除浏览器数据或更换 `ACCESS_TOKEN_SECRET` 才会失效。临时视频地址由程序自动获取和更新，不需要环境变量或人工管理。
