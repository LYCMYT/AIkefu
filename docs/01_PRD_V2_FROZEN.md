# 电商 AI 智能客服 Demo PRD V2.0（冻结版）

## 0. 文档信息

- 项目名称：电商 AI 智能客服与 Agent 协同平台 Demo
- 项目类型：求职展示 / Clean-room 重构
- 版本：V2.0 Frozen
- 产品形态：Web-first
- 外部平台：MockDouyinAdapter
- 目标岗位：AI 全栈开发、AI 应用开发、FDE、AI 产品经理
- 需求状态：已冻结；除明确的 Bug、矛盾和不可实现项外，不再扩大 V1 范围

---

## 1. 背景与问题

用户曾独立完成一套参考成熟电商 AI 客服产品的功能原型，覆盖多平台入口、店铺设置、商品学习、问答导入、客服工作台、Agent 工作流和数据后台。原项目以抖音场景为主要适配方向，但未获得官方消息、订单、库存等接口，因此只在 Mock 环境完成验证，未生产部署。

当前目标不是伪造原工程，也不是像素级复刻参考产品，而是重新构建一套：

1. 可以真实运行；
2. 核心机制能够解释；
3. 外部平台可以 Mock；
4. 能通过自动测试证明；
5. 可以在线给 HR 和面试官体验；

的作品级 Demo。

---

## 2. 产品定义

面向电商商家的 AI 客服、企业知识和工作流协同平台。

核心闭环：

```text
店铺与商品初始化
→ 消费者消息进入
→ 消息去重 / 排序 / 聚合
→ 会话与业务上下文构建
→ 多意图任务拆解
→ 商品 / 订单歧义解析
→ Hybrid RAG
→ 风险与回复模式决策
→ Deterministic Fast Path 或 LLM Reply Composer
→ 人工确认或自动发送
→ SendGuard / Outbox
→ 质检、错误闭环和知识成长
```

---

## 3. V1 产品入口

### 3.1 `/workbench`

客服接待工作台：

- 当前店铺与 AI 模式
- 会话列表
- 消息区
- AI Draft
- 人工接管
- 商品、订单、物流上下文
- 快捷短语
- CustomerMemory
- Developer Trace

### 3.2 `/admin`

运营管理后台：

- 数据概览
- 店铺配置
- 商品与商品学习
- 知识管理
- 知识导入
- 候选知识与冲突
- Agent 工作流
- 人工质检
- Reply Incident
- AI Usage
- Demo Workspace Reset

### 3.3 `/buyer-simulator`

模拟消费者端：

- 选择店铺
- 选择模拟买家
- 发送文字
- 上传图片
- 发送商品卡
- 发送订单卡
- 编辑消息
- 撤回消息
- 查看客服回复

### 3.4 `/scenario-lab`

异常场景实验室：

1. 连续消息聚合
2. AI 生成中用户补充消息
3. 两个用户同时咨询
4. 两个店铺同时收到消息
5. 消息重复与乱序
6. AI 超时与 Fallback
7. 服务重启恢复
8. 库存 / 订单状态变化导致旧回复失效

---

## 4. 用户与角色

V1 只保留一个人工客服角色，不做多人抢单、客服分配和租约。

### 4.1 Demo 管理员 / 人工客服

拥有：

- 查看全部当前 Workspace 数据
- 管理两个 Mock 店铺
- 管理商品与知识
- 操作客服工作台
- 切换 AI 模式
- 人工接管
- 批准 / 拒绝工作流动作
- 发起质检
- 标记错误回复
- 管理 CustomerMemory

### 4.2 模拟消费者

通过 Buyer Simulator：

- 向指定店铺发送消息
- 上传图片
- 发送卡片
- 编辑 / 撤回消息
- 查看回复

### 4.3 AI 客服

由服务端 AI Runtime 驱动，不拥有用户权限。模型只生成结构化决策、Draft 或 ActionProposal，真正执行由业务规则控制。

---

## 5. Demo Workspace

### 5.1 匿名独立 Workspace

首次访问自动创建：

```text
workspaceId
tenantId
demoWorkspaceToken
expiresAt
```

