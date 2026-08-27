# 测试计划与 V1 验收标准

## 1. 原则

- 凡是简历准备重点讲的机制，至少有一个自动测试。
- UI 通过不代表业务通过。
- 外部平台允许 Mock，核心状态机和数据链路不允许假实现。
- 测试数据全部合成。
- 测试必须覆盖正常、异常、并发、恢复、隔离和幂等。

---

## 2. 测试层级

### 2.1 Unit

覆盖：

- Policy
- State Machine
- Resolver
- TurnBuffer deadline
- Reorder Buffer
- BM25 / Hybrid fusion
- Context Sanitizer
- SendGuard
- idempotency
- Workflow validation
- Structured Output validation

### 2.2 Integration

覆盖：

- PostgreSQL transaction
- ProcessingOutbox → BullMQ
- Message → Turn → ReplyJob
- Knowledge version → index
- Recovery Worker
- WebSocket event
- MinIO attachment
- MockDouyinAdapter

### 2.3 E2E

覆盖四个入口：

- Buyer Simulator
- Workbench
- Admin
- Scenario Lab

---

## 3. 必须自动测试的机制

### Workspace / 隔离

- [ ] Workspace A 看不到 Workspace B
- [ ] Shop A 知识不能被 Shop B 检索
- [ ] 相同 buyerId 跨店不共享会话与记忆
- [ ] Reset 只影响当前 Workspace

### Message

- [ ] externalMessageId 重复只保存一次
- [ ] sequence 乱序可重排
- [ ] Gap 无法补齐后 Conversation DEGRADED
- [ ] 迟到消息触发 contextVersion 与 Summary DIRTY
- [ ] recall / edit 使旧 Job STALE

### TurnBuffer

- [ ] 2 秒空闲 flush
- [ ] 新消息重置 idle
- [ ] 5 秒 hard max
- [ ] generation 使旧 delayed job 失效
- [ ] 服务重启后恢复
- [ ] 重复 flush 不创建重复 UserTurn

### Conversation / Reply

- [ ] 同 Conversation 只有一个 ACTIVE ReplyJob
- [ ] 不同 Conversation 可并行
- [ ] 新 Turn 使旧 Job STALE
- [ ] needsReplan 只创建一个新 Job
- [ ] SUPERSEDED Task 不再回答
- [ ] Draft 5 分钟 EXPIRED
- [ ] MANUAL 后 AI 不自动发送

### Context

- [ ] 商品卡唯一绑定商品
- [ ] 订单卡唯一绑定订单
- [ ] 多订单进入 AMBIGUOUS
- [ ] 2 轮澄清后转人工
- [ ] 库存变化导致 contextVersion
- [ ] 订单变化导致 contextVersion

### Knowledge

- [ ] STORE / PRODUCT metadata filter
- [ ] ENABLED + READY 才检索
- [ ] 新版本 READY 前旧版本继续服务
- [ ] 新版本 FAILED 不切 active
- [ ] Soft Delete 不参与 RAG
- [ ] ReplyEvidence 保留旧版本 Snapshot
- [ ] MANUAL > HUMAN_REVIEWED > AUTO_LEARNED
- [ ] 人工知识冲突阻止 AUTO

### AI

- [ ] Structured Output 校验失败 Repair 一次
- [ ] 第二次失败 Fail Closed
- [ ] timeout 重试一次
- [ ] fallback 记录
- [ ] stale request 支持 Abort / discard
- [ ] Fast Path 不调用 Reply Model
- [ ] Purpose Routing 正确

### Send / Outbox

- [ ] 相同 idempotencyKey 不重复发送
- [ ] lastMessageId mismatch 返回 SEND_CONFLICT
- [ ] contextVersion mismatch 返回 STALE
- [ ] humanActive 阻止发送
- [ ] ProcessingOutbox 至少一次投递但消费幂等
- [ ] SendOutbox SENDING 重启后 UNCERTAIN
- [ ] UNCERTAIN 不自动重试

### Workflow

- [ ] Draft 可保存
- [ ] 发布版本不可变
- [ ] 运行固定 version
- [ ] Task 只能一个 Owner
- [ ] Human Approval 批准前重校验
- [ ] Context 变化使 Proposal STALE
- [ ] 重启后 Run 恢复 / 取消

### Image

- [ ] MIME / 大小 / 解码校验
- [ ] 文件进对象存储
- [ ] Signed URL Workspace 隔离
- [ ] 图片 + 文字进入同 UserTurn
- [ ] 15 天清理任务

---

## 4. 10 个核心 Demo Case

### Case 01｜店铺 FAQ RAG

输入：

> 多久发货？

预期：

- STORE Knowledge
- Hybrid RAG 命中
- Evidence 显示
- 低风险可 AUTO / ASSIST 取决于 ShopAIMode

### Case 02｜商品卡与 ProductKnowledge

输入：

- 发送商品卡 P001
- 问“这个可以烘干吗？”

预期：

- currentProduct = P001
- 命中 ProductKnowledge
- 不使用其他商品知识

### Case 03｜SKU 库存

输入：

> 黑色 XL 还有吗？

预期：

- 库存来自 ProductContext
- 不从 RAG 返回库存
- Trace 明确数据源

### Case 04｜连续消息

2 秒内：

```text
黑色有吗
XL呢
我165，55公斤
```

预期：

- 3 Message
- 1 UserTurn
- 1 ReplyJob
- 完整回答

### Case 05｜生成中补消息

输入：

> 什么时候发货？

生成中：

> 我是新疆的。

预期：

- 旧 Job STALE
- 新 Job 使用偏远地区知识
- 旧答案不发送

### Case 06｜两个用户并行

同店两个 Buyer 同时发送。

预期：

- Conversation 并行
- 上下文隔离
- 每会话内部串行

### Case 07｜两个店铺隔离

两店同时问“多久发货”。

预期：

- 分别使用对应 StoreKnowledge
- 无跨店 Evidence

### Case 08｜多订单歧义

Buyer 有两个运输中订单，问：

> 我的快递怎么没动？

预期：

- AMBIGUOUS
- 展示两个订单候选
- 不猜
- 最多两轮澄清

### Case 09｜ASSIST + MANUAL

- AI Draft
- 人工修改
- 保存 AI Draft + Human Final
- 事实纠正生成 Candidate
- 人工接管后 AI 不发送
- 人工显式恢复

### Case 10｜服务恢复

- 生成中重启
- ReplyJob 恢复
- 发送中重启
- SendOutbox UNCERTAIN
- 无重复发送

---

## 5. V1 完成定义

必须同时满足：

- [ ] 在线访问
- [ ] 4 个入口可用
- [ ] 10 个 Demo Case 全通过
- [ ] 8 个 Scenario Lab 可重复运行
- [ ] 真实模型调用
- [ ] 真实 Hybrid RAG
- [ ] 真实图片多模态
- [ ] ProcessingOutbox
- [ ] SendOutbox
- [ ] Recovery Worker
- [ ] Developer Trace
- [ ] 关键自动测试通过
- [ ] Docker Compose 本地一键启动
- [ ] 无真实平台 Secret
- [ ] README 完整
- [ ] 3 分钟演示脚本可稳定重复

---

## 6. 不允许作为“完成”的情况

- 只有静态 UI
- 消息由前端数组伪造
- RAG 返回写死文本
- Scenario 只有动画
- SendGuard 只有提示，没有服务端校验
- Outbox 只有表，没有 Dispatcher 和幂等消费
- Workflow 只是流程图
- Trace 展示假数据
