# 冻结决策日志

本文件优先级最高。它汇总最终选择，解决前期讨论中的替代方案和冲突。

## 1. 产品形态

- V1：Web-first
- 路由：Workbench / Admin / Buyer Simulator / Scenario Lab
- Electron：P1
- Developer Trace：默认隐藏，可开启
- 在线 Demo：匿名独立 Workspace
- Workspace：Reset + 24h 无访问清理

## 2. 平台

- V1 只有 MockDouyinAdapter
- 其他平台显示“规划中”
- 不接真实 API
- 不复制私有接口或认证材料
- Core 处理规范化领域对象

## 3. 人工客服

- V1 只有一个人工客服
- 不做抢单、Assignment、Lease、Round Robin
- 人工接管后当前 Conversation 必须显式恢复 AI
- 新 Conversation 重新评估
- 不做结构化 Handoff Packet

## 4. 店铺 AI 模式

- ShopAIMode：AUTO_ALLOWED / ASSIST_ONLY / MANUAL_ONLY
- 与 ReplyPolicy 取更保守结果
- Conversation Override 可进一步降级
- 降级立即影响未发送任务
- 重新开启不恢复旧 ReplyJob
- 不做 Shop Readiness Gate
- Mock 店默认 Ready

## 5. 会话边界

- 平台 conversation ID 优先
- 无平台边界：30 分钟空闲关闭
- Conversation 关闭后摘要冻结
- 新 Conversation 可读取人工维护 CustomerMemory
- activeTopic / product / order 支持切换

## 6. 消息

- 去重：platform + shopId + externalMessageId
- 乱序：1 秒 Reorder Buffer
- Gap：Reconciliation 一次
- 仍缺：DEGRADED，禁止 AUTO
- 连续消息：2 秒 idle / 5 秒 hard max
- TurnBuffer 持久化 + BullMQ delayed + generation
- 消息支持 ACTIVE / RECALLED / EDITED / DELETED
- 迟到 / 撤回 / 编辑增加 contextVersion
- 图片 + 文字可进入同一 UserTurn

## 7. 并发

- 同 Conversation 串行
- 不同 Conversation 并行
- 单店 AI generation = 3
- 全局 AI generation = 6
- 单店 send = 1
- V1 不做公平调度器
- 所有 UserTurn 持久化
- 待回复工作 Coalescing
- 一个 Conversation 一个 ACTIVE ReplyJob
- 新 Turn 使旧 Job STALE + needsReplan

## 8. 会话记忆

- 当前会话：Recent Messages + Narrative Summary + Structured Facts
- 摘要保存 version / basedOnThroughSequence
- 消息修改影响摘要时 DIRTY
- Token Budget + 分层裁剪
- 长期 CustomerMemory 不自动提取
- 只有人工主动创建
- 支持编辑 / 停用 / 删除
- 类型：PREFERENCE / PRODUCT_PREFERENCE / ONGOING_CASE
- 禁止 PII、主观画像、动态订单事实

## 9. 商品学习

- 店铺添加后自动学习商品
- 数据源：MockDouyinAdapter，可选商品表格
- 动态事实：ProductContext
- 稳定详情：ProductKnowledge
- 高置信源事实自动启用
- AI FAQ / 低置信进入审核
- contentHash 增量更新
- 动态事实轻同步
- 支持手工同步 / 重新学习
- 下架不推荐，但保留历史支持
- V1 不做 SKU 级知识

## 10. 知识导入

- Excel / CSV
- 字段：商品 ID 可选、问题、答案
- 商品 ID 空：STORE
- 有商品 ID：PRODUCT
- 正常项校验后直接启用
- 重复 / 冲突 / 异常单独治理
- 不做 ImportBatch 整批回滚

## 11. 知识可信度与版本

- 来源优先级：
  - MANUAL
  - HUMAN_REVIEWED
  - AUTO_LEARNED
- 人工确认知识冲突：CONFLICTED，禁止 AUTO
- businessStatus 与 indexStatus 分离
- 只有 ENABLED + READY 参与 RAG
- 新版 READY 后原子切换
- 失败保留旧 activeVersion
- Soft Delete
- Reply 冻结 Evidence Snapshot
- ReplyJob 开始后知识后台修改不使其 STALE
- 新知识只影响后续 Job

## 12. RAG

- Metadata Filter
- BM25 / Keyword + Vector Hybrid
- Simple Rerank
- Top K 默认 3
- V1 不做 score / margin 可靠性门禁
- 硬过滤后取 Top1
- 无候选：NO_EVIDENCE
- 显式冲突：CONFLICTED
- 库存、订单等实时事实不走 RAG

## 13. Context Resolver

- 商品 / SKU / 订单 / 售后均先 Resolver
- 状态：RESOLVED / AMBIGUOUS / NOT_FOUND / STALE
- 多候选不让 LLM 猜
- 低 / 中风险最多 2 轮澄清
- 高风险直接 MANUAL
- 多个澄清项合并成 ClarificationBundle

## 14. Source of Truth

优先级：

1. 实时订单 / 商品 / 库存 / 物流 / 售后
2. 当前有效政策 / 知识
3. 当前用户明确表达
4. 人工维护 CustomerMemory
5. 会话摘要
6. LLM 通用知识仅用于表达

- Context 变化增加 contextVersion
- 库存 / 订单变化可使 ReplyJob STALE

