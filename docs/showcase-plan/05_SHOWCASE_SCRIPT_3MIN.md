# 05｜三分钟 Showcase 演示脚本

## 0:00–0:15｜定位

> 这是一个面向电商商家的多店铺 AI 客服 Demo。它把企业知识、商品与订单上下文、人机协同和可靠消息处理组合在同一条接待链路中。当前电商平台采用 MockDouyinAdapter，所有买家、订单和商品均为合成数据。

## 0:15–0:50｜场景一：商品知识有据回答

1. 发送轻薄连帽卫衣商品卡；
2. 输入“这个可以放烘干机吗？”；
3. 展示自动回复；
4. 打开 Trace，指出 ProductContext 和 `k033` Evidence。

讲解重点：商品级知识必须先解析商品，再按 Product Scope 检索。

## 0:50–1:25｜场景二：连续消息和多轮上下文

1. 连续发送“黑色有吗 / XL 呢 / 我 165、55 公斤”；
2. 展示 3 Raw Messages → 1 UserTurn；
3. 展示库存与尺码 Task；
4. 再问“那白色呢？”；
5. 展示 Recent Messages 和 Context Resolver。

讲解重点：不同会话并行，同一会话串行；用户说话快于 AI 时只基于最新未解决状态重规划。

## 1:25–1:55｜场景三：生成中补充信息

1. 输入“今天下单什么时候发货？”；
2. 生成中补充“我是新疆的”；
3. 展示旧 ReplyJob STALE；
4. 展示新 Evidence 使用偏远地区政策；
5. 说明旧答案没有进入 SendOutbox。

讲解重点：SendGuard 是硬性一致性边界，不是 UI 提示。

## 1:55–2:25｜场景四：图片售后与人工接管

1. 上传合成破损图；
2. 输入“收到就是这样的，我要退款并投诉”；
3. 展示风险、订单、售后知识和 MANUAL；
4. 强调系统没有宣称已经退款。

若为 Fixture：明确说这是多模态管线 Fixture，不声称视觉准确率。

## 2:25–2:45｜工程证据

快速展开 Developer Trace：

```text
UserTurn → TaskBundle → Context Resolver → Evidence → Policy → SendGuard → Receipt
```

说明 ProcessingOutbox、SendOutbox、Stale、Recovery 的作用。

## 2:45–3:00｜边界与结果

> 这个项目重点验证 AI 客服的产品和工程链路，不包含真实抖音生产接口，也不虚构真实商家 KPI。回复质量通过固定 Eval、失败 Case 和 Regression Gate 持续验证。
