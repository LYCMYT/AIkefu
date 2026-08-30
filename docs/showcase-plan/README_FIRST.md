# AIkefu Demo Knowledge & Showcase Codex Pack V1.0

这套文件用于在 **Q0.1 产品级质量收口之后**，把 AIkefu 从“功能很多的工程 Demo”整理成一套可稳定演示、可解释、可复位、不会用假数据掩盖问题的求职旗舰项目。

## 使用方式

1. 将本目录完整复制到仓库：`docs/showcase-plan/`。
2. 保留当前真实源码、Prompt、Seed、Eval 与测试，不要用本包替换业务代码。
3. Codex 模型建议：默认 **Medium**；只有 Receipt Recovery / Outbox / 并发根因临时使用 High。
4. 在一个 Codex 窗口中复制 `COPY_THIS_TO_CODEX.txt` 全文执行。
5. Codex 不得跳过 Q0.1 Gate；确定性测试未通过时，不得先做展示页面。
6. 完成后把最新源码包、证据包、Eval 报告和截图再次交给外部审查。

## 本包包含

- `COPY_THIS_TO_CODEX.txt`：单窗口完整执行指令。
- `01_DEMO_KNOWLEDGE_PRODUCT_SPEC.md`：内置知识与演示资产规范。
- `02_SHOWCASE_EXPERIENCE_SPEC.md`：`/showcase` 引导演示产品设计。
- `03_SEED_FIXTURE_EVAL_BOUNDARIES.md`：Seed、Scenario、Eval、System Rules 的隔离边界。
- `04_ACCEPTANCE_GATES.md`：工程、回复质量、展示与证据验收门槛。
- `05_SHOWCASE_SCRIPT_3MIN.md`：三分钟面试演示脚本。
- `assets/current-knowledge-baseline.csv`：当前 80 条知识的审查基线。
- `assets/knowledge-patch-plan.csv`：需要调整的知识项。
- `assets/no-answer-topics.json`：故意不内置答案的安全拒答主题。
- `assets/showcase-scenarios.json`：四个主场景与一个可选场景。
- `assets/showcase-evidence-map.json`：每个场景应展示的 Trace 与证据。
- `assets/showcase-copy.md`：展示页精简文案。
- `prerequisite/Q0.1.md`：上一轮产品级质量收口指令副本。

## 重要边界

- 不接真实抖音私有接口。
- 不把 Eval 标准答案塞进 RAG。
- 不硬编码 AI 回复结果。
- 不用假指标填满 Dashboard。
- 不把 Fixture 图片描述成真实多模态准确率。
- 不把库存、价格、订单、物流、上下架状态写入长期知识。