## 15. TaskBundle

- 每 UserTurn 最多 4 Task
- READ Task 可并行
- Task 独立状态
- Partial Result 可用
- Blocking Failure 禁止 AUTO
- 任一 HIGH_RISK 禁止 AUTO
- Workflow Router 分配 Owner
- 一个 Task 一个 Owner
- 最终单一 Reply Composer

## 16. Reply Policy

- AUTO：低风险 + 有事实 / 知识 + Context 完整
- ASSIST：中风险或证据不足
- MANUAL：高风险、冲突、用户要求人工、系统 DEGRADED
- ShopAIMode / ConversationOverride 只能更保守

## 17. Reply Strategy

- 简单明确事实：Deterministic Fast Path
- 复杂、多 Task、品牌语气：LLM Composer
- 内部 Streaming
- 消费者只收到 Finalize 完整回复
- V1 最终只做违禁词 / 风险话术检查
- 不做完整 Output Guard

## 18. ASSIST

- Draft 上下文变化立即 STALE
- 5 分钟 EXPIRED
- 不自动发送
- 保存 AI Draft + Human Final
- 差异：
  - STYLE_EDIT
  - FACTUAL_CORRECTION
  - KNOWLEDGE_ENRICHMENT
- 后两者生成 KnowledgeCandidate

## 19. 人工回答学习

采用混合来源：

- AI 无答案后人工回答 → 自动候选
- 普通人工可主动保存为知识
- ASSIST 事实修正 → 自动候选
- 全部候选人工审核后发布
- 不把真实聊天直接训练模型

## 20. SendGuard

检查：

- lastMessageId
- sequence
- contextVersion
- humanActive
- idempotencyKey

- 不检查知识后台 Revision
- 失败不发送
- STALE Job Provider 支持则 Abort，否则逻辑取消并丢弃结果

## 21. Outbox 与恢复

- Message + ProcessingOutbox 同事务
- Dispatcher 至少一次投递 BullMQ
- Consumer 幂等
- SendOutbox 管平台写入
- SENDING 重启后 UNCERTAIN
- UNCERTAIN 不自动重发
- Recovery Worker 恢复 ReplyJob / Workflow / TurnBuffer / Scheduled Message
- ActionProposal WAITING_APPROVAL 保留，执行前重校验

## 22. AI Runtime

- Purpose-based routing
- Fast / Quality / Multimodal / Judge
- 8 秒 timeout
- transient retry 1 次
- Fallback
- Structured Output + Schema
- Repair 1 次
- Fail Closed
- 简单 Circuit Breaker
- V1 不做完整 AIConfigVersion
- 仅日志记录 model / prompt / rag / evidence / tokens

## 23. Prompt Injection 与数据最小化

- 用户、图片、商品详情、上传内容为 Untrusted
- Tool Allowlist
- Action Policy 在模型外
- Context Sanitizer
- Purpose-based 字段白名单
- PII 默认不发送模型
- 模型不能泄露 System 或取得权限

## 24. Action Policy

- READ：自动
- LOW_WRITE：白名单自动 + 幂等 + Audit
- MEDIUM_WRITE：人工确认
- HIGH_RISK：V1 只 Proposal + Mock Approval
- ActionProposal 执行前重校验 Context
- 只有明确 Receipt 才宣称成功

## 25. Workflow

- 小型真实可视化引擎
- 有限节点
- 草稿 / 发布 / 版本 / 日志
- 主流程：商品推荐
- 第二模板：售后协商
- 不做循环 / 自定义代码 / 通用低代码
- Human Approval 真正可操作

## 26. 主动消息

- 欢迎语每 Conversation 一次
- 安全延迟结束语
- 使用 ScheduledMessageJob
- 执行前重校验
- 新消息 / 人工 / Context 变化取消
- 不做催拍 / 催付 / 催评

## 27. 图片

- V1 真做图片多模态
- 视频 P1
- MinIO / S3
- Signed URL
- 原图 15 天
- 分析结果属于 ConversationContext
- 不自动进入知识

## 28. 业务状态模拟

- Scenario 只做订单与库存变化
- 不做售后事件驱动
- 物流保留静态 Mock 查询
- 不做完整 Mock ERP

## 29. 质检与错误

- 质检只人工触发
- 固定 Eval + 规则 + AI Judge + 人工结论
- ReplyIncident
- 人工 Correction
- 根因治理
- Regression Eval
- 不虚构线上准确率

## 30. 数据生命周期

- 聊天 45 天
- 图片 15 天
- Summary 90 天
- CustomerMemory 人工管理 / expiresAt
- 企业知识版本管理
- Delete Customer Data
- Audit 最小化

## 31. Usage / Quota

- 记录 AI Usage、Token、成本、Fallback
- 产品可展示虚拟店铺额度
- 公开 Demo 不做 Workspace 防刷 Quota / Rate Limit / 超额 Fallback
- API Key 仅服务端
- 该选择有费用风险，记录为已知风险

## 32. UI / Demo

- Web-first
- 2 店铺 / 4 Buyer / 10 商品 / 约 10 订单 / 50～80 知识
- Developer Trace 默认隐藏
- Buyer Simulator + Scenario Lab
- Scenario 固定 8 个
- 核心系统真实实现，外部平台 Mock
- 10 个 Case 通过才算 V1 完成
