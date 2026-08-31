# AIkefu v1.1.0-demo

`v1.1.0-demo` 是 AIkefu 的六场景求职展示版本。它是 Mock-only、Synthetic Data 演示，不是已接入真实电商平台的商业产品，也不承诺公网全栈地址、生产 SLA 或商业 KPI。所有店铺、买家、商品、订单、物流、图片和场景均为合成数据，电商侧只使用 `MockDouyinAdapter`。

## 本版可以展示什么

- 空运营 Workspace 建店、商品学习与 AI readiness；`PREPARING` 期间禁止自动发送，成功后才进入 `READY`。
- 多店铺工作台、买家模拟器、实时联调、AI 管理中心及独立 Scenario Lab。
- UserTurn 聚合、TaskBundle、动态商品/订单 Context、Knowledge Evidence、ReplyPolicy、SendGuard、SendOutbox 与 Receipt。
- AUTO、人工接管与恢复、旧 Job 失效、上下文失效、Workflow Human Approval、Incident 和脱敏 Trace。
- `/showcase` 的 SC01–SC06 六条真实引导链，以及 Scenario Lab 的 8 个可重复 Scenario。

## 可复验证据

- Unit Test：693 / 693 通过（含 25 项录制时间线、字幕、转场与过期产物防误用合同）。
- Integration Test：15 suites，63 / 63 tests 通过，包含真实 PostgreSQL、pgvector、Redis 与 MinIO。
- Playwright：共 27 个唯一用例；真实环境 23 passed、4 skipped、0 failed；离线模式 6 passed、21 skipped、0 failed。两种模式的 skip 来自互斥运行条件，不合并伪装成单次全通过。
- 生产构建、Prisma validate/generate/migration status 与 AppModule DI 已在本地发布 Gate 中通过。
- GitHub 自动化状态必须以 [Actions 页面](https://github.com/LYCMYT/AIkefu/actions)核验；本说明本身不是本 Tag 的 Actions 或 GHCR 运行结果。

## 三分钟演示

- [Release 页面](https://github.com/LYCMYT/AIkefu/releases/tag/v1.1.0-demo)
- [下载 `aikefu-3min-demo.mp4`](https://github.com/LYCMYT/AIkefu/releases/download/v1.1.0-demo/aikefu-3min-demo.mp4)
- 文件大小：13,831,390 bytes
- SHA256：`E64D832B7C67896424C13FAE785837545B89005BD172E500373CDD4E3564435C`
- 画面：180 秒，1920×1080，30 fps，H.264 High
- 音频：AAC LC，48 kHz 双声道；`zh-CN-XiaoxiaoNeural`，语速 `+50%`
- 字幕：26 条字幕 cue；画面硬字幕与外部 SRT 同源，MP4 无软字幕轨

## 快速体验

```powershell
pnpm install
Copy-Item .env.example .env
pnpm infra:up
pnpm db:deploy
pnpm dev
```

打开 `http://localhost:5173/showcase` 运行六个场景。本地地址只用于本机验收，不是公网 Demo URL。完整部署见 [`docs/DEPLOYMENT.md`](DEPLOYMENT.md)，公网前置检查见 [`docs/PUBLIC_DEMO_CHECKLIST.md`](PUBLIC_DEMO_CHECKLIST.md)。

## 安全与发布边界

- 默认使用离线确定性 AI provider；DeepSeek 是仅在服务端配置的可选能力。
- 不包含真实抖音接口、Cookie、Token、会员账号、客户数据或真实订单。
- GitHub Pages 不能运行 API、PostgreSQL、Redis 和 MinIO；完整体验需要容器主机。
- 项目没有公开的全栈在线体验地址；Release 视频是主要公开展示入口。
- GHCR 镜像是否生成、是否公开以及具体 digest，必须从 [Packages](https://github.com/LYCMYT?tab=packages)与对应 Actions 运行核验，本说明不替代运行记录。