所有数据查询必须包含 `workspaceId + tenantId`。

### 5.2 初始 Seed

每个 Workspace 初始化：

- 2 家店铺
- 4 个核心买家
- 10 个商品
- 约 10 个订单
- 约 50～80 条有效知识
- 预置工作流与 Eval Cases

### 5.3 Reset Demo

Reset 只影响当前 Workspace：

- 删除当前会话、任务、Trace、Incident 和运行数据
- 重载 Seed
- 不影响其他访问者

### 5.4 自动过期

24 小时无访问的 Demo Workspace 自动清理。该期限只属于匿名 Demo 环境，不等同于消费者数据保留期限。

---

## 6. 多平台展示边界

添加店铺页保留多个电商平台入口，但：

- 只有“抖音 Demo”可添加
- 淘宝、拼多多、京东、快手、小红书、视频号等标记“规划中”
- 页面明确提示：只有 MockDouyinAdapter 已实现
- Core 不得写死抖音私有字段

---

## 7. 店铺管理

### 7.1 Mock 店铺

- MIA Fashion：服饰
- Pixel Tech：数码

### 7.2 店铺状态

V1 预置店铺默认可用，不做 Shop Readiness Gate。

连接状态仍支持：

```text
CONNECTED
RECONNECTING
RECONCILING
DEGRADED
DISCONNECTED
```

### 7.3 店铺 AI 上限模式

```text
AUTO_ALLOWED
ASSIST_ONLY
MANUAL_ONLY
```

最终模式取更保守结果：

```text
ShopAIMode
+ ReplyPolicy
+ ConversationOverride
→ effectiveMode
```

### 7.4 AI Kill Switch

店铺从 AUTO_ALLOWED 降级时：

- AUTO → ASSIST_ONLY：生成可继续，但只进入 WAITING_HUMAN
- 切 MANUAL_ONLY：未发送 ReplyJob 取消或中止
- Scheduled 自动消息取消
- 重新开启时按最新上下文重新评估，不恢复旧 Job

---

## 8. 店铺设置

V1 支持：

- 客服风格：专业、亲切、简洁、活泼、自定义
- 物流政策
- 发货政策
- 售后政策
- 欢迎语
- 会话结束语
- 转人工关键词
- 违禁词与替换词
- 店铺 AI 上限模式

转人工关键词命中后进入 MANUAL。

最终输出只做违禁词 / 风险话术检查，不做完整 Output Guard。

---

## 9. 商品与商品自动学习

### 9.1 数据来源

V1：

```text
MockDouyinAdapter
+ 可选商品表格导入
```

### 9.2 商品自动学习触发

店铺添加成功后自动：

```text
同步商品
→ ProductLearningJob
→ 标准化 Product / SKU
→ 动态事实与稳定详情分离
→ AI 结构化提取
→ ProductKnowledge
→ Embedding / Index
```

### 9.3 动态事实

不进入长期 RAG：

- price
- SKU
- inventory
- status
- recommendable

通过 ProductContext 查询。

### 9.4 稳定知识

进入 ProductKnowledge：

- 材质
- 尺寸
- 版型
- 功能
- 使用方法
- 洗护
- 商品卖点
- 详情说明

### 9.5 自动学习可信度

- 明确来源、可追溯、高置信的源事实：AUTO_ENABLED
- AI 生成 FAQ、中低置信、存在歧义：REVIEW_REQUIRED
- 每条记录保留 sourceProductId、sourceText、sourceVersion、confidence

### 9.6 增量更新

- 动态事实轻量同步
- 稳定详情计算 contentHash
- hash 不变：跳过
- hash 改变：旧版本 OUTDATED，新建 ProductLearningJob
- 新版索引 READY 后切 activeVersion
- 手工入口：同步商品、重新学习

### 9.7 下架商品

- 不参与推荐
- 保留历史订单和售后查询所需数据

---

## 10. 知识导入与知识体系

### 10.1 表格字段

知识模板只包含：

- 商品 ID（可选）
- 问题
- 答案

判断作用域：

- 商品 ID 为空：STORE
- 商品 ID 存在：PRODUCT

不做 SKU 级知识。

