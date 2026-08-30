# 02｜Showcase Experience Spec

## 1. 产品目标

新增 `/showcase`，作为求职演示入口。它不是静态营销页，也不硬编码回复，而是复用现有真实 API、WebSocket、LiveTest、Workbench、Developer Trace 和 Scenario Lab。

公开演示链接推荐直接指向：

```text
https://<demo-host>/showcase
```

完整产品继续保留：

```text
/workbench
/admin
/buyer-simulator
/scenario-lab
```

## 2. 避免重复开发

当前仓库已有 `LiveTestPage`，已经把买家端、店铺端和处理管线放在同一页面。Codex 应优先抽取与复用该组件，而不是再复制一份 BuyerSimulator 和 Workbench。

建议新增：

```text
apps/web/src/features/showcase/
  ShowcasePage.tsx
  showcase-model.ts
  showcase-runner.ts
  showcase.css
  components/
```

并复用：

```text
features/live-test/
features/workbench/
Developer Trace
现有 REST/WebSocket endpoints
Scenario Lab runner
```

## 3. Workspace 隔离

为 Showcase 增加独立浏览器会话槽位：

```text
WorkspaceSessionKind = operational | scenario | showcase
```

- `showcase` 使用单独 localStorage key；
- 创建和 Reset 均使用 `SEEDED` profile；
- Reset Showcase 不得清空 Workbench 或 Scenario Workspace；
- 多标签页继续以服务端状态为真相；
- 不新增新的 DemoWorkspaceProfile 或数据库表，除非现有实现无法满足且有测试证明。

## 4. 页面布局

1440×900 推荐布局：

```text
┌──────────────────────────────────────────────────────────────┐
│ AIkefu｜场景 1/4｜当前店铺｜AI 模式｜重置｜自由体验          │
├───────────────┬──────────────────────────────────────────────┤
│ Buyer 端      │ 店铺工作台 / 当前会话                        │
│ 约 340–380px  │ 自适应                                       │
│               │                                              │
├───────────────┴──────────────────────────────────────────────┤
│ 处理管线：接收 → 聚合 → 理解 → 检索/上下文 → 回复/接管       │
└──────────────────────────────────────────────────────────────┘
```

Developer Trace 默认收起，点击后使用 Drawer 展示，不占据普通 HR 的主画面。

## 5. 四个主场景

以 `assets/showcase-scenarios.json` 为机器可读事实源。

### 场景 1：商品知识有据回答

- 店铺：MIA Fashion；
- 买家：Mia；
- 商品：轻薄连帽卫衣；
- 问题：这个可以放烘干机吗？

必须真实执行：商品卡 → Context Resolver → ProductKnowledge `k033` → 回复 → Buyer 可见。

### 场景 2：连续消息与多轮上下文

- 连续发送黑色、XL、身高体重；
- 验证 2 秒 idle / 5 秒 hard 聚合；
- 后续问“那白色呢？”；
- 验证 Recent Messages、当前商品、SKU 和用户偏好。

### 场景 3：生成中补充信息

- 先问发货；
- 生成中补充“我是新疆的”；
- 旧 ReplyJob 必须 STALE/Abort/Replan；
- 最终使用 `k002`，旧的普通 24 小时回复不得发送。

优先复用现有 `message_during_generation` Scenario，不为展示写一套假的延迟逻辑。

### 场景 4：图片售后与人工接管

- 买家：阿青；
- 订单：`order_004`；
- 上传破损图片并提出退款/投诉；
- 命中破损政策和高风险人工流程；
- 不得宣称退款已经完成。

若只使用 Fixture marker，页面必须明确标注：

```text
多模态管线演示（Fixture），不代表真实视觉准确率
```

有真实 multimodal provider 时，才允许标记为真实视觉模型运行。

## 6. 可选加分场景

“AI 不知道 → 人工回答 → KnowledgeCandidate → 审核发布 → 再次命中”。

该场景不放入 3 分钟主流程，避免拖长演示。

## 7. 页面状态

每个场景必须有：

```text
NOT_STARTED
PREPARING
RUNNING
WAITING_AI
WAITING_HUMAN
COMPLETED
FAILED
CANCELLED
```

失败时展示真实原因，禁止自动切换成预置成功结果。

真实 Provider 不可用时：

- 明确显示“真实模型未配置/不可用”；
- 可以进入显式 Offline Demo Mode；
- Offline 与 Real Provider 必须视觉标识分开；
- 不得把 Fixture 结果算入真实回复质量。

## 8. 操作

顶部只保留：

- 上一场景；
- 开始/重新运行；
- 下一场景；
- 重置演示；
- Developer Trace；
- 进入完整产品。

不在页面堆放长篇产品说明。

## 9. Dashboard 和 Incident 展示

运行完四个场景后：

- Dashboard 使用真实新产生的事件；
- 不硬编码趋势、增长率、准确率；
- Incident 必须由真实失败/人工标错产生，不能直接 Seed 一条“成功事故”；
- Trace 展示真实 Task、Context、Evidence、Policy、Guard、Provider 和 Receipt。

## 10. 可访问性与响应式

- 1440×900 为作品集主视图；
- 1366×768 可完整操作；
- 小屏切换 Buyer/Workbench tabs；
- IconButton 有 aria-label；
- 场景步骤和状态不能只靠颜色表达；
- Dialog/Drawer 支持 Esc；
- 不出现整体横向溢出。
