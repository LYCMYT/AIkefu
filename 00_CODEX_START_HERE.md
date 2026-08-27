# Codex 从这里开始

你将开发一套 **Web-first 电商 AI 智能客服 Demo**。这是一个 Clean-room 重构项目：产品需求来自用户对过往项目的回忆、参考产品截图以及静态逆向总结；不得复制任何私有接口、源码、凭据、内部模块或反自动化逻辑。

## 一、必须先阅读

按顺序阅读：

1. `docs/01_PRD_V2_FROZEN.md`
2. `docs/02_SCOPE_AND_SOURCE_BOUNDARIES.md`
3. `docs/04_SYSTEM_ARCHITECTURE.md`
4. `docs/05_DOMAIN_MODEL_DATABASE.md`
5. `docs/06_STATE_MACHINES.md`
6. `docs/07_MESSAGE_PIPELINE_CONCURRENCY.md`
7. `docs/08_AI_RUNTIME_CONTEXT_RAG.md`
8. `docs/09_PRODUCT_LEARNING_KNOWLEDGE.md`
9. `docs/10_WORKFLOW_ENGINE.md`
10. `docs/11_API_WEBSOCKET_CONTRACTS.md`
11. `docs/12_SCENARIO_LAB.md`
12. `docs/13_TEST_ACCEPTANCE.md`
13. `docs/15_IMPLEMENTATION_ROADMAP.md`
14. `docs/16_DECISION_LOG.md`

接口和数据草案位于 `specs/`。Seed 与 Eval 位于 `seed/`。

## 二、开发方式

- 使用 pnpm workspace 或同等 Monorepo。
- 建议目录：
  - `apps/web`
  - `apps/api`
  - `packages/contracts`
  - `packages/core`
  - `packages/ai-runtime`
  - `packages/knowledge`
  - `packages/workflow`
  - `packages/mock-douyin`
- 每个阶段先写实现计划，再写测试，再实现。
- 不允许一次性输出整套系统而不验证。
- 每阶段结束必须：
  1. 运行 typecheck；
  2. 运行单元测试；
  3. 运行集成测试；
  4. 更新 `PROGRESS.md`；
  5. 记录未完成项和已知风险。

## 三、冲突优先级

当文档之间出现冲突时：

```text
docs/16_DECISION_LOG.md
>
docs/01_PRD_V2_FROZEN.md
>
其他设计文档
>
specs 下的草案
```

若仍无法判断，停止实现并向用户提问，不要自行扩大范围。

## 四、明确不做

- 真实平台登录与真实抖音 API
- Cookie / Token 导出或注入
- 10 个平台的真实适配
- 真实退款、打款、补偿
- 完整套餐支付
- 多人工客服抢单和分配
- Shop AI Readiness Gate
- 自动质检
- 自动长期 CustomerMemory 提取
- 完整 Output Guard
- 公平调度器
- 完整 AIConfigVersion 发布后台
- 导入批次整体回滚
- 售后事件实时模拟
- Electron V1

## 五、质量门槛

以下机制必须是真实实现，不可用前端假动画替代：

- Transactional Processing Outbox
- SendOutbox
- Persistent TurnBuffer
- Reorder Buffer
- ReplyJob stale / abort / coalescing
- Multi-shop isolation
- Hybrid RAG
- Product learning
- Context Resolver
- TaskBundle
- AUTO / ASSIST / MANUAL
- Knowledge index state
- Recovery Worker
- Developer Trace
- 8 个 Scenario Lab 场景

## 六、第一步

执行 `codex/PHASE_01_FOUNDATION.md`。完成并验证后，再进入下一阶段。