### 10.2 导入流程

```text
上传 Excel / CSV
→ 解析
→ 字段校验
→ 商品 ID 校验
→ 重复检测
→ 冲突检测
→ 预览
→ 正常项直接 ENABLED
→ 重复 / 冲突 / 异常单独治理
```

V1 不做按 ImportBatch 整批回滚。

### 10.3 知识来源优先级

```text
MANUAL
>
HUMAN_REVIEWED
>
AUTO_LEARNED
```

但两条人工确认知识发生实质冲突时，不静默覆盖，进入 CONFLICTED 并禁止 AUTO。

### 10.4 知识状态

业务状态：

```text
DRAFT
ENABLED
DISABLED
OUTDATED
DELETED
```

索引状态：

```text
PENDING
INDEXING
READY
FAILED
```

只有 `ENABLED + READY` 参与 RAG。

### 10.5 知识更新

新版本先索引：

```text
v1 READY 继续服务
→ v2 INDEXING
→ v2 READY
→ activeVersion 切 v2
→ v1 OUTDATED
```

失败时 v1 继续服务。

### 10.6 Reply Evidence

每条 Reply 冻结当时 Evidence Snapshot：

- knowledgeItemId
- knowledgeVersion
- sourceType
- scope
- retrievedContentSnapshot

知识删除为 Soft Delete，不改变历史证据。

### 10.7 生成期间知识变化

ReplyJob 开始后固定使用当时知识快照。管理员之后修改知识不会让当前 Job 自动失效；新知识影响后续 Job。

---

## 11. 消息模型与消息管线

### 11.1 消息类型

```text
TEXT
IMAGE
GOODS_CARD
ORDER_CARD
SYSTEM
```

视频放 P1。

### 11.2 消息状态

```text
ACTIVE
RECALLED
DELETED
EDITED
```

编辑保留 MessageVersion。

### 11.3 标准化字段

每条消息至少包含：

```text
workspaceId
tenantId
platform
shopId
conversationId
buyerId
externalMessageId
sequence
role
kind
content
sentAt
receivedAt
status
```

### 11.4 去重

唯一约束：

```text
UNIQUE(platform, shopId, externalMessageId)
```

### 11.5 乱序

每 Conversation 维护 1 秒 Reorder Buffer。

发现 Gap：

1. 等待 1 秒；
2. Reconciliation 一次；
3. 仍缺失：Conversation → DEGRADED，禁止 AUTO；
4. 迟到消息插回 sequence 位置，contextVersion + 1，Summary DIRTY。

### 11.6 平台断线

正常 Subscribe + ShopSyncCheckpoint。

断线：

- 停止 AUTO 写入
- RECONNECTING
- 从 cursor / sequence 补拉
- 去重、排序、Gap Detection
- 完整后 CONNECTED
- 不完整则 DEGRADED

---

## 12. 连续消息聚合

### 12.1 参数

```text
idle window = 2 秒
hard max = 5 秒
```

### 12.2 持久化实现

使用：

- ConversationTurnBuffer
- BullMQ Delayed Job
- generation
- Recovery Worker

新的消息更新 generation；旧 delayed job 发现 generation 不匹配后直接失效。

### 12.3 图片与文字

图片和 2 秒内补充文字进入同一个 UserTurn。

### 12.4 UserTurn 与 ReplyJob

所有 UserTurn 都持久化，但同一 Conversation 只有一个 ACTIVE ReplyJob。

生成中出现新 Turn：

- 当前 Job STALE
- Abort（若 Provider 支持）
- needsReplan = true
- 更多 Turn 只更新 Open Tasks / Facts
- 旧 Job 释放后基于最新未解决状态只创建一个新 Job

Task 可被标记：

```text
OPEN
RESOLVED
SUPERSEDED
CANCELLED
FAILED
```

---

## 13. Conversation 与记忆

### 13.1 会话边界

- 优先平台 externalConversationId
- 无平台边界：30 分钟空闲关闭
- 新消息创建新 Conversation
- 同店铺长期 CustomerMemory 可继续使用

### 13.2 当前主题

Conversation 保存：

