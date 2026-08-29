# 开发进度

## Phase 01｜基础工程与多租户骨架
- [x] Monorepo 初始化（React/Vite、NestJS、contracts、core、mock-douyin）
- [x] PostgreSQL / Redis / MinIO Docker Compose 与 PostgreSQL extension 初始化
- [x] Workspace 自动创建、Reset、24h 无访问过期清理
- [x] Seed 数据导入（2 店 / 4 Buyer / 10 Product / 10 Order / 80 Knowledge / 2 Workflow）
- [x] 基础 REST / WebSocket（Workspace 鉴权、定时复核、心跳）
- [x] Workspace / Tenant / Shop 隔离测试

### Phase 01 验证记录（2026-08-26）

- 状态：实现完成并通过当前环境 Gate；已按用户持续执行指令进入后续阶段。
- `pnpm typecheck`：通过。
- `pnpm test:unit`：2 suites / 3 tests 通过。
- `pnpm test:integration`：2 suites / 7 tests 通过。
- `pnpm build`：API、Web、contracts、core、mock-douyin 全部通过。
- `prisma validate`：通过；Migration 为 `20260826120000_phase_01_foundation`。
- 覆盖：A/B Workspace 隔离、Reset A 不影响 B、无 token 拒绝、伪造 shopId 拒绝、Seed 重复 Reset 幂等、过期清理、WS 鉴权/心跳/过期断开。

### Phase 01 已知问题 / 风险

- 2026-08-27 重启后 Docker Desktop Linux engine 已正常运行；PostgreSQL / pgvector、Redis、MinIO 三个 Compose 服务均为 healthy，18 个 Prisma migration 已实际 deploy，Workspace 隔离/Reset/过期清理已在真实 PostgreSQL integration 中复验。
- Redis 与 MinIO 在本阶段只完成基础设施定义；队列和附件业务按冻结路线留到后续 Phase。
- 当前交接目录不是 Git repository，因此没有创建 Phase 01 commit。
- 未接入任何真实电商平台私有接口、Cookie、Token、真实账号或原产品代码；`MockDouyin` 仅包含无凭据 capability descriptor，消息能力留到 Phase 02。

## Phase 02｜消息管线与客服工作台
- [x] MockDouyinAdapter
- [x] Message Normalize / Deduplicate
- [x] 1 秒 Reorder Buffer
- [x] Persistent TurnBuffer（2 秒 / 5 秒）
- [x] Buyer Simulator
- [x] Workbench 实时消息
- [x] Conversation / Message 状态

### Phase 02 验证记录（2026-08-27）

- 状态：代码与当前可运行 Gate 完成；已自动进入 Phase 03。
- `pnpm typecheck`：5 个工作区包全部通过。
- `pnpm test:unit`：17 tests 通过（Core 10、MockDouyin 3、Web 3、API 1）。
- `pnpm test:integration`：3 suites / 15 tests 通过。
- `pnpm build`：API、Web、contracts、core、mock-douyin 全部通过。
- `prisma validate` / `prisma generate`：通过；Migration 为 `20260827120000_phase_02_message_workbench`，已与 Phase 01 → 当前 Schema 的 diff 复核一致。
- 浏览器验收：`/workbench` 桌面与 390×844 窄屏、`/buyer-simulator` 390×844 窄屏均完成加载、错误态和横向溢出检查；无 API 时显示可恢复错误态。
- 覆盖：Message 去重与有序提交、1 秒缺口降级与一次 Reconcile、2 秒/5 秒 TurnBuffer、重启恢复、迟到消息独立 Turn、编辑/撤回上下文失效、商品/订单卡上下文回退、Workspace/店铺/Buyer 隔离、REST 快照与 Workspace-scoped WS、Mock Adapter 凭据拒绝。

### Phase 02 已知问题 / 环境复验项

- Docker/Redis/BullMQ 已在真实连接态运行；Outbox、Receipt、`DISPATCHING` 回收、TurnBuffer 与 ReplyJob 消费均通过真实基础设施 integration。无 Redis 时仍保留同进程调度降级。
- 未接入任何真实电商平台私有接口、Cookie、Token、真实账号或原产品代码；所有消息和卡片事件均由合成 `MockDouyinAdapter` 产生。

