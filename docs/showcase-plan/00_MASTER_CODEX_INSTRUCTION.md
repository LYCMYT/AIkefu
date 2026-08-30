# 00｜Master Codex Instruction

以下内容与 `COPY_THIS_TO_CODEX.txt` 相同，便于在 Markdown 中审阅。

```text
你正在 LYCMYT/AIkefu 仓库中执行“Demo Knowledge + Guided Showcase”产品化任务。

这是一个单窗口连续任务。默认使用 Medium 推理；只有 Receipt Projection Recovery、Outbox 或跨进程恢复根因无法定位时，才临时提高到 High。不要在每个小阶段后停止。

请先将本包复制到仓库 `docs/showcase-plan/`，然后读取：
- AGENTS.md
- README.md
- PROGRESS.md
- docs/16_DECISION_LOG.md
- docs/21_REPLY_QUALITY_Q0.md
- docs/showcase-plan/README_FIRST.md
- docs/showcase-plan/prerequisite/Q0.1.md
- docs/showcase-plan/01_DEMO_KNOWLEDGE_PRODUCT_SPEC.md
- docs/showcase-plan/02_SHOWCASE_EXPERIENCE_SPEC.md
- docs/showcase-plan/03_SEED_FIXTURE_EVAL_BOUNDARIES.md
- docs/showcase-plan/04_ACCEPTANCE_GATES.md
- docs/showcase-plan/assets/*
- 当前 seed、eval、Prompt、Workspace Session、LiveTest、Workbench、Scenario Lab、Trace 和测试代码。

基线审查曾针对 commit 77d2433，但你必须以当前 HEAD 为准，不要假设旧问题仍存在或已经修复。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
一、硬性边界
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 不接真实电商私有接口。
2. 不把 Eval expected facts、forbidden claims 或 judge 结果注入 RAG、Prompt 或 Seed。
3. 不硬编码四个场景的最终 AI 回复。
4. 不用假数据、假准确率或假 Dashboard 指标装饰页面。
5. 不把库存、价格、订单、物流、当前上下架、退款进度写进长期知识。
6. 不删除失败 Case、不放低测试门槛、不把 SKIPPED/BLOCKED 写成 PASS。
7. 不复制新的 Buyer Simulator / Workbench 消息链路；优先复用现有 LiveTestPage、Workbench、REST、WebSocket 和 Scenario Lab。
8. 不新建微服务，不为 Showcase 增加无必要数据库表。
9. 不在真实 Provider 失败时静默伪装成真实成功；Offline/Fixture 必须明确标识。
10. 不 push 远程。允许创建本地分支和本地 commit。

建议创建：
`git checkout -b feat/demo-knowledge-showcase-v1`

开始时只输出最多 10 条执行计划，然后直接实施。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
二、先通过 Q0.1 前置 Gate
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

先运行相关测试并检查当前代码。若以下任一项未完成，先按 `prerequisite/Q0.1.md` 修复，未通过前不得开始 Showcase：

- Receipt Projection Recovery 不再扫描饥饿，Integration 0 fail；
- KNOWLEDGE_EXTRACT Prompt、Type、Validator、Fixture 一致；
- SUMMARY Prompt 的 resolvedFacts 示例可通过 Schema；
- Prompt Contract Test 通过；
- E017 无依据回答无关退货政策必须 FAIL；
- E010 不追问鼠标/充电器等无关商品；
- E014/E015/E016 使用消费者可见人工文案；
- E034 重复澄清必须 FAIL；
- AUTO Suite 真实走 ReplyPolicy → SendGuard → SendOutbox → Receipt → Buyer Message。

不得仅改报告文本或预期来通过。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
三、整理 Demo Knowledge Pack
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

以现有 `seed/seed-data.json` 的 80 条知识为基线，不扩成随机大数据。

必须：

1. 保持 2 店 / 4 买家 / 10 商品 / 10 订单 / 80 知识。
2. 保持两店各 40；每店 STORE=15、PRODUCT=25。
3. 保持 MANUAL=50、AUTO_LEARNED=20、HUMAN_REVIEWED=10，除非现有迁移和测试有明确理由调整，并在报告说明。
4. 按 `assets/knowledge-patch-plan.csv` 修正 k019/k027/k055/k075。
5. 扩展知识静态检查，拦截“当前商品已下架、当前库存、当前售价、订单已发货、当前可售颜色”等动态事实进入 ENABLED+READY RAG。
6. 将 `assets/no-answer-topics.json` 复制为仓库机器可读资产，但不得加载为正向知识。
7. 为 Seed 增加测试：数量、Scope、Source、Product ownership、动态事实、no-answer 和 Eval 泄漏。
8. 确保四个主场景需要的知识均 READY，且 Evidence 可追溯。
9. 不把 Scenario Fixture marker Embedding。
10. 运行知识导入、商品学习和 RAG 相关测试。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
四、实现独立 Showcase Workspace
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 新增静态路由 `/showcase`。
2. 在 `WorkspaceSessionKind` 增加 `showcase`，使用独立 storage key，创建/重置使用 SEEDED profile。
3. Showcase、operational、scenario 三个 Workspace 必须互不覆盖。
4. 增加 session isolation 单元测试和 Reset isolation E2E。
5. 不改变现有 `/workbench`、`/buyer-simulator`、`/scenario-lab` 行为。
6. README 中将公开演示入口写为 `/showcase`，不强制修改根路由；若要修改根路由，必须保持旧路径兼容并更新测试。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
五、实现 Guided Showcase，不重复造消息系统
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

优先复用现有 `LiveTestPage`。可抽取公共 Buyer/Store Pane、Pipeline 和操作组件，再由 `ShowcasePage` 编排。不得复制另一套业务逻辑。

建议新增：

```text
apps/web/src/features/showcase/
  ShowcasePage.tsx
  showcase-model.ts
  showcase-runner.ts
  showcase.css
  components/