- activeTopic
- currentProductId
- currentOrderId
- intentGroup

业务主题变化时刷新当前上下文。

### 13.3 Conversation Memory

包括：

- Recent Messages
- Narrative Summary
- Structured Facts
- Open Questions
- Summary Version
- basedOnThroughSequence

消息撤回 / 编辑影响摘要时：

```text
Summary = DIRTY
→ 重建
```

### 13.4 长期 CustomerMemory

不自动提取。只有人工点击“保存为用户记忆”。

支持：

- PREFERENCE
- PRODUCT_PREFERENCE
- ONGOING_CASE

支持查看、编辑、停用、删除，不做复杂版本历史。

禁止保存：

- PII
- 完整聊天原文
- 库存 / 订单 / 物流状态
- 临时补偿
- 主观画像与情绪标签

---

## 14. Context Resolver

用户说“这个”“那个订单”“我的快递”时，不允许模型自由猜。

状态：

```text
RESOLVED
AMBIGUOUS
NOT_FOUND
STALE
```

规则：

- 商品卡 / 订单卡优先
- 明确商品、SKU、订单号次之
- 唯一候选可绑定
- 多候选必须澄清
- 没有候选 → ASSIST / MANUAL

### 14.1 澄清

低 / 中风险最多 2 轮。

多个 Task 缺信息时合并成 ClarificationBundle。

第二轮仍不明确 → MANUAL。

高风险直接 MANUAL。

---

## 15. Fact Context 与 Source of Truth

事实优先级：

```text
实时订单 / 商品 / 库存 / 物流 / 售后
>
当前有效店铺政策和知识
>
当前用户本轮明确表达
>
人工维护的 CustomerMemory
>
会话摘要
>
LLM 通用知识仅用于语言组织
```

FactContext 结构化后再交给模型。

每次上下文变化：

```text
contextVersion + 1
```

库存或订单状态变化即使用户没发消息，也会让基于旧 Context 的 ReplyJob STALE。

---

## 16. TaskBundle 与 Workflow Router

### 16.1 多意图

一个 UserTurn 最多拆 4 个 Task。

每个 Task：

- intent
- riskLevel
- requiredContext
- requiredKnowledge
- requiredTools
- status

### 16.2 并行

READ Task 可以并行。

部分失败：

- PARTIAL_RESOLVED
- 成功部分保留
- 失败部分明确说明
- Blocking Failure 使整轮禁止 AUTO

### 16.3 工作流所有权

TaskBundle → Workflow Router。

- 一个 Task 只能有一个 Workflow Owner
- 多 READ Workflow 可并行
- 写操作统一走 Action Policy
- 最后统一由一个 Reply Composer 输出一条回复

---

## 17. AI Reply Policy

### 17.1 模式

```text
AUTO
ASSIST
MANUAL
HOLD
```

### 17.2 动态决策

```text
低风险 + 明确知识 / 实时事实 + Context 完整
→ AUTO

中风险
→ ASSIST

知识不足 / Context 不完整
→ ASSIST 或澄清

高风险 / 冲突 / 用户要求人工 / 系统 DEGRADED
→ MANUAL
```

最终模式受 ShopAIMode 与 Conversation Override 限制，只能更保守。

### 17.3 MANUAL 恢复

当前 Conversation 进入 MANUAL 后：

- 不按时间自动恢复
- 只有人工显式点击恢复
- 新 Conversation 重新评估
- ACTIVE ONGOING_CASE 使新会话偏向 ASSIST / MANUAL

---

## 18. Reply Strategy

### 18.1 Deterministic Fast Path

满足：

- 单一简单 Task
- LOW Risk
- 唯一可靠事实
- 不需要复杂表达

直接用模板生成回复，不调用 Quality Reply Model。

### 18.2 LLM Reply Composer

用于：

- 多 Task 合并
- 复杂上下文
- 售后解释
- 品牌语气
- ASSIST Draft

### 18.3 Streaming

- 内部可以 Streaming
- ASSIST 中客服可看到 Draft Preview
- 消费者永远只收到 Finalize 后的一次性完整消息

### 18.4 最终检查

V1 只做：

