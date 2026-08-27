# V1 已知限制

1. 不接真实抖音消息、订单、库存与登录。
2. 其他平台仅展示规划入口。
3. 只有一个人工客服，不做分配与抢单。
4. 不做 Shop AI Readiness Gate。
5. Knowledge Gate 不做 score / margin 置信门禁，硬过滤后取 Top1。
6. ReplyJob 生成期间知识后台变化不使当前 Job 失效。
7. 最终回复只做违禁词 / 风险话术检查，不做完整 Output Guard。
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
19. 本交付不声称在线部署已完成；Compose 只提供本地 PostgreSQL/Redis/MinIO 依赖，真实基础设施验收需显式 opt-in。
20. 不虚构商业 KPI、转化率、准确率或成本收益；Usage 页面只展示服务端返回的 Demo 运行快照。
