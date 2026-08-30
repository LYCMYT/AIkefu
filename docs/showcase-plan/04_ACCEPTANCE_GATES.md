# 04｜Acceptance Gates

## Gate A｜Q0.1 前置质量

未通过以下 Gate 时不得开始展示包装：

- Receipt Projection Recovery 回归测试通过；
- 全量 Integration 0 fail；
- KNOWLEDGE_EXTRACT Prompt/Schema 一致；
- SUMMARY Prompt/Schema 一致；
- Prompt Example Contract Test 通过；
- E017 无依据回答无关政策必须 FAIL；
- E010 不返回无关商品候选；
- E014/E015/E016 消费者人工文案合格；
- E034 重复澄清必须 FAIL；
- AUTO Suite 能真正走 SendGuard → SendOutbox → Receipt → Buyer Message。

## Gate B｜Demo Knowledge

- Seed 仍为 2 店 / 4 买家 / 10 商品 / 10 订单 / 80 知识；
- 两店知识各 40；
- 动态事实泄漏为 0；
- 四个 Showcase 场景所需知识均为 ENABLED+READY；
- no-answer topics 无正向知识；
- Eval 与 Runtime Knowledge 无非法泄漏；
- `k019/k027/k055/k075` 按 patch plan 修正；
- 知识管理页面可查看来源、范围、状态和索引状态。

## Gate C｜Showcase 功能

- `/showcase` 可以直接访问；
- Showcase Workspace 与 operational/scenario 隔离；
- Reset 只影响 Showcase；
- 四个主场景由真实 API/WebSocket 执行；
- 不硬编码最终回复；
- Trace 默认关闭且可展开；
- Real/Offline/Fixture Provider 状态明确标识；
- 失败场景展示真实失败，不伪造成功；
- 运行后 Dashboard 有真实数据；
- 1440×900 和 1366×768 无整体横向溢出。

## Gate D｜四个场景

### 1. Product Care

- 解析 `fashion_hoodie`；
- Evidence 包含 `k033` 或其真实版本；
- 回复包含“不建议烘干”语义；
- 不包含“可以高温烘干”；
- Buyer 真实看到消息。

### 2. Multi-turn

- 三条短消息形成一个 UserTurn；
- Task 含 INVENTORY_QUERY + SIZE_RECOMMENDATION；
- 库存来自 ProductContext；
- “那白色呢”继承当前商品上下文；
- 不重复回答已被覆盖的黑色诉求。

### 3. Stale/Replan

- 旧 ReplyJob 进入 STALE/CANCELLED；
- 旧普通 24 小时文案未发送；
- 最终 Evidence 使用偏远地区知识；
- SendGuard 记录上下文变化原因。

### 4. Image/Human

- 图片绑定当前 Conversation；
- Fixture 与 Real Multimodal 标识正确；
- 风险进入 MANUAL；
- AI 不声称退款已完成；
- 人工接管后 AI 不自动发送。

## Gate E｜测试

至少新增/更新：

```text
workspace-session showcase isolation test
showcase route test
showcase runner model test
knowledge seed invariant test
no-answer leakage test
dynamic fact leakage test
four showcase E2E tests
reset isolation E2E
real/offline label E2E
```

最终执行：

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

任何 FAIL、SKIPPED、BLOCKED 必须单独列出，不能写成 PASS。

## Gate F｜交付证据

生成：

```text
artifacts/showcase/showcase-overview.png
artifacts/showcase/01-product-care.png
artifacts/showcase/02-multi-turn.png
artifacts/showcase/03-stale-replan.png
artifacts/showcase/04-image-human.png
artifacts/showcase/developer-trace.png
artifacts/showcase/dashboard-after-run.png
artifacts/showcase/SHOWCASE_EVIDENCE.md
```

截图必须来自真实运行页面。