- 违禁词
- 风险话术替换 / 阻断

不做完整 Grounding、Action Claim、PII Output Scanner。

---

## 19. ASSIST 与人工学习

### 19.1 Draft TTL

ASSIST Draft：

- Context 变化立即 STALE
- 5 分钟无变化后 EXPIRED
- 不自动发送
- 人工需重新生成

### 19.2 AI Draft + Human Final

保存：

- AI Draft
- Human Final
- 差异类型

分类：

```text
STYLE_EDIT
FACTUAL_CORRECTION
KNOWLEDGE_ENRICHMENT
```

后两种生成 KnowledgeCandidate，必须人工审核后发布。

### 19.3 KnowledgeCandidate 来源

- AI_NO_ANSWER_HUMAN_REPLY
- MANUAL_SAVE
- AI_DRAFT_CORRECTION

---

## 20. SendGuard 与发送

SendGuard 至少检查：

```text
expectedLastMessageId
expectedSequence
expectedContextVersion
humanActive
idempotencyKey
```

当前知识版本变化不触发 STALE；知识快照固定。

发送链路：

```text
Final Draft
→ Forbidden Terms Check
→ SendGuard
→ SendOutbox
→ MockDouyinAdapter.send
→ Receipt
```

SendOutbox 状态：

```text
PENDING
SENDING
SENT
FAILED
UNCERTAIN
```

UNCERTAIN 不自动重发。

---

## 21. AI Runtime

### 21.1 Purpose-based Routing

```text
Intent / Risk / Summary / Knowledge Extract
→ Fast Model

Reply Generation
→ Quality Model

Image Analysis
→ Multimodal Model

Quality Review
→ Judge Purpose
```

### 21.2 Structured Output

决策型调用必须：

```text
Structured Output
→ JSON Schema Validation
→ Repair 1 次
→ 仍失败 Fail Closed
```

最终 Reply Draft 可自然语言。

### 21.3 超时与 Fallback

- 单次生成超时：8 秒，可配置
- 瞬时错误最多重试 1 次
- 主 Provider 失败 → Fallback
- 空答案 / 结构错误 Repair 1 次
- 仍失败按 AUTO / ASSIST / MANUAL 降级
- Provider 连续失败触发简单 Circuit Breaker

### 21.4 Stale Cancel

Provider 支持取消则 Abort；不支持则逻辑取消，返回结果丢弃。

### 21.5 AI 使用统计

记录：

- 调用次数
- input / output tokens
- 估算成本
- 图片调用
- 失败与 Fallback
- Fast Path 数量

产品模块可展示虚拟店铺额度概念，但公开 Demo 不做 Workspace 级防滥用 Quota、Rate Limit 或超额 Fallback。API Key 仍必须只在服务端。

---

## 22. 图片多模态

### 22.1 V1

支持真实：

- TEXT
- IMAGE
- GOODS_CARD
- ORDER_CARD
- SYSTEM

视频仅 P1 占位。

### 22.2 存储

- MinIO / S3
- 数据库保存 Attachment Metadata
- 短时 Signed URL
- 原图默认保留 15 天

### 22.3 分析

图片 + 同 Turn 文字 → Multimodal Model → Structured Output。

视觉模型只描述可见事实，不直接决定退款或补偿。

分析结果属于 ConversationContext，不自动进入企业知识库。

---

## 23. Agent Workflow

V1 做有限节点的小型真实引擎。

节点类型：

```text
TRIGGER
CONDITION
QUERY_PRODUCT
QUERY_ORDER
QUERY_LOGISTICS
AI_GENERATE
HUMAN_APPROVAL
END
```

支持：

- 新增 / 删除 / 拖拽 / 连线
- 节点配置
- 保存草稿
- 发布版本
- 启停
- 运行日志

主工作流：商品推荐。

第二模板：售后协商，仅用于演示，不做真实平台售后执行。

### 23.1 Human Approval

支持批准 / 拒绝。

批准后必须重新校验：

- contextVersion
- conversation
- order / product state
- proposal 有效性

过期 → STALE。

---

## 24. 主动消息

### 24.1 欢迎语