```

加载 `assets/showcase-scenarios.json` 对应的仓库运行时版本。场景脚本只定义操作和验收，不包含固定最终回复。

页面要求：

- 顶部：场景 1/4、店铺、AI 模式、Provider 标签、重置、Trace、进入完整产品；
- 左侧：Buyer 端 340–380px；
- 右侧：真实店铺会话、AI Draft/回复、商品订单上下文；
- 底部：接收→聚合→理解→上下文/检索→回复/接管处理管线；
- Developer Trace 默认折叠；
- 说明文字每块最多 1–2 行；
- 1440×900 和 1366×768 无整体横向溢出；
- 小屏用 Buyer/Store tabs。

场景必须按 `assets/showcase-scenarios.json` 实际执行：

1. Product Care：商品卡 + 烘干问题，Evidence 必须是商品知识 k033。
2. Multi-turn：3 条短消息聚合、库存与尺码 Task、后续“那白色呢”。
3. Stale/Replan：生成中补充新疆，旧 Reply 不得发送；优先复用 Scenario Lab driver。
4. Image/Human：破损图片、订单上下文、退款/投诉进入 MANUAL；Fixture/Real 标签必须真实。

可选第五场景只作为“更多演示”，不阻塞 3 分钟主流程。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
六、真实状态与降级
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 每个场景支持 NOT_STARTED/PREPARING/RUNNING/WAITING_AI/WAITING_HUMAN/COMPLETED/FAILED/CANCELLED。
2. API、WebSocket 或 Provider 失败时展示真实错误和重试，不显示预置成功。
3. Real Provider、Offline Demo、Pipeline Fixture 三种来源必须明确标识。
4. Offline Fixture 不能计入真实模型回复质量。
5. 图片 Fixture 页面显示“多模态管线演示（Fixture）”。
6. 场景完成后 Dashboard 使用真实事件；不硬编码趋势和增长率。
7. Incident 必须来自真实标错/失败，不直接 Seed 假事故。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
七、Seed / Fixture / Eval 隔离
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

按 `03_SEED_FIXTURE_EVAL_BOUNDARIES.md` 实现自动测试，特别验证：

- Runtime RAG 不读取 Eval assertion；
- Knowledge 不包含 Eval ID；
- no-answer topics 没有正向知识；
- Fixture marker 不进入 Embedding；
- Developer Trace 内部状态不进入消费者消息；
- Showcase Reset 不影响其他 Workspace。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
八、E2E 与证据
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

至少新增：

- showcase route test；
- showcase workspace session test；
- knowledge seed invariant test；
- no-answer leakage test；
- dynamic fact leakage test；
- 4 个 Showcase E2E；
- Showcase Reset isolation E2E；
- Real/Offline/Fixture label E2E。

最终运行仓库真实支持的：

```text
pnpm security:secrets
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
pnpm test:e2e
pnpm ai:eval:production:offline
pnpm ai:eval:production   # 有真实 Key 时
```

生成真实截图：

```text
artifacts/showcase/showcase-overview.png
artifacts/showcase/01-product-care.png
artifacts/showcase/02-multi-turn.png
artifacts/showcase/03-stale-replan.png
artifacts/showcase/04-image-human.png
artifacts/showcase/developer-trace.png
artifacts/showcase/dashboard-after-run.png
```

生成 `artifacts/showcase/SHOWCASE_EVIDENCE.md`，逐场景记录：

- Provider/Model；
- 输入消息；
- Task；
- Context；
- Evidence；
- Reply mode；
- SendGuard/Receipt；
- 实际消费者回复；
- PASS/FAIL；
- Fixture/Real 标识；
- 真实限制。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
九、最终 Gate
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

逐条对照 `04_ACCEPTANCE_GATES.md`。任何 Gate 未通过必须在 PROGRESS/README 中标明，不得声称完成。

完成后更新：

- README.md；
- PROGRESS.md；
- docs/18_DEMO_SCRIPT.md；
- 当前 Known Limitations；
- 3 分钟演示说明。

最终回复最多 18 行，只写：

1. 当前分支和 commit；
2. Q0.1 Gate 结果；
3. Knowledge Pack 修改；
4. Showcase 页面与场景；
5. Typecheck/Unit/Integration/Build/E2E/Eval；
6. 截图和 Evidence 路径；
7. 仍失败/Blocked/Skipped；
8. 真实 Provider/Fixture 边界。

不要粘贴完整代码或长日志。现在开始执行。

```
