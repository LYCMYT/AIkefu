# V1 已知限制

1. 不接真实抖音消息、订单、库存与登录。
2. 其他平台仅展示规划入口。
3. 只有一个人工客服，不做分配与抢单。
4. Shop AI Readiness Gate 已覆盖普通回复、澄清和定时消息；多实例部署仍需外部 fencing，当前按单 API 实例演示。
5. Knowledge Gate 不做 score / margin 置信门禁，硬过滤后取 Top1。
6. ReplyJob 生成期间知识后台变化不使当前 Job 失效。
7. 最终回复已有空值/长度、Action receipt、库存数值、PII、Prompt/Trace 与违禁词 Guard；尚未实现覆盖所有自然语言事实的通用语义蕴含校验。
8. 质检只人工触发。
9. CustomerMemory 只人工创建。
10. 不做导入批次整体回滚。
11. 不做公平调度器。
12. 不做售后事件实时模拟。
13. 不做视频真实分析。
14. 不做 Electron。
15. 不做真实套餐支付。
16. 公开 Demo 不做 Workspace 级防刷 Quota / Rate Limit；存在模型费用风险。
17. BM25 在应用层实现，仅适合 Demo 小规模语料。
18. 不声称满足生产 SLA、安全认证或大规模并发。
19. 本交付不声称在线部署已完成；本地基础设施和生产风格 Compose 已实跑，但没有公网主机、域名或 TLS 终止点。
20. 不虚构商业 KPI、转化率、准确率或成本收益；Usage 页面只展示服务端返回的 Demo 运行快照。
21. 本地匿名 Workspace token 仍存在浏览器 localStorage；已有严格 CSP，但公网部署前仍应升级为 HttpOnly + SameSite Cookie 或受控的一次性会话。
22. 本机 DeepSeek Chat JSON 适配器已完成结构化探针、合成浏览器主链及隔离生产评测。Production Offline 与 Production DeepSeek 均为 31/36；DeepSeek 持久化统计为 30,150 / 3,688 Token、平均 1,757 ms。Embedding 仍为本地 1536 维 fallback，外部图片分析只允许服务端显式 opt-in，Judge 尚未形成完整外部 Gate。
23. 当前 production Eval CLI 已接入真实 AppModule、ReplyRuntime、PostgreSQL Knowledge/Evidence、动态工具与 durable Draft/SendOutbox/Message 投影。剩余 `E026`、`E027`、`E033`、`E035`、`E036` 是统一 runner 尚未接入 provider fault、审批上下文变化及进程重启驱动；这些案例保持失败，不记作 PASS。
24. 前端已引入 React Router、TanStack Query 和 feature 目录，但 Workbench / Buyer / Workflow 以及 `api.ts` / `styles.css` 仍较大，需按功能渐进拆分，不适合一次性无测试重写。