## Phase 03｜知识、商品学习与 AI
- [x] 商品同步和 ProductContext
- [x] ProductLearningJob
- [x] Excel / CSV 知识导入
- [x] Knowledge Version / Index Status
- [x] Hybrid RAG
- [x] AI Runtime 与 Structured Output
- [x] Conversation Memory / Summary / Facts
- [x] Attachment 生命周期、合成识图与 Context Sanitizer
- [x] KnowledgeCandidate / KnowledgeConflict 显式治理
- [x] 独立审查 Hardening：最终只读复审 PASS，无可复现 P0 / P1

### Phase 03 验证记录（2026-08-27）

- 状态：实现、全仓 Gate 与 Terra max 独立只读复审全部通过；已自动进入 Phase 04。
- `pnpm typecheck`：5 个工作区包全部通过。
- `pnpm test:unit`：187 tests 通过（Core 31、MockDouyin 3、Web 8、API 145）。
- `pnpm test:integration`：5 suites / 17 tests 通过；另 1 suite / 3 个真实基础设施测试按显式环境开关跳过。
- `pnpm build`：API、Web、contracts、core、mock-douyin 全部通过。
- `prisma validate` / `prisma generate`：通过；Migration 为 `20260828120000_phase_03_knowledge_ai` 与 `20260828130000_phase_03_attachment_intent`，包含 pgvector `vector(1536)` + HNSW/trigram、Candidate / Conflict、ConversationMemory、Attachment durable intent、AIInvocation / AIUsage / AIInvocationEvidence。
- OpenAPI / WebSocket 契约：59 paths / 52 schemas / 135 refs / 0 missing；23 events / 3 typed bindings。
- Phase 03 Eval：冻结 Case 01 / 02 / 03 / 20 / 21 的确定性断言 5/5 通过。
- 浏览器验收：使用合成 QA API 检查 `/admin/products`、`/admin/knowledge` 完整数据态及知识导入对话框；桌面和 390×844 窄屏均无页面级横向溢出。无 API 时两页均显示可恢复 Foundation 错误态。
- 覆盖：Workspace / Tenant / Shop / Product 硬过滤、CSV / XLSX 预览与逐行独立事务、Import / ProductLearning 租约和崩溃恢复、READY 原子版本切换、软删除、TopK ≤ 3、BM25 + pgvector 融合、动态库存/价格/订单/物流/预售承诺在 Import / RAG / ProductLearning 三入口禁入、持久化 Evidence、Candidate / Conflict 显式治理与历史版本 winner 防护、ConversationMemory late/edit/recall 同事务 DIRTY + DB 扫描/CAS 重建、附件 durable intent / 会话 CAS / 解码与 15 天清理 / PII 清洗、图片默认本地分析且仅服务端精确 opt-in 可外发、Knowledge/Product/Usage WS 事件。

### Phase 03 已知问题 / 环境复验项

- Phase 03 Migration、pgvector/HNSW、PostgreSQL-backed 检索、MinIO 上传/签名下载/删除与 Redis 队列已在本机真实基础设施中复验通过；浏览器也已连接同一真实 Workspace API。
- AI Runtime 与 Embedding 均提供显式服务器端 Provider 边界，并以确定性离线 Provider 做无凭据回退；已验证超时、重试、fallback、结构化修复、失败关闭、熔断、PII/Secret 清洗及 Invocation/Usage/Evidence 持久化。新增可审查的版本化 Prompt Registry、DeepSeek / OpenAI-compatible Chat / Responses 适配器与 `AI_API_KEY_FILE`；36 Case 已真实执行，但真实 DeepSeek Provider-only 报告仅 3/36 PASS，不能作为产品回复质量 PASS。
- 未接入任何真实电商平台私有接口、Cookie、Token、真实账号或原产品代码；商品、知识、图片与 Eval 数据全部为合成数据。
- 独立审查登记 3 项非阻断 P2：pgvector SQL 前推 ENABLED / activeVersion 过滤、XLSX 解压炸弹资源限制、Memory DIRTY 扫描 lease / backoff / 稳定排序；不阻断 Phase 04，将在后续可靠性/发布硬化中处理。

