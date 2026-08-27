# 3 分钟演示脚本

## 0:00–0:20｜进入 Demo

- 打开 `/workbench?trace=1`
- 说明当前 Workspace 是独立 Sandbox
- 展示两家 Mock 店铺
- 说明只有抖音 Demo 可用，其他平台是规划入口

## 0:20–0:50｜知识与商品

- 切到 MIA Fashion
- 展示商品学习已完成
- 打开轻薄连帽卫衣
- 展示 ProductContext：SKU / 库存
- 展示 ProductKnowledge：材质 / 洗护
- 打开知识导入页，展示三列表格模板

## 0:50–1:25｜连续消息与 RAG

Buyer Simulator：

```text
黑色有吗
XL呢
我165，55公斤
```

Workbench：

- 3 条 Raw Message
- 1 个 UserTurn
- 2 个 Task
- 库存来自 ProductContext
- 尺码建议来自 ProductKnowledge / Summary
- AI Draft 出现
- Developer Trace 展示 Evidence

## 1:25–1:55｜生成中补消息

Buyer 再问：

> 什么时候发货？

AI 生成中补：

> 我是新疆的。

展示：

- contextVersion 变化
- 旧 ReplyJob STALE
- Abort / Replan
- 新回复使用偏远地区规则

## 1:55–2:20｜多订单歧义

切 Pixel Tech / 张先生：

> 我的快递怎么没动？

展示：

- 两个运输中订单
- Context Resolver = AMBIGUOUS
- 系统不猜
- 用户选择键盘订单
- 返回正确物流

## 2:20–2:40｜人工协同

- 将店铺设为 ASSIST
- 修改 AI Draft
- 展示 AI Draft + Human Final
- 点击人工接管
- AI 变 MANUAL
- 展示手工保存 CustomerMemory 或知识 Candidate

## 2:40–3:00｜可靠性与 Workflow

- Scenario Lab 运行“服务重启恢复”
- 展示 SENDING → UNCERTAIN
- 打开商品推荐 Workflow
- 展示节点、发布版本、运行日志
- 结尾说明：外部平台是 Mock，核心系统真实实现

## 验证说明

这是一份可重复的人工演示验收清单，不是“看起来像”的静态 UI 验收，也不替代浏览器 E2E。开始前：

1. 复制 `.env.example` 为 `.env`，按 README 启动本地 PostgreSQL/Redis/MinIO 依赖和 API/Web；本脚本不需要真实平台账号或真实模型 Key。
2. 执行 `pnpm --filter @ai-customer-service/contracts build`、`pnpm --filter @ai-customer-service/web test:unit`、`pnpm --filter @ai-customer-service/web build`。
3. 打开 `/workbench?trace=1`（或进入 Workbench 后点击 Trace），点击 Reset demo，确认当前 Workspace 与 WebSocket 已连接。

逐段核对：

| 段落 | 可见证据 | 边界 |
| --- | --- | --- |
| 知识与商品 | 商品、ProductContext、知识导入模板来自当前 Workspace REST 快照 | 商品/订单/知识为合成数据 |
| 连续消息 | Raw Message、UserTurn、Task、AI Draft 和 Trace 事件 | Trace 只显示结构化脱敏事件，不显示 prompt/CoT |
| 补消息与歧义 | contextVersion、旧 Job STALE、Resolver=AMBIGUOUS、订单候选 | 业务平台仍为 MockDouyinAdapter |
| 人工协同 | AI Draft 与 Human Final、MANUAL、CustomerMemory/Candidate 操作 | 真实外部平台发送不在 V1 范围；演示发送走 MockDouyinAdapter |
| 恢复与 Workflow | Scenario 状态、UNCERTAIN、节点/连线/发布版本/运行日志 | 没有真实在线部署或商业 KPI 证明 |

若要复验真实基础设施，先确认 Docker 已启动、迁移已部署，再显式设置 `RUN_REAL_INFRA_INTEGRATION=1` 运行 API integration suite（使用 `pnpm exec dotenv -e .env -- ...`）；未设置或依赖不可用时的 skipped 不得标记为真实 infra 通过。演示结束仍只报告本地合成环境的观察结果。
