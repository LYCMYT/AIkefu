# Q0 回复质量基础整改

## 已落地

- 服务端显式区分 DeepSeek、OpenAI-compatible Chat Completions、Responses 与 AIkefu custom JSON gateway；不再根据 `AI_BASE_URL` 猜测协议。
- 七类 AI purpose 使用仓库内版本化 Prompt Registry，包含可审查的安全规则与严格 JSON shape。
- ReplyRuntime 顺序调整为 Intent / Task → Context Resolver → Task-scoped RAG → frozen Evidence → Task execution → single Composer。
- 库存、订单、物流等动态事实不走 RAG；READ tool 不再自动视为 blocking。
- Composer 输入加入最近 12 条消息、实时 facts、Evidence、摘要、CustomerMemory、店铺 tone / policies 与 channel，并使用确定性的上下文字符预算。
- 动态状态转换为用户语言；默认不展示内部/外部实体 ID 和精确库存。
- Output Guard 覆盖空回复、最大长度、未执行 action claim、库存数值冲突、PII、内部 Prompt / Trace 与既有违禁词。
- `pnpm ai:eval:offline` / `pnpm ai:eval` 读取 `seed/eval-cases.json` 的 36 个固定案例，并输出 JSON + Markdown，不把失败包装成 PASS。

## 真实结果（2026-08-30）

| 模式 | 结果 | Token | 平均延迟 | 成本 |
|---|---:|---:|---:|---:|
| Offline fixture | 0 / 36 | 0 / 0 | 0 ms | 未报告 |
| DeepSeek real provider | 3 / 36 | 38,030 / 4,995 | 2,942 ms | Provider 未返回价格，未推测 |

DeepSeek 结构化输出已从 Intent schema 熔断修复到 35/36 Case 能完成模型链；主要失败是 Provider-only runner 没有加载 PostgreSQL 中的店铺 Evidence、ProductKnowledge 与动态 resolver facts。该结果只证明 Provider / Prompt 的真实表现，不代表生产 ReplyRuntime 的端到端准确率。

## 知识库事实

仓库包含两家合成店铺的 STORE Knowledge，建店后还会通过 durable Product Learning 生成 PRODUCT Knowledge；生产 ReplyRuntime 会按解析后的 shop/product scope 检索并冻结 Evidence。模型不得用自身常识替代知识库。直接 Provider Eval 中 Evidence 为空，因此任何“碰巧答对”都不能被解释为知识命中。

## 尚未完成

- 将全部 36 Case 接入隔离的真实 ReplyRuntime + PostgreSQL/pgvector + Redis/BullMQ + Evidence/receipt，形成真正端到端质量报告。
- 对语义性事实声明增加更完整的 entailment / Judge 门禁；现有 deterministic Guard 只覆盖高风险最小集合。
- 外部 Embedding、外部图片分析与 Quality Judge 仍未作为发布 Gate。

报告位于 `artifacts/eval/reply-eval-offline_fixture-latest.*` 与 `artifacts/eval/reply-eval-real_provider-latest.*`。