- 每 Conversation 最多一次
- 走 SendGuard 与 Outbox

### 24.2 延迟结束语

使用 ScheduledMessageJob，不用前端 setTimeout。

执行前重新检查：

- Conversation 是否仍空闲
- 用户是否新发消息
- 人工是否介入
- Context / Order 状态是否变化

变化 → CANCELLED_STALE。

---

## 25. 可靠性

### 25.1 Transactional Processing Outbox

Message 与 ProcessingOutbox 在同一个 PostgreSQL 事务写入。

Dispatcher 至少一次投递 BullMQ。

消费侧幂等。

### 25.2 Recovery Worker

服务启动扫描：

- ReplyJob GENERATING → RECOVERY_PENDING → 重试或 STALE
- SendOutbox SENDING → UNCERTAIN
- WorkflowRun RUNNING → 恢复或取消
- ActionProposal WAITING_APPROVAL → 保留，执行前重校验
- TurnBuffer BUFFERING → 恢复 delayed job
- ScheduledMessageJob → 恢复

---

## 26. 质检与错误闭环

### 26.1 质检触发

只允许人工主动发起，不自动在会话关闭后运行。

质检：

- 确定性规则
- AI Judge
- 人工复核

指标：

- 已质检回复通过率
- 知识有据回答率
- 转人工正确率
- 上下文关联正确率

### 26.2 Reply Incident

人工标记“回答有误”后：

```text
ReplyIncident
→ 人工 Correction Reply
→ 根因分类
   Knowledge / Context / Model / Policy
→ 修复
→ 加入 Regression Eval
```

### 26.3 Eval Set

固定 Eval + Regression Cases。

不能使用虚构线上准确率。

---

## 27. Developer Trace

默认隐藏，手动开启，也支持 `/workbench?trace=1`。

展示结构化信息：

- Raw Messages / UserTurn
- TaskBundle
- Context Resolver
- ProductContext / CustomerContext
- RAG Evidence
- Reply Policy
- Workflow / Tools
- SendGuard
- AI Runtime 日志
- Quality / Incident

不展示模型私有推理文本。

---

## 28. Web 通信

### 28.1 REST

负责 Commands / Queries：

- Workspace
- Shop settings
- Knowledge import
- Workflow publish
- Human takeover
- Human send
- Reset
- Manual quality review

### 28.2 WebSocket

负责实时事件：

- Message received / recalled / edited
- Conversation updated
- ReplyJob lifecycle
- Draft streaming
- Reply sent
- Workflow node events
- Product / order mock state change
- Quality / Incident update
- Shop connection state

数据库是 Source of Truth。

WebSocket 断线后：

```text
Reconnect
→ REST 拉快照
→ 继续订阅
```

---

## 29. 数据保留

默认值：

- Conversation 原始聊天：45 天
- 图片原件：15 天
- ConversationSummary：90 天
- CustomerMemory：人工管理，可设置 expiresAt
- 企业知识：版本、状态、有效期管理
- AuditLog：最小化脱敏记录

支持 Delete Customer Data：

- 删除 / 匿名化聊天
- 删除图片
- 删除 CustomerMemory
- 删除相关候选知识
- 保留匿名聚合统计

---

## 30. 非目标

V1 不做：

- 真实抖音登录与 API
- 其他平台真实 Adapter
- 多人工客服分配
- Shop Readiness
- 自动长期 Memory 提取
- 自动质检
- 完整 Output Guard
- AIConfigVersion 后台
- 导入批次回滚
- 公平调度
- 售后事件驱动
- Electron
- 真实支付 / 套餐
- 真实退款 / 补偿 / 打款
- 视频真实分析

---

## 31. 10 个核心验收 Case

详见 `docs/13_TEST_ACCEPTANCE.md`：

1. 店铺 FAQ RAG
2. 商品卡绑定 ProductKnowledge
3. SKU 库存来自 ProductContext
4. 连续消息聚合
5. 生成中补消息使旧 Job STALE
6. 两个用户并行
7. 两个店铺隔离
8. 多订单歧义澄清
9. ASSIST 修改 + MANUAL
10. 服务恢复与未知发送不重发