## Phase 04｜人机协同与可靠性
- [x] Context Resolver（Card / 明确文本优先、动态 Product/SKU/Order、持久化两轮 ClarificationBundle）
- [x] TaskBundle（最多 4 Task、READ 并行、Partial / Blocking / Coalescing）
- [x] AUTO / ASSIST / MANUAL（Shop ceiling、override、DEGRADED、humanActive、风险只能收紧）
- [x] AI Draft + Human Final（5 分钟 TTL、Edit Type、Receipt 后可见投影）
- [x] CustomerMemory 人工维护（Workspace / Tenant / Shop / Buyer scope、PII/动态事实禁入、过期过滤）
- [x] KnowledgeCandidate（人工事实纠正与 Human Final 同一 durable boundary）
- [x] SendGuard（message / sequence / contextVersion / humanActive / mode / forbidden term / idempotency）
- [x] ProcessingOutbox / SendOutbox（Receipt、CANCELLED、SENT、UNCERTAIN、重复防护）
- [x] Recovery Worker（ReplyJob、SendOutbox、TurnBuffer、ProcessingOutbox、Receipt projection）
- [x] Scheduled welcome / closing message（尾游标、BUYER-only Turn、恢复与取消）

### Phase 04 验证记录（2026-08-27）

- 状态：实现、当前环境全仓 Gate 与 Terra max 独立只读复审全部通过；P0 / P1 为 0，已自动进入 Phase 05。
- `pnpm typecheck`：5 个工作区包全部通过。
- `pnpm test:unit`：309 tests 通过（Core 51、MockDouyin 3、Web 23、API 232）。
- `pnpm test:integration`：6 suites / 32 tests 通过；另 2 suites / 7 个真实基础设施测试按显式环境开关跳过。
- `pnpm build`：API、Web、contracts、core、mock-douyin 全部通过。
- `prisma validate` / `prisma generate`：通过；新增 Phase 04 migrations：Reply reliability、Draft、SendOutbox、CustomerMemory、clarification rounds、transport fence。
- Case 04～10 production-service reliability harness：15/15 通过。覆盖三消息单 Turn/单 Job、生成中补消息与偏远地区知识、双 Buyer 并行、双店 Evidence 隔离、多订单两轮澄清后转人工、ASSIST/Human Final/Candidate/takeover/resume、GENERATING 恢复与 SENDING→UNCERTAIN 无重发。
- AppModule：真实 `tsc` CJS 构建产物 DI compile 通过；MessageApplication、SendOutbox、Control、Runtime、Invalidation 共用同一 `ConversationTransportMutex` singleton。
- 覆盖：动态库存/订单事实不走 RAG、实体选择与更新互斥、失效后幂等 replan、AUTO READY + SendOutbox 原子提交、旧 Job 关联 AI Outbox 取消/纵深校验、Mock transport 与上下文 writer 线性化、AI 回执投影为 `ASSISTANT`。

### Phase 04 已知问题 / 环境复验项

- 当前 V1 的 transport mutex 是单 API 进程内互斥；多 API 副本部署前需增加 DB / Redis fencing token 或平台幂等协议。当前冻结范围不声称多实例生产级线性化。
- ProcessingOutbox / Scheduled Message 的 `DISPATCHING` 回收阈值为 1 秒，健康慢 worker 可能被重复投递；下游 receipt / idempotency 阻止重复效果。后续可升级 lease heartbeat 或更长 TTL。
- CustomerMemory disable 的 `{id,status}` 回执已在 Phase 05 统一为显式 contract union，Web 按旧实体合并状态；Phase 04 登记的 DTO P2 已关闭。
- `phase04.real-infra.integration-spec.ts` 已在真实 PostgreSQL / Redis 环境运行通过。外部模型凭据仍未配置，默认使用确定性离线 Provider；这不阻塞本地 V1 Demo。
- 未接入任何真实电商平台私有接口、Cookie、Token、真实账号或原产品代码；所有 transport、库存、订单、Buyer、知识与图片均为合成 Mock 数据。

## Phase 05｜Workflow、质量与展示
- [x] Workflow Engine
- [x] Human Approval
- [x] Manual Quality Review
- [x] Reply Incident / Regression Eval
- [x] Developer Trace
- [x] Scenario Lab 8 场景
- [x] 数据看板 / AI Usage
- [x] 10 个 Demo Case 当前环境生产服务链门禁通过

### Phase 05 验证记录（2026-08-27）

