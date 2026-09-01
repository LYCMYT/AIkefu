# AIkefu Video V2 Evidence

- Generated: 2026-09-01T17:32:26.017Z
- Video: AIkefu-demo-v2-tts-draft.mp4
- Duration: 174.933 seconds
- Resolution / FPS: 1920x1080 @ 30/1
- Provider / Commerce / Data: DeepSeek / MockDouyinAdapter / Synthetic Data
- Human voice: NO; online neural voice is labelled TTS draft, not final
- SC03 NOT DELIVERED: real PostgreSQL integration verified old job STALE, no deliverable old outbox, replacement Evidence + SendGuard + Receipt + projected message
- Quality regression: E017 “你们支持线下试穿吗？” false positive; gates NO_EVIDENCE_EXPECTED + USER_QUESTION_NOT_ANSWERED

## 35 quality gates

1. **PASS** — duration=174.933s
2. **PASS** — 1920x1080
3. **PASS** — fps=30/1
4. **PASS** — 首段为 Buyer + Workbench 录制焦点
5. **PASS** — focused=167s/174.9s
6. **PASS** — 剪辑清单不含 Dashboard tour
7. **PASS** — 剪辑清单不含 Workflow editor tour
8. **PASS** — 剪辑清单不含 Scenario Lab tour
9. **PASS** — SC03=37s，最长业务段
10. **PASS** — 字幕与真实 SC03 画面均标识 STALE
11. **PASS** — SC03 显示 OLD REPLY · NOT DELIVERED
12. **PASS** — 真实 PG 集成断言旧 Outbox 不可投递、新回执可投影
13. **PASS** — 四个业务场景均有 input → mechanism → outcome
14. **PASS** — SC01 final reply dwell=6.0s
15. **PASS** — SC04 只陈述 MANUAL，不声称退款完成
16. **PASS** — E017 线下试穿回归由 Seed 与测试共同证明
17. **PASS** — Recording Trace 不展开 Prompt/CoT/Secret/PII
18. **PASS** — 字幕无厚黑描边
19. **PASS** — 字幕仅在 bottom-safe 区域可见：2.27,3.38,3.34,2.47,2.68,3.72,5.17
20. **PASS** — 字幕设计最大两行，估算高度约96px<15%
21. **PASS** — 同屏技术 callout ≤3
22. **PASS** — 不存在全屏后台镜头
23. **PASS** — 8 格 contact sheet 已生成，可做小窗检查
24. **PASS** — 无“准确率100%”
25. **PASS** — 无真实抖音生产接入宣称
26. **PASS** — 无生产 SLA 宣称
27. **PASS** — Recorder 仅在 console/pageerror=0 后写入 manifest
28. **PASS** — 每段完整保留开始、结果与结束 marker，无失败跳切
29. **PASS** — ffmpeg 从头到尾解码成功
30. **PASS** — H.264 / duration / stream 正常
31. **PASS** — TTS draft 29 段按 cue offset 混音
32. **PASS** — TTS draft peak=-5.5dBFS
33. **PASS** — Ending 使用浅色产品式 Closing
34. **PASS** — Contact Sheet 与输出资产存在且内容不重复
35. **PASS** — DeepSeek / MockDouyin / Synthetic / Fixture / Frozen Eval 边界诚实

## SHA256

- `AIkefu-demo-v2-visual-master.mp4`: `418C7357203640D133150992934603F50ABDF4377E571949601BAB70A8AADEA3`
- `AIkefu-demo-v2-no-voice.mp4`: `2CF7EFE7C00FC6F02E9457B479BAD3FC9134A853D7CDD9109100F003F96EDC82`
- `AIkefu-demo-v2-tts-draft.mp4`: `E8BFA8D0E41CBEEDC1F186C3497200BDDF46B682D7BBC0608764F70DF9CEB9DC`
- `VIDEO_V2_CONTACT_SHEET.jpg`: `6EEEEFF57707F4597D5501197F0B4DD3CB1F47A19271D0735A12C274F7B6C088`
- `AIkefu-demo-v2-thumbnail.png`: `29E5C732960717FCA26D11640734E1B4B89F1A5A65379C63335B155D574EC438`

VIDEO_V2_9PLUS_TARGET_READY = YES
