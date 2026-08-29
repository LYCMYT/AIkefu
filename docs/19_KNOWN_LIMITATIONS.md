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
22. 本机 DeepSeek Chat JSON 适配器已完成结构化探针与合成 Buyer→Intent/Risk/Reply→Draft→Human Final 浏览器链。36 Case 已执行：离线 0/36、DeepSeek Provider-only 3/36；后者不加载生产 DB Evidence / live resolver，不能代表产品端到端准确率。Embedding 仍为本地 1536 维 fallback，外部图片分析关闭，Judge 未形成完整外部 Gate。
23. 当前 Eval CLI 是可复现的 Prompt / Provider 评测边界，会诚实记录空 Evidence 和失败；尚需把 36 Case 全部接到隔离的真实 ReplyRuntime、PostgreSQL Knowledge/Evidence、动态工具与发送回执后，才能形成产品回复质量基线。
24. 前端已引入 React Router、TanStack Query 和 feature 目录，但 Workbench / Buyer / Workflow 以及 `api.ts` / `styles.css` 仍较大，需按功能渐进拆分，不适合一次性无测试重写。
