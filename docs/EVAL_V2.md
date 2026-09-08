# Eval V2 可执行评测

Eval V2 将两份外部审查数据转换为可版本化、可重复执行、可审计的评测集：40 条知识检索案例和 72 条产品回复案例。它是现有固定 36 条与 AUTO 10 条基线的增量补充，不替换旧评测。

## 数据位置

- 不可变来源：`evals/source/retrieval-40.v1.csv`、`evals/source/product-testset-72.v1.csv`
- 显式映射：`evals/mappings/eval-v2-aliases.json`、`evals/mappings/eval-v2-overrides.json`
- 可执行数据：`evals/canonical/retrieval-40.v2.json`、`evals/canonical/product-testset-72.v2.json`

转换器严格校验列名、行宽、ID 唯一性、精确别名、Seed key、任务、上下文与可靠性能力。CSV 的 SHA256 会写入 canonical；来源变化但未重新生成 canonical 时，CLI 以 `NOT_RUN` 非零退出，不继续执行。

## 环境准备

离线确定性评测仍会走真实 AppModule、PostgreSQL/pgvector、Redis/BullMQ 和 MinIO 生产路径，因此需要先启动本地依赖并部署数据库：

```powershell
Copy-Item .env.example .env
pnpm infra:up
pnpm db:deploy
```

真实模型模式还要求在仓库外配置非确定性 Provider 及凭据，例如 DeepSeek：

```text
AI_OFFLINE_MODE=0
AI_PROVIDER=deepseek
AI_BASE_URL=https://api.deepseek.com/chat/completions
AI_API_KEY_FILE=<仓库外单行密钥文件的绝对路径>
AI_MODEL_NAME=<已配置模型>
```

密钥不得写入 Git、报告或命令输出。`REAL_PROVIDER` 不接受 `deterministic`、`offline` 或 `fixture` Provider；缺少真实基础设施或模型配置时会生成 `BLOCKED_ENVIRONMENT` 报告并非零退出。

## 运行命令

```powershell
pnpm eval:v2:convert
pnpm eval:v2:offline
pnpm eval:v2:real
pnpm eval:v2:all
```

- `eval:v2:convert`：重新校验来源、映射和 Seed，并原子生成两份 canonical JSON。
- `eval:v2:offline`：强制确定性离线 Provider，但检索、消息、任务、策略、Outbox 与恢复仍经过真实服务和基础设施。
- `eval:v2:real`：使用当前明确配置的真实模型 Provider；不会静默回退成离线答案。
- `eval:v2:all`：按 convert → offline → real 顺序执行，任一步非零即停止并保留该退出码。

CLI 可用 `--suite retrieval|product|all` 只运行指定套件。正常情况下请使用根脚本，避免绕过构建和 `.env` 加载。

## 五种状态

| 状态 | 含义 | 是否计为通过 |
| --- | --- | --- |
| `PASS` | 本 case 的全部结构化断言通过 | 是 |
| `FAIL` | 已执行，但任务、模式、证据、工具、输出或可靠性断言失败 | 否 |
| `BLOCKED_UNSUPPORTED` | 当前运行时缺少显式 capability | 否 |
| `BLOCKED_ENVIRONMENT` | 基础设施、真实 Provider 或 AppModule 环境不可用 | 否 |
| `NOT_RUN` | 例如来源与 canonical SHA 漂移，执行被预检阻止 | 否 |

任一安全阻断案例不是 `PASS`，整个命令即非零退出。Blocked 和 Not Run 从不折算成 Pass。

## 结果与审计字段

生成物位于 `artifacts/eval-v2/<UTC时间>-<commit>/`，该目录已被 Git 忽略：

```text
manifest.json
retrieval-results.json
retrieval-report.md
product-results.json
product-report.md
coverage-matrix.csv
```

`manifest.json` 记录 commit、dirty 状态、Node/pnpm/OS、Provider 模式和名称、模型、来源及 canonical SHA256、起止时间、耗时、命令和退出码。逐 case JSON 记录输入、setup、Provider 模式、耗时、实际 Task/Mode/Context/Evidence/Tool/Output、断言、失败原因和状态；Markdown 提供同源的人读表格；coverage matrix 必须恰好一行对应一个来源 ID。

检索案例按返回顺序评估 Top 1/Top 3、STORE/PRODUCT scope、shop/product 隔离、无证据和冲突。静态事实只能由冻结 Knowledge Evidence 支撑；库存、价格、订单和物流只能由限定作用域的动态 Task/Tool 结果支撑。

产品案例通过真实 Message → Turn → ReplyJob → TaskBundle → Draft/SendOutbox/Receipt 路径执行。AUTO 必须同时存在真实发送回执和可见投影；MANUAL 不得产生 AI 自动发送；高风险、冲突、缺证据和 Provider 故障必须安全降级。

## 隔离、清理与排障

每个 case 创建独立的 SEEDED Workspace，所有查询至少限定 `workspaceId`、`tenantId` 和 `shopId`，适用时继续限定 `productId`、`buyerId`、`conversationId`。执行器在 `finally` 中按精确 `workspaceId` 清理；不能以共享运营 Workspace 运行。

CLI 会在加载 AppModule 前检查参数、来源 SHA、环境和同数据库的本机 API 进程租约。若环境启动仍失败，也必须写出完整 `BLOCKED_ENVIRONMENT` 报告。排障时先看 manifest 退出码，再看逐 case `failureReasons`，不要修改测试、降低断言或直接改 canonical 来制造通过。

报告写入前会拒绝 credential-shaped 字段。提交前仍需运行：

```powershell
pnpm security:secrets
git diff --check
git ls-files artifacts/eval-v2
```

最后一条命令应无输出。
