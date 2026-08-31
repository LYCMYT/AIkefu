# AIkefu v1.0.0-demo

`v1.0.0-demo` 是 AIkefu 面向求职展示与外部技术审查的首个固定版本。它不是已接入真实电商平台的商业产品，也不承诺生产 SLA；所有店铺、买家、商品、订单、物流、图片和场景均为合成数据，电商侧只使用 `MockDouyinAdapter`。

## 本版可以展示什么

- 空运营 Workspace 建店、商品学习与 AI readiness：`PREPARING` 未完成前禁止自动发送，成功后才进入 `READY`。
- 多店铺消息工作台、买家模拟器、左右实时联调和独立 Scenario Lab。
- UserTurn 聚合、TaskBundle、动态商品/订单 Context、Knowledge Evidence、ReplyPolicy、SendGuard、SendOutbox 与 Receipt。
- AUTO / 人工接管 / 恢复、旧 Job 失效、动态事实失效、澄清、崩溃恢复和不确定发送处理。
- 版本化 Workflow、Human Approval、质量审核、Incident、Trace、数据保留与隐私删除。
- `/showcase` 的四条引导式演示链路，以及 8 个可重复 Scenario。

## 可复验证据

- Unit Test：647 / 647 通过。
- Integration Test：61 / 61 通过，包含真实 PostgreSQL、pgvector、Redis 与 MinIO。
- GitHub `main` CI：Checks 与 Real infrastructure and browser gate 均通过。
- Playwright：17 passed、4 个互斥离线降级用例按环境设计 skipped、0 failed。
- Container Images：API 与 Web 镜像构建并发布到 GHCR。
- 生产构建：Core、Contracts、MockDouyin、API 与 Web 全部通过。
- 三分钟视频：`aikefu-3min-demo.mp4`，180 秒，1440×900，H.264 + AAC 中文旁白。

## 快速体验

本地开发：

```powershell
pnpm install
Copy-Item .env.example .env
pnpm infra:up
pnpm db:deploy
pnpm dev
```

打开 `http://localhost:5173/showcase`，按页面引导运行四个场景。完整容器部署见 [`docs/DEPLOYMENT.md`](DEPLOYMENT.md)，公网前置检查见 [`docs/PUBLIC_DEMO_CHECKLIST.md`](PUBLIC_DEMO_CHECKLIST.md)。

## 安全与边界

- 默认使用离线确定性 AI provider；DeepSeek 是服务端可选能力，不进入前端 Bundle。
- 不包含真实抖音接口、Cookie、Token、会员账号或运营 KPI。
- 仓库与 Release 不包含 `.env`、API Key、数据库数据、MinIO 对象或录制原始文件。
- 公网 Demo 尚无 Workspace 级 Quota/Rate Limit；公开部署前必须增加访问限制，或保持离线 provider。
- GitHub Pages 不能运行本项目的 API、PostgreSQL、Redis 和 MinIO；完整体验需要容器主机。

## 镜像

Tag 发布后，GitHub Actions 会生成：

- `ghcr.io/lycmyt/aikefu/api:v1.0.0-demo`
- `ghcr.io/lycmyt/aikefu/web:v1.0.0-demo`

镜像只用于 Mock-only Demo。部署时仍需使用本仓库的 Compose、迁移、Secret、持久卷、TLS 和健康检查配置。