- 状态：Phase 05 V1 实现与当前环境 Gate 完成；未扩大真实平台、多人客服、生产 SLA 等冻结外范围。
- `pnpm typecheck`：5 个工作区包全部通过。
- `pnpm test:unit`：432 tests 通过（Contracts 6、Core 55、MockDouyin 3、Web 56、API 312）。
- `pnpm test:integration`：11 suites / 45 tests 全部通过，包含真实 PostgreSQL / pgvector / Redis / MinIO / BullMQ opt-in suites。
- `RUN_REAL_INFRA_E2E=1 pnpm test:e2e`：真实连接态 3/3 通过；4 条离线 Foundation 降级专用用例按互斥环境设计跳过。
- `pnpm build`：API、Web、contracts、core、mock-douyin 全部通过；构建后 `AppModule` Nest DI compile 通过。
- `prisma validate` / `prisma generate`：通过；Phase 05 迁移覆盖 Workflow / Proposal / Quality / Incident / Eval / Correction Receipt / Retention Privacy。
- Workflow：8 节点图验证、不可变发布版本、Router、TaskResult→唯一 Composer、Approval/Proposal、Recovery、canonical WS 事件与可视化编辑器已闭环。
- 质量/事故/Trace：Manual Quality Review、AI Judge fail-closed、Incident 修正回执、36 个固定 Eval Case、MESSAGE / USER_TURN / SEND_GUARD / SEND_RECEIPT 四链 Trace 聚合与递归脱敏已完成。
- Scenario / Demo Cases：Case 01～10 的当前环境生产服务 harness 通过。Case 07 两店并发真实走 `ReplyRuntimeService → KnowledgeService → ReplyEvidence → TraceService`，KnowledgeItem / Version / Evidence / Trace 无跨店引用。
- 展示/隐私：`/admin` 真实 Workspace 概览、`/admin/shops`、`/admin/privacy`、15/45/90 天保留策略与 Workspace-scoped Delete Customer Data 已完成；无数据时不伪造 KPI。

### Phase 05 已知环境复验项

- Docker / WSL2 环境已打通，PostgreSQL / pgvector、Redis、MinIO、BullMQ、全部 migration、45 个 integration 与真实连接态浏览器 E2E 均已实际运行通过。
- 默认仍可使用离线/本地 Provider；本机已配置仓库外 Key 文件驱动的 DeepSeek Chat，Embedding 与图片仍使用本地 Provider。外部模型是可选扩展，不属于默认本地 V1 Demo 的完成前提。
- V1 transport mutex 仍是单 API 进程互斥；多副本部署需 DB / Redis fencing token 或平台幂等协议。
- 未接入真实电商平台私有 API、Cookie、Token、真实账号或原产品代码；所有平台事件与数据均为合成 Mock。
- 已新增单机生产风格 `docker-compose.prod.yml`、API/Web Dockerfile、Nginx 同源 `/api`/`/ws` 反代、Secret 模板与 GitHub Actions/GHCR 流程；不把公网主机尚未选定误报为已在线部署。
- Release Hygiene 已新增跨平台 tracked-file Secret 扫描与 `git archive` 白名单源码包脚本；CI 在 frozen install 前后执行可重复门禁，归档拒绝 `.env`、依赖、构建产物、测试报告与内部参考材料。
- 公开边界硬化已完成：Nest 全局 `ValidationPipe` 对全部 Body DTO 启用 transform/whitelist/forbidNonWhitelisted；文本、JSON、Knowledge topK、Workflow 图与普通请求体均有上限；环境变量启动时 fail-closed；API Helmet/安全响应头生效。
- 附件对象存储已由手写 SigV4 改为官方 AWS SDK v3，并为 PUT/DELETE/CreateBucket 增加强制 Abort/deadline；真实 MinIO opt-in integration 随全套 47/47 通过。
- AI Gateway 已按错误类型做有界重试：网络、超时、408、429 与选定 5xx 最多重试一次；400、401、403 与无效响应不重试。`AiRuntime` 内存 Usage 视图默认仅保留最近 1,000 条，持久化 Invocation / Usage 账本仍是事实源。
- DeepSeek Chat endpoint / 模型 / 服务端 Key 文件已经配置；结构化风险分类探针及合成 Buyer→Intent/Risk/Reply→Workbench Draft→Human Final 的连接态浏览器链均通过。36 个固定 Case 已生成离线与真实 Provider 报告；真实报告为 3/36，且 Provider-only runner 不含生产 DB Evidence，禁止把它表述为端到端准确率。Judge、外部 Embedding / Image 仍是复验项。
- `docs/16` 冻结的“公开 Demo 不做 Workspace Quota / Rate Limit / 超额 Fallback”保持不变并继续作为已知费用风险；未用外部审查建议擅自覆盖冻结决策。

