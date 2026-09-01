# AIkefu 求职展示视频 V2 Master Spec

## 定位

V2 是 175 秒、求职展示优先的真实业务短片。它不做后台功能巡览，而是用 Buyer、Workbench、Evidence、策略降级与可靠消息链证明：AIkefu 只有在有依据时才自动发送，不确定或高风险时交给人。

不可改变的边界：DeepSeek 文本模型、MockDouyinAdapter、Synthetic Data、图片 Pipeline Fixture、结构化脱敏 Trace、真实 API/DB/Redis/WebSocket/Reply Runtime/SendGuard。不得伪造最终回复、STALE、Evidence、Mode 或 Receipt。

## 175 秒结构

| 时间 | 段落 | 核心结果 |
|---|---|---|
| 0:00–0:08 | Hook | Buyer + Workbench；“从会回答到敢发送” |
| 0:08–0:34 | SC-01 Evidence AUTO | Product → Evidence → AUTO → SendGuard → Sent |
| 0:34–0:59 | SC-02 Multi-turn | 3 Raw Messages → 1 UserTurn；后续指代继承；ASSIST Draft |
| 0:59–1:36 | SC-03 STALE / REPLAN | contextVersion 墠、旧回复 NOT DELIVERED、远区证据、新回复 |
| 1:36–2:00 | SC-04 Human Handoff | Order + damage Fixture + refund complaint → MANUAL |
| 2:00–2:20 | Quality Regression | E017 线下试穿 false positive → NO_EVIDENCE → safe handoff |
| 2:20–2:40 | Developer Trace | Raw / Turn / Tasks / Context / Evidence / Policy / Guard+Receipt |
| 2:40–2:55 | Closing | 浅色产品风格与真实能力边界 |

## 录制与剪辑

- 路由使用 `/showcase?recording=v2&focus=<state>`，只改变展示层。
- Focus State：`buyer`、`evidence`、`turn`、`stale`、`risk`、`quality`、`trace`。
- 七段独立 WebM；每段运行前恢复确定状态，并保留真实等待与结果。
- 全片至少 60% 为局部业务特写；任何全屏后台连续不超过 7 秒。
- 转场只使用 hard cut 或 120–180ms crossfade；局部 push-in 限 110–125%。
- 旁白使用自然中文在线神经语音；目标 260–300 汉字/分钟。系统低质量 TTS 只能标为 draft。
- 字幕 1–2 行，单行不超过 22 个汉字，底部安全边距至少 64px，不遮挡关键证据。

## 交付

必须生成视觉母版、无旁白版、语音版（质量合格时才命名 final）、七段 raw、Shotlist、Voiceover、SRT、Edit Manifest、Evidence、Contact Sheet 与 Thumbnail。35 条 Gate 全通过后，才可标记 `VIDEO_V2_9PLUS_TARGET_READY = YES`。
