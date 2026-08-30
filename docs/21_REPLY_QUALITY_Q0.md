# Q0 回复质量基础整改

## 已落地

- 服务端显式区分 DeepSeek、OpenAI-compatible Chat Completions、Responses 与 AIkefu custom JSON gateway；不再根据 `AI_BASE_URL` 猜测协议。
- 七类 AI purpose 使用仓库内版本化 Prompt Registry，包含可审查的安全规则与严格 JSON shape。
- ReplyRuntime 顺序为 Intent / Task → Context Resolver → Task-scoped RAG → frozen Evidence → Task execution → single Composer。
- 库存、订单、物流等动态事实不走 RAG；READ tool 不再自动视为 blocking。
- Composer 输入包含最近 12 条消息、实时 facts、Evidence、摘要、CustomerMemory、店铺 tone / policies 与 channel，并使用确定性的上下文字符预算。
- 动态状态转换为用户语言；默认不展示内部/外部实体 ID 和精确库存。
- Output Guard 覆盖空回复、最大长度、未执行 action claim、库存数值冲突、PII、内部 Prompt / Trace 与既有违禁词。
- 显式用户意图会补强模型漏掉的 resolver / tool 约束；SKU 尺码按完整 token 匹配，避免 `L` 误命中 `XL`。
- 图片分析只允许受控观察结论进入回复；稳定人工政策可进入 Knowledge，库存、订单、物流状态及商品预售等动态承诺继续禁止写入 RAG。
- 新增生产评测执行器：每个 Case 使用隔离 Workspace，真实经过 AppModule、Prisma、ReplyRuntime、Task、Evidence、Draft / SendOutbox / Message 和 Trace，再由持久化投影生成报告。
- `pnpm ai:eval:production:offline` 与 `pnpm ai:eval:production` 读取 `seed/eval-cases.json` 的 36 个固定案例，并输出 JSON + Markdown；不把 unsupported 或失败包装成 PASS。

## 真实结果（2026-08-30）

| 模式 | 结果 | 输入 / 输出 Token | 平均延迟 | 成本 |
|---|---:|---:|---:|---:|
| Production Offline | 31 / 36 | 0 / 0 | 0 ms | 不适用 |
| Production DeepSeek | 31 / 36 | 30,150 / 3,688 | 1,757 ms | Provider 未返回价格，未推测 |

两种生产模式通过的是同一组 31 个产品案例。DeepSeek 报告中的 Token 与延迟来自持久化 `AIInvocation`，不是前端估算。当前 5 个失败均为评测执行器尚未实现的故障注入驱动，不是普通知识问答或动态事实回答失败：

- `E026`：primary provider timeout / fallback 驱动。
- `E027`：primary provider invalid JSON / repair / fallback 驱动。
- `E033`：审批前 contextVersion 变化驱动。
- `E035`：生成中进程重启恢复驱动。
- `E036`：外发中进程重启 / UNCERTAIN 恢复驱动。

这些能力已有各自的 runtime / recovery 测试，但尚未统一接入 36 Case production runner，因此 Gate 保持 31 / 36，禁止把它写成 36 / 36。

早期的 `pnpm ai:eval` Provider-only 探针曾得到 3 / 36；它不加载生产 PostgreSQL Evidence、动态 resolver 或发送回执，只用于验证 Prompt / Provider 协议。当前产品质量基线以 production runner 报告为准，二者不可混用。

## 知识库事实

仓库包含两家合成店铺的 STORE Knowledge，建店后还会通过 durable Product Learning 生成 PRODUCT Knowledge；生产 ReplyRuntime 按解析后的 shop / product scope 检索并冻结 Evidence。模型不得用自身常识替代知识库。稳定人工政策允许写入；商品预售、库存、订单与物流等动态事实必须由实时 resolver / tool 提供。

## 仍需完成

- 将上述 5 个故障注入场景接入统一 production runner，复用真实 provider fault、approval context mutation 与 restart harness。
- 对语义性事实声明增加更完整的 entailment / Judge 门禁；现有 deterministic Guard 只覆盖高风险最小集合。
- 外部 Embedding 与 Quality Judge 尚未作为发布 Gate；外部图片分析只在服务端显式 opt-in 时启用。

最新生产报告：

- `artifacts/eval/reply-eval-production_offline-latest.json`
- `artifacts/eval/reply-eval-production_offline-latest.md`
- `artifacts/eval/reply-eval-production_real_provider-latest.json`
- `artifacts/eval/reply-eval-production_real_provider-latest.md`
