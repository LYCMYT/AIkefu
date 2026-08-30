# 3 分钟 Guided Showcase 演示脚本

## 验证说明

- Developer Trace 通过受控的 `trace=1` 查询参数开启，只展示结构化、脱敏的执行证据，不展示 Prompt 或思维链。
- 平台链路使用 MockDouyinAdapter 和合成业务数据；真实外部平台发送不在 V1 范围。
- 固定质量集与 Showcase 结果只证明当前冻结场景可复现，不代表开放域准确率、生产 SLA 或商业效果。

## 演示前

1. 启动 PostgreSQL/Redis/MinIO、最新 API 与 Web，打开 `http://localhost:5173/showcase`。
2. 确认页面显示“已连接”，并阅读运行边界：Mock 电商平台、合成数据、当前模型 Provider；图片场景默认是 Pipeline Fixture。
3. 点击“重置演示”。该操作只重置独立 Showcase Workspace，不影响运营工作台或 Scenario Lab。

## 0:00–0:15｜产品定位

> AIkefu 是一个多店铺 AI 客服工程 Demo，把商品与订单上下文、企业知识、风险策略、人机协同和可靠消息处理组合在同一接待链路中。外部平台使用 MockDouyinAdapter，所有业务数据均为合成数据。

## 0:15–0:50｜场景一：商品知识有据回答

- 选择“商品知识有据回答”，点击“开始演示”。
- 页面真实发送轻薄连帽卫衣商品卡和“这个可以放烘干机吗？”。
- 指出 `PRODUCT_QUERY`、Product Context、PRODUCT Evidence `k033`，以及消费者可见的“不建议烘干”回复。
- 打开“技术证据”，展示结构化 Trace；强调不展示 Prompt 或思维链。

## 0:50–1:25｜场景二：连续消息与多轮上下文

- 运行“连续消息与多轮上下文”。
- 展示“黑色有吗 / XL呢 / 我165，55公斤”三条 Raw Message 聚合为一个 UserTurn。
- 指出库存来自实时 ProductContext，尺码建议来自商品知识；后续“那白色呢”继承当前商品与最近消息。
- 本场景保留 AI Draft 供人工复核，不把草稿冒充已发送回复。

## 1:25–1:55｜场景三：生成中补充信息

- 运行“生成中补充信息”。
- 首问“今天下单什么时候发货？”，生成中追加“我是新疆的”。
- 展示旧 ReplyJob 失效/取消、新计划使用偏远地区 Evidence，旧普通时效未进入消费者回复。
- 强调 SendGuard 是持久一致性边界，不是 UI 动画。

## 1:55–2:25｜场景四：图片售后与人工接管

- 运行“图片售后与人工接管”。
- 页面发送订单卡、合成破损图 Fixture 和“我要退款并投诉”。
- 展示 AFTER_SALES / REFUND / COMPLAINT 风险进入 MANUAL，AI 没有宣称退款已经完成。
- 明确图片是多模态管线 Fixture；未开启外部图片分析时，不声称视觉模型准确率。

## 2:25–2:45｜工程证据

展开 Developer Trace，概括：

```text
Raw Message → UserTurn → TaskBundle → Context → Evidence → Policy → SendGuard → Receipt
```

补充说明 ProcessingOutbox、SendOutbox、Stale/Replan 和恢复语义；Trace 只显示结构化脱敏元数据。

## 2:45–3:00｜结果与边界

> 固定质量集 Offline / DeepSeek 均为 36/36，独立 AUTO 集均为 10/10。它们是冻结的合成用例结果，不代表开放域准确率或生产 SLA。项目不包含真实抖音接口、商业 KPI 或公网部署证明。

## 可复验证据

- 四场景、隔离/Reset、移动端与真实 Dashboard 由 `e2e/showcase.spec.ts` 验收。
- 截图位于 `artifacts/showcase/`。
- 场景输入、Task、Context、Evidence、模式、SendGuard/Receipt 与边界记录在 `artifacts/showcase/SHOWCASE_EVIDENCE.md`。
- 最终录制视频仍需人工录屏；脚本、截图和自动化结果不能冒充已录制视频。
