# AIkefu 3 分钟 Showcase 视频方案

本视频使用当前系统可运行的 Showcase 六场景、两段真实产品界面浏览器导览、真实 Scenario Lab 状态和脱敏 Trace；不伪造回复、指标或平台能力。

## 固定规格

- 时长：180 秒（最终技术误差 ±0.2 秒）
- 画面：1920×1080，16:9，30 fps，H.264
- 音频：AAC；在线微软神经语音 `zh-CN-XiaoxiaoNeural`，语速 `+50%`
- 字幕：同一份短句级 SRT 同时作为外部文件和 FFmpeg 硬烧录层；MP4 不嵌入会被部分播放器自动开启、导致双字幕的软字幕轨
- 硬字幕：底部安全区，左右至少 96px、底部至少 84px，最多两行，微软雅黑带描边
- 入口：`/showcase?recording=1`
- Provider：录制器读取页面真实模式；REAL 且页面显示 DeepSeek 才记 DeepSeek，OFFLINE 记“离线确定性Provider”，UNAVAILABLE 直接阻断
- 数据：独立 Showcase Workspace；Scenario Lab 总览使用另一个独立 Scenario Workspace，本次实际运行 8 个 Case 并等待终态
- 导览：`08`、`09` 仅在录制浏览器上下文中复用同一合成 Showcase Workspace，以展示已有店铺、知识、Workflow 和运营状态；token 不写入文件、清单或日志
- 平台：MockDouyin，不连接真实抖音
- 图片：Pipeline Fixture，只说明管线，不宣称视觉准确率
- 源片合同：对有后续淡化的章节，剪辑器输入目标为“章节时长 + 0.2 秒”；普通浏览器片段只允许完整保留终态并以最高 1.25x 加速，短缺超过 0.2 秒直接阻断重录

## 时间线

| 时间 | 内容 | 必须出现的真实证据 |
| --- | --- | --- |
| 00:00–00:05 | 开场 | Provider、MockDouyin、合成数据、Fixture 边界 |
| 00:05–00:14.30 | SC01 商品知识 | ProductContext、Evidence、AUTO、SendGuard、SENT |
| 00:14.30–00:29.30 | SC02 多轮上下文 | Raw Message → UserTurn、商品与偏好延续、ASSIST 草稿 |
| 00:29.30–00:38.80 | SC03 Stale/Replan | contextVersion、旧 ReplyJob 失效且未投递、偏远地区知识 |
| 00:38.80–00:47.40 | SC04 图片售后 | 订单卡、图片 Fixture、风险识别、MANUAL、不执行退款 |
| 00:47.40–00:54.64 | SC05 安全问候 | 低风险安全边界、真实状态留痕、可转人工 |
| 00:54.64–01:06.44 | SC06 AI 暂停/恢复 | 暂停后停止发送、恢复后只处理新消息、真实状态留痕 |
| 01:06.44–01:43.24 | 真实工作台与运营导览 | 同一 Showcase Workspace 的工作台、会话/商品上下文、店铺切换、运营总览真实快照 |
| 01:43.24–02:23.70 | 真实知识与 Workflow 导览 | 正式/候选/冲突/学习任务视图，以及 Workflow 列表、画布和本次状态 |
| 02:23.70–02:44 | Scenario Lab 快速总览 | 当前独立 Scenario Workspace 本次实际运行 8/8 个固定 Case 后的结果 |
| 02:44–02:52 | Developer Trace | Raw Message → UserTurn → TaskBundle → Context → Evidence → Policy → SendGuard → Receipt |
| 02:52–03:00 | 结束页 | Evidence 驱动、Human-in-the-loop、Durable Recovery、真实边界 |

章节边界使用约 0.2 秒淡化衔接。六个场景不再被拉长到 14–22 秒，而是以自然 raw 时长为准；源片若自然超过目标段，只在 1.05–1.25x 范围内加速，并始终保留最终证据。录制器不通过空等补时长。开场 5 秒、Trace 8 秒、结尾 8 秒可使用轻微镜头缩放；其余补足时长一律来自连续真实浏览器操作。

## 已测 raw 时长与剪辑预算

下表的“输入目标”已包含该章节之后的 0.2 秒淡化重叠。六场景均可完整进入剪辑器，不会触发 `RECORDING_SOURCE_TOO_SHORT`，也不需要以超过 1.25x 的速度截短终态。

| 场景 | 现有 raw 自然时长 | 编辑章节 | 剪辑输入目标 | 最大实际速度 |
| --- | ---: | ---: | ---: | ---: |
| SC01 | 10.20s | 9.30s | 9.50s | 1.074x |
| SC02 | 18.48s | 15.00s | 15.20s | 1.216x |
| SC03 | 10.08s | 9.50s | 9.70s | 1.039x |
| SC04 | 10.44s | 8.60s | 8.80s | 1.186x |
| SC05 | 7.80s | 7.24s | 7.44s | 1.048x |
| SC06 | 13.40s | 11.80s | 12.00s | 1.117x |
| 工作台与运营导览 | 38.16s | 36.80s | 37.00s | 1.031x |
| 知识与 Workflow 导览 | 43.80s | 40.46s | 40.66s | 1.077x |
| Scenario Lab | 20.92s | 20.30s | 20.50s | 1.020x |

新 raw `08-workspace-operations-tour.webm` 和 `09-knowledge-workflow-tour.webm` 分别使用 36.80 秒与 40.46 秒编辑章节。录制脚本会用 ffprobe 检查每段都满足完整源片、最多 1.25x、至多 0.2 秒编码级短缺的合同；两段全程持续导航，不以末帧静止补足。

## 选择器与失败边界

录制器按六个稳定 `scenarioId` 槽位定位场景，并以目录中的精确按钮名称及可选 `SHOWCASE_SCENARIO_SELECTORS` JSON 覆盖作为兼容路径。找不到或无法唯一定位时直接阻断，不猜测或录错场景。

产品导览在新浏览器 context 中先读 Showcase 本地 session，再仅在该 context 内把 `aikefu_showcase_workspace_token` 复制到 `aikefu_operational_workspace_token_v2`。录制器只验证两者相等的布尔结果，绝不输出 token。随后必须等待真实工作台商品/会话、运营指标、知识视图或 Workflow 列表可见；若变成 EMPTY Workspace、出现横向溢出、页面 warning/error 或时长越界，则录制失败。

Scenario Lab 必须在新建的 Scenario Workspace 中依次点击 8 个“运行场景”，等待每个状态进入 `SUCCEEDED`/`FAILED` 终态；任何 Case 未完成或失败都阻断 8/8 总览。

## 交付物

- `artifacts/recording/AIkefu-demo-3min-cn.mp4`（画面可见硬字幕）
- `artifacts/recording/AIkefu-demo-3min-no-voice.mp4`
- `artifacts/recording/AIkefu-demo-thumbnail.png`
- `artifacts/recording/AIkefu-demo-subtitles.srt`
- `artifacts/recording/SUBTITLES_CN.srt`
- `artifacts/recording/VOICEOVER_CN.md`
- `artifacts/recording/SHOT_LIST.md`
- `artifacts/recording/RECORDING_CHECKLIST.md`
- `artifacts/recording/RECORDING_EVIDENCE.md`

成片验证须包含 ffprobe 技术探针和提帧像素/可见性检查，证明硬字幕实际写入画面。不得提交、推送或操作 GitHub；旧 Release 资产只有在用户另行确认后处理。