## Release
- [x] Docker Compose 一键启动
- [x] README 启动说明
- [x] 当前环境自动测试通过
- [ ] 在线部署
- [ ] 3 分钟演示脚本验证

### Release 环境验证记录（2026-08-27）

- Docker Desktop 29.7.2 / WSL2 已运行，Compose 中 PostgreSQL、Redis、MinIO 均为 `healthy`。
- 18 个 Prisma migrations 已真实部署；`prisma generate`、`prisma validate`、全仓 build 与 typecheck 通过。
- 最新回归：482 unit、51 real-infra integration、7 条连接态 Playwright E2E 通过。4 条离线降级用例按互斥环境条件跳过，不计为 PASS。
- 应用已常驻启动：Web `http://localhost:5173`、API `http://localhost:3000`；应用内浏览器确认 `API READY · 实时已连接`。
- Scenario Lab 八个固定合成场景已从真实浏览器界面逐一运行并全部 `SUCCEEDED`。
- 独立生产验证项目的 Web/API/PostgreSQL/pgvector/Redis/MinIO 5 容器全部 `healthy`；18 migrations、`/healthz`、SPA fallback、同源 REST Workspace 创建、Socket.IO heartbeat、Redis 密码与 Nginx 安全响应头实测通过。验证容器/网络/卷已定向清理，本地开发栈保留。
- 当前总进度：44 / 46（95.7%）。剩余在线部署与完整 3 分钟人工走台；均不扩大 V1，也不接真实电商私有接口。

## 前端产品化重构（2026-08-28）

- [x] Phase 1：AppShell、冻结四入口导航、店铺切换、桌面 / 移动响应式骨架。
- [x] Phase 2：Workbench 三栏工作台、会话筛选、Trace Drawer、CustomerMemory 与危险操作确认。
- [x] Phase 3：Buyer Simulator 真实消息 / 卡片 / 编辑 / 撤回链路与手机形态。
- [x] Phase 4：Dashboard、Shop、Product Learning、Knowledge、Quality、Incident、Usage、Privacy 产品化页面。
- [x] Phase 5：Workflow 三栏编辑器、缩放 / 自动排布、发布与 Proposal 二次确认。
- [x] Phase 6：Scenario Lab 八场景列表 / 详情 / Timeline、空态 / 错误态 / 窄屏与无横向溢出。
- [x] Phase 7：`App.tsx` / `api.ts` facade、feature / API / CSS 模块拆分、真实连接态验收与指定截图。

### 前端重构验证记录

- 本轮前端 `pnpm --filter @ai-customer-service/web typecheck` 与生产构建通过。
- 本轮 Web unit：16 files / 75 tests 全部通过。
- `RUN_REAL_INFRA_INTEGRATION=1 pnpm test:integration`：13 suites / 51 tests 全部通过。
- `pnpm build`：API、Web、contracts、core、mock-douyin 全部通过。
- Playwright 真实连接态：7 pass；4 条离线 Foundation 故障态用例按 opt-in 规则显式跳过。
- 真实产品化链：Reset → Buyer 三连发 → Workbench Draft → Dashboard / Knowledge → Workflow 保存并发布 → Scenario Run → 390px Workbench，全程通过。
- 最终截图：`artifacts/ui/final/`，包含最新 Workbench、Buyer Simulator、Knowledge、Workflow、Dashboard、Scenario Lab，以及 Shops / Quality / Incident / Trace / 390×844、1366×768、1920×1080 补充图。
- `App.tsx`、`api.ts` 与根 `styles.css` 已保持 facade；Workbench、Knowledge 与领域 CSS 仍有进一步细拆空间，不把“文件小于 600 行”作为已完成事实。

## 外部深度审查整改（R0–R6）

