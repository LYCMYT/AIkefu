# Guided Showcase Evidence

Generated from the connected local stack on 2026-08-31. All six catalog scenarios were executed through the real Showcase path against the running NestJS API, PostgreSQL/pgvector, Redis, MinIO, WebSocket and MockDouyinAdapter. Scenario fixtures contain inputs and assertions, not final customer replies.

## Runtime boundary

- Chat provider/model: DeepSeek / `deepseek-v4-flash` (server-side key file outside the repository).
- Commerce transport: MockDouyinAdapter; no real Douyin credentials or API.
- Data: synthetic MIA Fashion / Pixel Tech fixtures in a dedicated `aikefu_showcase_workspace_token` session.
- Image: `AICS_FIXTURE:DAMAGED_SLEEVE` pipeline fixture; not a claim of real visual-model accuracy.
- Trace: opt-in, structured and redacted; prompts and chain-of-thought are never returned.

## SC-01 · 商品知识有据回答 — PASS

- Input: `fashion_hoodie` product card; “这个可以放烘干机吗？”
- Task/context: `PRODUCT_QUERY`; resolved `fashion_hoodie` ProductContext.
- Evidence: the EVIDENCE trace carries immutable item/version/scope/product references for the PRODUCT evidence used by this reply; validation does not depend on a later mutable knowledge projection.
- Mode/delivery: AUTO; SendGuard accepted, SendOutbox reached SENT, and the receipt was projected to a buyer-visible Message.
- Consumer reply assertion: contains the meaning “不建议烘干”; does not claim high-temperature drying is allowed.
- Screenshot: `01-product-care.png`.

## SC-02 · 连续消息与多轮上下文 — PASS

- Input: product card; “黑色有吗？” / “XL呢？” / “我165，55公斤，想穿宽松一点。”; then “那白色呢？”.
- Task/context: `INVENTORY_QUERY` + `SIZE_RECOMMENDATION`; the first three raw text messages are observed as one UserTurn, and the follow-up inherits the selected `fashion_hoodie` product context.
- Evidence: EVIDENCE ran and truthfully reported zero knowledge evidence for the dynamic inventory/size request; live Product/SKU and recent-message context are not misrepresented as static knowledge evidence.
- Mode/delivery: ASSIST; the system produced a truthful `WAITING_HUMAN` fallback Draft rather than inventing a supported answer or presenting the draft as sent.
- Result assertion: short-message aggregation and product-context inheritance are preserved while the unsupported answer remains human-confirmed.
- Screenshot: `02-multi-turn.png`.

## SC-03 · 生成中补充信息 — PASS

- Input: “今天下单什么时候发货？” followed during generation by “我是新疆的。”
- Assertion boundary: the context version advances, the old ReplyJob becomes stale/cancelled, and the superseded reply does not enter a deliverable outbox or reach the buyer.
- This scenario does not claim a particular replacement knowledge item, replacement answer or new send receipt.
- Screenshot: `03-stale-replan.png`.

## SC-04 · 图片售后与人工接管 — PASS

- Input: `order_004` order card; damaged-sleeve pipeline fixture; “收到就是这样的，我要退款并投诉。”
- Tasks/context: `AFTER_SALES_QUERY`, `REFUND_REQUEST`, `COMPLAINT`; order context is scoped to the same Workspace/Tenant/Shop/Buyer.
- Evidence/support: the sanitized image observation is explicitly marked Fixture; it is not presented as external multimodal-model proof.
- Mode/delivery: MANUAL / human takeover; AI creates no automatic customer send after takeover.
- Consumer reply assertion: no claim that the refund, complaint or other irreversible action has already completed.
- Screenshots: `04-image-human.png`, `developer-trace.png`.

## SC-05 · 安全问候，无需知识也可自然回复 — PASS

- Input: “你好！”
- Task/context: `SAFE_SOCIAL_GREETING`; no business knowledge evidence is required or fabricated.
- Mode/delivery: AUTO through the safe built-in reply path; SendGuard accepted and the Outbox receipt reached SENT.
- Consumer reply assertion: contains the natural greeting meaning “您好，我在的”.
- Screenshot: `05-safe-greeting.png`.

## SC-06 · 店铺 AI 关闭后只处理未来消息 — PASS

- Input/state: switch the shop to `MANUAL_ONLY`, send a message while AI is off, re-enable `AUTO_ALLOWED`, then send a new greeting.
- AI-off assertion: the disabled-period message creates no AI ReplyJob, Draft or Outbox artifact.
- Recovery assertion: re-enabling AI does not backfill the disabled-period message; only the new future message enters the reply pipeline.
- Future-message delivery: the new safe greeting reaches AUTO / SENT.
- Screenshot: `06-ai-off-future-message.png`.

## Screenshot inventory

- Six scenario screenshots: `01-product-care.png` through `06-ai-off-future-message.png`, each 1440×900 and generated from the latest real run.
- Supporting views: `developer-trace.png`, `dashboard-after-run.png`, `showcase-overview.png` and `showcase-mobile-390x844.png`.
- Showcase, operational and Scenario Lab local session tokens are distinct; Showcase reset leaves the operational token unchanged.
- The 1440×900 scenario views and 390×844 compact buyer/store tabs have no global horizontal overflow and no console error, warning or page error in the verified Playwright paths.
- `dashboard-after-run.png` is generated only after a real isolated operational buyer message; the dashboard observes persisted data rather than a fabricated trend.

## Playwright verification

- Collected: 27 unique Playwright tests.
- Real-infrastructure mode: 23 passed, 4 mode-gated skipped, 0 failed.
- Offline/default mode: 6 passed, 21 mode-gated skipped, 0 failed.
- Focused Showcase business coverage: `e2e/showcase.spec.ts` contributes 11 real tests and `e2e/showcase-scenario-expansion.spec.ts` contributes 2, for 13/13 passing real business tests.
- All six catalog scenarios passed. Skips above are explicit environment-mode gates, not reported as passes.

## Reply quality reports

- Fixed production suite: Offline 36/36; DeepSeek 36/36.
- Independent AUTO production suite: Offline 10/10; DeepSeek 10/10.
- Reports: `artifacts/eval/reply-eval-production_*-latest.{json,md}` and `artifacts/eval/reply-auto-eval-production_*-latest.{json,md}`.

## Three-minute video — v1.1.0-demo Release

- Release: [`v1.1.0-demo`](https://github.com/LYCMYT/AIkefu/releases/tag/v1.1.0-demo).
- Video: [`aikefu-3min-demo.mp4`](https://github.com/LYCMYT/AIkefu/releases/download/v1.1.0-demo/aikefu-3min-demo.mp4).
- Media: exactly 180 seconds, 1920×1080, 30 fps, H.264 High video and AAC-LC 48 kHz stereo audio.
- Voice: XiaoxiaoNeural at `+50%` rate.
- Subtitles: 26 burned-in cues plus the matching external `artifacts/recording/AIkefu-demo-subtitles.srt`; the MP4 intentionally contains no soft-subtitle track.
- SHA256: `E64D832B7C67896424C13FAE785837545B89005BD172E500373CDD4E3564435C`.
- Publication boundary: this Release asset is the public presentation artifact, not a public full-stack deployment, production SLA or real-commerce integration claim.

## Honest limitations

These results cover frozen synthetic cases and the local single-API-instance demo. They do not prove open-domain accuracy, real commerce integration, public full-stack hosting, production SLA, multi-instance transport fencing, external embedding quality or external multimodal accuracy. `v1.1.0-demo` remains Mock-only and Synthetic Data.
