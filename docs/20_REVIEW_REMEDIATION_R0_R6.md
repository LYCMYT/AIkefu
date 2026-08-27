# 外部代码审查整改矩阵（R0–R6）

日期：2026-08-27  
适用审查：`AI客服Demo_深度代码审查与后续路线_v1.md`、`Codex_代码审查整改提示词_R0-R6.md`

这两份文件是外部审查证据，不覆盖 `docs/16_DECISION_LOG.md` 的冻结决策。所有 PASS 均来自当前仓库和实际命令；没有凭据或基础设施时保留 BLOCKED / SKIP，不虚构结果。

## 审查问题复核

| 审查项 | 当前结论 | 证据 / 处置 |
| --- | --- | --- |
| P0-1 真实基础设施未验收 | 已完成（外部模型除外） | Docker PostgreSQL/pgvector、Redis/BullMQ、MinIO、18 migrations、48 real-infra integration 已实跑；外部模型凭据未提供。 |
| P0-2 公开 Demo 防滥用 | 冻结决策冲突 | `docs/16` 明确 V1 不实现 Workspace Quota / Rate Limit / 超额 Fallback。不擅自改需求；未有访问控制的公网部署仍禁止宣称完成。 |
| P0-3 Runtime 请求校验 | 已完成 | 全局 ValidationPipe、DTO 白名单/上限、Body limit、跨店边界测试。 |
| P0-4 仓库/交付卫生 | 已完成 | Secret scan、tracked-file 白名单源码归档、`.env`/依赖/构建产物拒绝规则。 |
| P0-5 CI / Release Gate | 本地与 CI 已完成；公网 Preview 未完成 | CI 现含 frozen install、Secret scan、Prisma、typecheck、unit、build、真实容器 integration 和连接态 Playwright。没有主机/域名不写“已上线”。 |
| P1-1 前端单体 | 部分完成，仍有渐进技术债 | React Router + TanStack Query 已接入；新增 `app/`、`features/`、`components/ui/`；Usage / Privacy 页已移出 `App.tsx`。Workbench / Buyer / Workflow 等大页尚需继续拆分。 |
| P1-2 后端 God Service | 部分缓解，保留技术债 | 已有独立 Runtime、Recovery、SendOutbox、Knowledge、Workflow、Retention 等服务；个别生产服务仍较大，本轮不做高风险全量重写。 |
| P1-3 多租户一致性 | 核心链路已有 DB + 应用双重约束 | Workspace/tenant/shop 全链路 scope、唯一索引、FK、real-infra 对抗测试已覆盖；不声称所有表均有复合 FK。 |
| P1-4 AI 错误重试过宽 | 已完成 | 仅网络/超时/408/429/选定 5xx 重试一次；400/401/403/无效响应 fail closed。 |
| P1-5 对象存储手写 SigV4 | 已完成 | 改用 AWS SDK v3，加 Abort/deadline，真实 MinIO 验收通过。 |
| P1-6 Workspace token 在 localStorage | 本地 Demo 保留，公网阻塞 | 严格 CSP / 安全头已实现。公网部署前应改成 HttpOnly + SameSite Cookie 或受控制的一次性会话机制。 |
| P1-7 Helmet / CSP | 已完成 | API 及 Nginx 响应头已实测。 |
| P1-8 E2E 不够真实 | 已完成当前 Mock V1 链路 | Reset→三条 Buyer 消息→Workbench Draft→人工接管→Human Final→Buyer 可见的连接态 Playwright 已通过；同时触发并修复 Reset 500 与刷新期静默丢发。 |

## R0–R6 状态

| Sprint | 状态 | 说明 |
| --- | --- | --- |
| R0 仓库与交付清理 | PASS | 可重复 Secret scan 与白名单归档均已落库。 |
| R1 真实基础设施 | PASS | 本机 Docker 真实通过；CI 也已新增非 skip 容器 Gate。 |
| R2 安全与 Runtime Validation | PASS with frozen exception | 请求/存储/响应头完成；Quota/Rate Limit 因冻结决策不实施。 |
| R3 真实全链路 E2E | PASS for Mock V1 | 真实 DB/Redis/MinIO/API/Web/WS/Mock sender 链路通过；不把真实电商平台列入范围。 |
| R4 真实模型与 Eval | CODE PASS / EXTERNAL BLOCKED | Provider 边界与账本完成；当前无 endpoint/key/model，因此真实 Intent/Reply/Embedding/Image/Judge 和 36 Eval 不得报 PASS。 |
| R5 前端模块化与视觉 | PARTIAL PASS | 路由/查询 provider、feature 目录、Loading/Error/Empty 组件和三尺寸快照完成；剩余 App/API/CSS 拆分是渐进技术债。 |
| R6 CI / 部署 / 交付 | LOCAL + CI PASS / PUBLIC BLOCKED | 本地生产 Compose 五容器全 healthy；GHCR workflow/部署文档/实基础 CI 完成。没有公网主机与域名，不写公开 Preview 已完成。 |

## 当前非伪造 Gate

- `pnpm typecheck`
- `pnpm test:unit`
- `RUN_REAL_INFRA_INTEGRATION=1 pnpm exec dotenv -e .env -- pnpm test:integration`
- `RUN_REAL_INFRA_E2E=1 pnpm test:e2e`
- `pnpm build`
- `pnpm security:secrets`
- `docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build --wait`

外部模型和公网部署仍需新的外部权限/资源；其余整改不得依赖真实平台 Cookie、Token、私有 API 或原产品代码。