- [x] R0：Secret scan、tracked-file 白名单源码归档、交付忽略规则。
- [x] R1：Docker PostgreSQL/pgvector、Redis/BullMQ、MinIO、18 migrations 与 48 条 real-infra integration 真实验收。
- [x] R2：全局 Runtime DTO 校验、Helmet/CSP、Body limit、环境 fail-closed、AWS SDK v3 + Abort。Quota / Rate Limit 按 `docs/16` 冻结决策不实施。
- [x] R3：连接态 Reset→Buyer 三连发→Workbench Draft→人工接管→Human Final→Buyer 可见 E2E。同时修复 Reset 500 与 WebSocket 刷新期静默丢发。
- [x] R4 代码 Gate：模型错误分类、有界重试、RUNNING 账本、最近 1,000 条内存 Usage。
- [x] R4 外部 Chat Gate：DeepSeek `deepseek-v4-flash` 风险探针与 Intent/Risk/Reply 合成浏览器主链通过，Key 仅从仓库外文件读取。
- [ ] R4 完整 Eval Gate：36 Case 的离线 / DeepSeek Provider-only 报告已执行（真实 3/36）；生产 ReplyRuntime + DB Evidence 的 36 Case runner、Judge、外部 Embedding 与 Image 尚未完成，不虚构成本或准确率。
- [x] R5 安全拆分基线：React Router、TanStack Query、`app/`、`features/`、`components/ui/`，Usage / Privacy 移出 `App.tsx`；三尺寸快照已视觉复核。
- [x] R5 产品化拆分：Workbench / Buyer / Workflow、`api.ts` 与 `styles.css` 已按 feature / client / normalizer / endpoint / style domain 拆分，并由 69 条 Web unit 与真实连接态 E2E 回归。
- [x] R6 本地/CI/容器交付：CI 现实跑非 skip 基础设施 integration 与连接态 Playwright；生产风格五容器验收通过。
- [ ] R6 外部发布：没有公网主机/域名/TLS，因此不宣称 Preview 已上线。

详细“已做 / 部分做 / 未做”证据见 `docs/20_REVIEW_REMEDIATION_R0_R6.md`。

## 本轮发布文档收口（2026-08-29）

- [x] Workspace 会话分离：运营工作台创建与 Reset 使用 `EMPTY`，Scenario Lab 创建与 Reset 使用 `SEEDED`；两者使用独立的本地 token key：`aikefu_operational_workspace_token_v2`、`aikefu_scenario_workspace_token`，不会读取、覆盖或清除旧共享 key。
- [x] 空店主链：`/workbench` 空态 → 服饰/数码 MockDouyin 模板建店 → 自动商品学习 `PREPARING` → 成功后 `READY`。`PREPARING`、`DEGRADED`、`FAILED` 均不作为自动发送许可。
- [x] 店铺级二元 AI 开关：`ON = AUTO_ALLOWED`，`OFF = MANUAL_ONLY`。关闭期间的买家消息保留给人工处理，不生成伪装为人工的 AI Job；durable receipt 阻止之后重新开启 AI 时复活该期间工作。
- [x] 店铺级真实页面和路由：`/workbench/shops/:shopId`、`/workbench/shops/:shopId/settings`、`/workbench/shops/:shopId/knowledge/import`、`/live-test/:shopId`。设置页读写当前店铺策略；导入页走服务端 CSV/XLSX 预览、行级校验与提交。

### 当前后端 Gate

- [x] API unit：64 suites / 359 tests 通过。
- [x] Web unit：23 files / 100 tests 通过。
- [x] API integration：13 suites / 55 tests 通过，基于本地真实 PostgreSQL、Redis、MinIO、pgvector。
- [x] Contracts：6 / 6 通过。
- [x] 真实基础设施测试已在本机 opt-in 环境通过；这不是公网部署，也不代表真实平台凭据已接入。

### 前端终态 Gate

- [x] Playwright 13 项：9 passed、4 个互斥离线降级用例按环境设计 skipped、0 failed；console error/warn/pageerror、404、全局 overflow 均为 0。
- [x] 1440×900 最新真实截图已覆盖空店首页、店铺概览、店铺聊天、基础设置、知识导入、AI 管理中心、Workflow、Buyer Simulator、实时联调和 Scenario Lab；Workflow 保持运营 Workspace 真实空态，没有为截图制造数据。

### 仍未完成（不得记为通过）
- [ ] 在线部署 / 公网 Preview：尚未部署。
- [ ] 3 分钟演示视频：仓库保留人工脚本，但未录制或验收视频。
- [ ] 真实外部凭据：不随本次交付提供或验证；真实电商平台凭据仍不在 V1 范围，模型凭据仅为服务端可选配置。

以上状态为本轮最新发布记录，优先于本文中带日期的历史 Gate 计数。
