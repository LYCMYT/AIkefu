# AIkefu Video V2 Shotlist

| Clip | 时间 | Focus | 真实动作 | 视觉结果 |
|---|---:|---|---|---|
| `00-hook.webm` | 0–8s | buyer | 打开同一 Showcase Workspace 的 Buyer + Workbench | 首屏直接看到问题与回复链 |
| `01-evidence-auto.webm` | 8–34s | buyer → evidence | 商品卡 + “这个可以放烘干机吗？” | Evidence、AUTO、SendGuard、消费者收到回复 |
| `02-multi-turn.webm` | 34–59s | turn | 黑色、XL、身高体重三条消息，再问白色 | 3→1 UserTurn、同商品继承、ASSIST Draft |
| `03-stale-replan.webm` | 59–96s | stale | 发货问题生成中补充“我是新疆的” | N→N+1、STALE、NOT DELIVERED、REPLAN、新证据与新回复 |
| `04-human-handoff.webm` | 96–120s | risk | 订单卡 + 破损图 Fixture + 退款投诉 | AFTER_SALES / REFUND / COMPLAINT → HIGH RISK → MANUAL |
| `05-quality-regression.webm` | 120–140s | quality | 运行 E017“你们支持线下试穿吗？” | 旧 false positive、NO_EVIDENCE、当前安全结果 |
| `06-trace-closing.webm` | 140–175s | trace | 打开脱敏 Trace，随后浅色 Closing | 七阶段链路与诚实边界 |

每个场景都必须保留 `input → mechanism → outcome`，并在编辑清单中记录精确 in/out、字幕与旁白范围。
