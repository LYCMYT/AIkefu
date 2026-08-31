# AIkefu 求职展示文案

以下文案只使用仓库中已经实现并验证的事实，不包含虚构用户数、业务收入、线上 SLA 或模型准确率。

## 简历项目标题

**AIkefu｜多租户电商 AI 客服与可靠回复编排系统**

技术栈：TypeScript、React、NestJS、PostgreSQL/pgvector、Redis/BullMQ、MinIO、Prisma、WebSocket、Docker、Playwright

## 简历三条项目描述

- 设计并实现多租户电商 AI 客服闭环，将连续买家消息聚合为 UserTurn，经 TaskBundle、动态商品/订单 Context、Knowledge Evidence 与 ReplyPolicy 生成可审计回复，并通过 SendGuard、Outbox、Receipt 和恢复机制约束重复发送及旧答案外发。
- 实现 AUTO/人工接管、两轮澄清、动态库存失效、Workflow Human Approval、质量审核、Incident 与脱敏 Trace；高风险、证据不足或上下文失效时自动降级，避免模型越权执行退款等业务动作。
- 建立可复现质量门禁：647 / 647 单元测试、61 / 61 集成测试，并在 CI 中使用真实 PostgreSQL/pgvector、Redis、MinIO 和连接态浏览器 E2E；通过 Docker Compose 与 GHCR 镜像交付 Mock-only 演示环境。

## 一句话介绍

AIkefu 不是一个只会调用大模型的聊天页面，而是一套把 Evidence、实时业务上下文、人机协同与可靠消息状态机组合起来的电商客服 Demo。

## 面试时的三分钟讲解结构

1. **产品问题：** AI 客服不仅要“答得像”，还必须处理连续消息、动态库存、人工接管和发送竞态。
2. **核心链路：** Message → UserTurn → TaskBundle → Context/Evidence → Policy → SendGuard → Receipt。
3. **安全设计：** 高风险动作必须 Human Approval；AI OFF 会失效未发送任务；ContextVersion 变化会使旧 Job STALE。
4. **工程质量：** PostgreSQL/pgvector 保存事实与证据，Redis/BullMQ 驱动 durable work，MinIO 保存附件，Trace 提供脱敏审计。
5. **诚实边界：** 使用 MockDouyin 和合成数据，不宣称真实平台接入、线上用户或商业 KPI。

## GitHub 项目描述

> A production-style, mock-only multi-tenant AI customer service demo with grounded Evidence, live commerce context, human approval, durable outboxes, recovery, workflow orchestration and real-infrastructure CI.

## 可继续追问的技术点

- 为什么用 UserTurn 聚合而不是每条 Message 触发一次模型。
- 为什么 Evidence 快照必须和 ReplyJob 一起持久化。
- SendGuard 如何阻止新买家消息之后的旧答案发送。
- 为什么“运输开始”需要 durable marker，失败后为什么进入 UNCERTAIN 而不是自动重试。
- Workflow 的 Task ownership、Proposal snapshot 和审批恢复如何避免越权。
- 为什么公开 Demo 默认使用离线 provider，以及外部模型成本如何隔离。
