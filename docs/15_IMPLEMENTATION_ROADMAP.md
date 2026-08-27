# Codex 实施路线

不要一次性实现所有模块。按阶段提交，每阶段必须有可运行纵向切片。

---

## Phase 01｜Foundation

### 目标

建立 Monorepo、数据基础、Workspace 隔离和 Seed。

### 工作

- pnpm workspace
- React Web
- NestJS API
- PostgreSQL / Redis / MinIO
- Prisma
- Workspace 自动创建
- demo token
- Reset
- 24h cleanup
- Seed
- REST bootstrap
- WebSocket Gateway
- 基础测试

### Gate

- 两个浏览器创建不同 Workspace
- 数据完全隔离
- Reset 不影响另一个 Workspace

---

## Phase 02｜Message Vertical Slice

### 目标

Buyer Simulator 发消息，Workbench 实时收到。

### 工作

- MockDouyinAdapter
- Message contract
- Deduplicate
- Reorder Buffer
- ProcessingOutbox
- Dispatcher
- TurnBuffer
- UserTurn
- Conversation
- WebSocket events
- Buyer Simulator
- Workbench message UI

### Gate

- 连续消息形成一 Turn
- 重复、乱序测试通过
- 服务重启 TurnBuffer 恢复

---

## Phase 03｜Products / Knowledge / RAG

### 目标

商品自动学习和问答导入可用。

### 工作

- Product / SKU
- ProductContext
- ProductLearningJob
- AI extraction
- contentHash
- Knowledge Version
- Index Status
- Embedding
- pgvector
- app-level BM25
- Hybrid fusion
- Excel / CSV import
- Candidate / Conflict
- Knowledge admin

### Gate

- STORE / PRODUCT 隔离
- v2 READY 后切换
- ProductKnowledge 与库存来源区分
- Case 01～03 通过

---

## Phase 04｜AI Conversation Runtime

### 目标

完成真实 AI 客服链路。

### 工作

- AI Provider Adapter
- Purpose routing
- Structured output schemas
- timeout / retry / fallback
- Conversation Summary
- Structured Facts
- Context Sanitizer
- Intent Planner
- TaskBundle
- Context Resolver
- Clarification
- Reply Policy
- Fast Path
- LLM Composer
- Streaming Preview
- AUTO / ASSIST / MANUAL
- Draft TTL
- AI Draft + Human Final

### Gate

- 多意图
- 多订单歧义
- 连续消息
- 新消息使旧 Job STALE
- Case 04、05、08、09 通过

---

## Phase 05｜Reliability

### 目标

补齐发送、恢复和状态一致性。

### 工作

- SendGuard
- SendOutbox
- idempotency
- contextVersion
- Reply Coalescing
- Abort / discard
- Recovery Worker
- Scheduled welcome / closing
- Connection checkpoint / reconciliation
- order / inventory mock events
- message recall / edit

### Gate

- SENDING 重启 → UNCERTAIN
- 订单 / 库存变化使旧 Job STALE
- 两店 / 两用户并发
- Case 06、07、10 通过

---

## Phase 06｜Workflow / Quality / Trace

### 目标

形成完整展示闭环。

### 工作

- visual workflow editor
- workflow version
- runtime
- human approval
- manual quality review
- reply incident
- correction
- regression eval
- developer trace
- AI usage
- admin dashboard

### Gate

- 商品推荐 Workflow
- Approval stale 校验
- Quality 手动运行
- Incident 可归因
- Trace 真实来自数据库

---

## Phase 07｜Scenario / Release

### 目标

完成求职交付。

### 工作

- 8 Scenario
- E2E
- Docker Compose
- seed reset
- deploy docs
- 3 分钟 Demo
- README
- screenshots
- known limitations

### Gate

`docs/13_TEST_ACCEPTANCE.md` 全通过。

---

## 实施原则

1. 每个 Phase 单独 Commit。
2. 每个状态机先写测试。
3. 不要先做漂亮 UI 再补业务。
4. 不要接真实平台。
5. 不要提前实现 P1。
6. 发现文档冲突先查 Decision Log。
7. 每阶段更新 `PROGRESS.md`。
