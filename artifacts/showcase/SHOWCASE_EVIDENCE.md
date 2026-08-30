# Guided Showcase Evidence

Generated from the connected local stack on 2026-08-31. All four scenarios were executed by `e2e/showcase.spec.ts` against the running NestJS API, PostgreSQL/pgvector, Redis, MinIO, WebSocket and MockDouyinAdapter. No final reply is stored in the scenario fixture.

## Runtime boundary

- Chat provider/model: DeepSeek / `deepseek-v4-flash` (server-side key file outside the repository).
- Commerce transport: MockDouyinAdapter; no real Douyin credentials or API.
- Data: synthetic MIA Fashion / Pixel Tech fixtures in a dedicated `aikefu_showcase_workspace_token` session.
- Image: `AICS_FIXTURE:DAMAGED_SLEEVE` pipeline fixture; not a claim of real visual-model accuracy.
- Trace: opt-in, structured and redacted; prompts and chain-of-thought are never returned.

## SC-01 · 商品知识有据回答 — PASS

- Input: `fashion_hoodie` product card; “这个可以放烘干机吗？”
- Task/context: `PRODUCT_QUERY`; resolved `fashion_hoodie` ProductContext.
- Evidence: PRODUCT knowledge `k033` (or its persisted version), ENABLED + READY.
- Mode/delivery: AUTO; SendGuard accepted, SendOutbox reached SENT, receipt projected to a buyer-visible Message.
- Consumer reply assertion: contains the meaning “不建议烘干”; does not claim high-temperature drying is allowed.
- Screenshot: `01-product-care.png`.

## SC-02 · 连续消息与多轮上下文 — PASS

- Input: product card; “黑色有吗？” / “XL呢？” / “我165，55公斤，想穿宽松一点。”; then “那白色呢？”.
- Task/context: `INVENTORY_QUERY` + `SIZE_RECOMMENDATION`; the first three raw text messages are observed as one UserTurn; live SKU inventory and recent-message/product context are used.
- Evidence/support: product knowledge `k011` / `k032` plus live Product/SKU context and `preferred_fit` memory.
- Mode/delivery: ASSIST; a real AI Draft is created for human confirmation, so no draft is represented as a sent consumer message.
- Result assertion: the follow-up inherits the selected product and does not repeat the superseded black-colour question.
- Screenshot: `02-multi-turn.png`.

## SC-03 · 生成中补充信息 — PASS

- Input: “今天下单什么时候发货？” followed during generation by “我是新疆的。”
- Task/context: shipping policy; contextVersion advances and the old ReplyJob becomes STALE/CANCELLED.
- Evidence: replacement plan uses remote-region STORE knowledge `k002` (or its persisted version).
- Mode/delivery: the stale answer does not enter a deliverable outbox; the new reply passes SendGuard.
- Consumer reply assertion: contains the remote-region / actual-logistics meaning and never guarantees 24-hour arrival.
- Screenshot: `03-stale-replan.png`.

## SC-04 · 图片售后与人工接管 — PASS

- Input: `order_004` order card; damaged-sleeve pipeline fixture; “收到就是这样的，我要退款并投诉。”
- Tasks/context: `AFTER_SALES_QUERY`, `REFUND_REQUEST`, `COMPLAINT`; order context is scoped to the same Workspace/Tenant/Shop/Buyer.
- Evidence/support: after-sales knowledge `k008` / `k015`; sanitized image observation is marked Fixture.
- Mode/delivery: MANUAL; AI creates no automatic customer send after takeover.
- Consumer reply assertion: no claim that refund or complaint handling has already completed.
- Screenshots: `04-image-human.png`, `developer-trace.png`.

## Isolation, responsive and dashboard — PASS

- Showcase, operational and Scenario Lab local session tokens are distinct; Showcase reset leaves the operational token unchanged.
- 1440×900 scenario views and 390×844 compact buyer/store tabs have no global horizontal overflow and no console error/warning/pageerror.
- `dashboard-after-run.png` is generated only after a real isolated operational buyer message; the dashboard observes at least one persisted conversation rather than a fabricated trend.
- Full focused result: 7/7 Playwright tests passed.

## Quality reports

- Fixed suite: Offline 36/36; DeepSeek 36/36.
- Independent AUTO suite: Offline 10/10; DeepSeek 10/10.
- Reports: `artifacts/eval/reply-eval-*-latest.{json,md}` and `artifacts/eval/reply-auto-eval-*-latest.{json,md}`.

## Honest limitations

These results cover frozen synthetic cases and the local single-API-instance demo. They do not prove open-domain accuracy, real commerce integration, public hosting, production SLA, multi-instance transport fencing, external embedding quality, external multimodal accuracy or a completed three-minute recording.
