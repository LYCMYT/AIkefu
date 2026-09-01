# AIkefu 求职展示视频 V2 中文旁白母版

- 目标时长：175 秒
- 目标语速：260–300 汉字/分钟
- 当前草稿音色：Microsoft Edge 在线神经语音 `zh-CN-XiaoxiaoNeural`，语速 `+45%`
- 字幕只保留短摘要，不逐字复制旁白
- `artifacts/video-v2/AIkefu-demo-v2-voiceover.md` 与 SRT 由 `scripts/video-v2/spec.mjs` 从本母版口径生成

## 0:00–0:08 Hook

AIkefu 不只生成答案，更判断这条答案能不能安全发送。

## 0:08–0:34 SC-01 Evidence AUTO

买家先发送商品卡，问题绑定具体商品，不靠聊天文本猜对象。系统检索商品知识，并把命中版本冻结为 Reply Evidence。只有证据充分、风险可控，策略才允许进入 AUTO。SendGuard 复核上下文后外发，买家收到不建议烘干的回复。

## 0:34–0:59 SC-02 Multi-turn

黑色、XL、身高体重，不应该触发三次互相打断的回复。Turn Buffer 合并连续输入，再统一规划库存和尺码任务。买家继续问白色，系统继承同一商品上下文。尺码知识不足时只生成 ASSIST 草稿，不冒充已发送消息。

## 0:59–1:36 SC-03 STALE / REPLAN

旧回复生成中，买家补充了会改变物流答案的新疆信息。新消息提交后，contextVersion 立即增加。旧 ReplyJob 转为 STALE，持久状态拒绝它继续发送。数据库证明旧任务没有可投递 Outbox，也没有买家可见消息。新的 UserTurn 重新检索偏远地区 Evidence。新回复通过 SendGuard 和回执，再投影到买家端。

## 1:36–2:00 SC-04 Human Handoff

售后输入包含订单卡、破损图片 Fixture 和退款投诉。系统识别售后、退款和投诉，并绑定订单上下文。退款执行属于高风险动作，必须转人工。消费者只看到接管提示，系统没有声称退款完成。

## 2:00–2:20 Quality Regression

真实 E017 回归问题是：你们支持线下试穿吗？旧失败用退货政策回答试穿，相关但没有回答问题。两个 Gate 捕获它：无证据，而且没有回答问题。当前结果不编造支持，安全转人工确认。

## 2:20–2:40 Developer Trace

Trace 只展示结构化脱敏证据，不返回 Prompt 或思维链。Raw Message 进入 UserTurn，再形成 TaskBundle。Context 绑定实体，Evidence 固化依据，Policy 决定模式。SendGuard 和 Receipt 闭合可靠发送链路。

## 2:40–2:55 Closing

有依据时自动处理，不确定时安全交给人。演示使用 DeepSeek 和 Hybrid RAG，平台与业务数据均为模拟。
