export const VIDEO_V2_TARGET_SECONDS = 175;
export const VIDEO_V2_MIN_SECONDS = 172;
export const VIDEO_V2_MAX_SECONDS = 178;

export const VIDEO_V2_CLIPS = Object.freeze([
  { id: 'hook', file: '00-hook.webm', start: 0, end: 8, focus: 'buyer', scenarioId: null },
  { id: 'evidence-auto', file: '01-evidence-auto.webm', start: 8, end: 34, focus: 'evidence', scenarioId: 'SC-01-PRODUCT-CARE' },
  { id: 'multi-turn', file: '02-multi-turn.webm', start: 34, end: 59, focus: 'turn', scenarioId: 'SC-02-MULTI-TURN' },
  { id: 'stale-replan', file: '03-stale-replan.webm', start: 59, end: 96, focus: 'stale', scenarioId: 'SC-03-STALE-REPLAN' },
  { id: 'human-handoff', file: '04-human-handoff.webm', start: 96, end: 120, focus: 'risk', scenarioId: 'SC-04-IMAGE-HUMAN' },
  { id: 'quality-regression', file: '05-quality-regression.webm', start: 120, end: 140, focus: 'quality', scenarioId: null },
  { id: 'trace-closing', file: '06-trace-closing.webm', start: 140, end: 175, focus: 'trace', scenarioId: 'SC-01-PRODUCT-CARE' },
]);

export const VIDEO_V2_CUES = Object.freeze([
  { start: 0.3, end: 7.6, subtitle: '从“会回答”到“敢发送”', narration: 'AIkefu 不只生成答案，更判断这条答案能不能安全发送。' },
  { start: 8.2, end: 14.2, subtitle: '商品问题先绑定真实上下文', narration: '买家先发送商品卡，问题绑定具体商品，不靠聊天文本猜对象。' },
  { start: 14.4, end: 20.5, subtitle: '检索冻结的商品 Evidence', narration: '系统检索商品知识，并把命中版本冻结为 Reply Evidence。' },
  { start: 20.7, end: 27.5, subtitle: '有依据，策略才允许 AUTO', narration: '只有证据充分、风险可控，策略才允许进入 AUTO。' },
  { start: 27.7, end: 33.7, subtitle: 'SendGuard 通过，买家收到回复', narration: 'SendGuard 复核上下文后外发，买家收到不建议烘干的回复。' },
  { start: 34.2, end: 40.0, subtitle: '三条短消息，不应回复三次', narration: '黑色、XL、身高体重，不应该触发三次互相打断的回复。' },
  { start: 40.2, end: 46.7, subtitle: '3 Raw Messages\n→ 1 UserTurn', narration: 'Turn Buffer 合并连续输入，再统一规划库存和尺码任务。' },
  { start: 46.9, end: 52.7, subtitle: '后续“白色”继承同一商品', narration: '买家继续问白色，系统继承同一商品上下文。' },
  { start: 52.9, end: 58.7, subtitle: '知识不足时只生成 ASSIST 草稿', narration: '尺码知识不足时只生成 ASSIST 草稿，不冒充已发送消息。' },
  { start: 59.2, end: 65.2, subtitle: '旧回复生成中，买家补充新疆', narration: '旧回复生成中，买家补充了会改变物流答案的新疆信息。' },
  { start: 65.4, end: 71.8, subtitle: 'contextVersion N → N+1', narration: '新消息提交后，contextVersion 立即增加。' },
  { start: 72.0, end: 78.5, subtitle: 'GENERATING → STALE', narration: '旧 ReplyJob 转为 STALE，持久状态拒绝它继续发送。' },
  { start: 78.7, end: 84.4, subtitle: 'OLD REPLY\nNOT DELIVERED', narration: '数据库证明旧任务没有可投递 Outbox，也没有买家可见消息。' },
  { start: 84.6, end: 90.4, subtitle: '重新规划偏远地区 Evidence', narration: '新的 UserTurn 重新检索偏远地区 Evidence。' },
  { start: 90.6, end: 95.7, subtitle: '新回复通过 SendGuard 与回执', narration: '新回复通过 SendGuard 和回执，再投影到买家端。' },
  { start: 96.2, end: 102.0, subtitle: '订单卡 + 破损图片 Fixture', narration: '售后输入包含订单卡、破损图片 Fixture 和退款投诉。' },
  { start: 102.2, end: 108.8, subtitle: 'AFTER_SALES · REFUND\n· COMPLAINT', narration: '系统识别售后、退款和投诉，并绑定订单上下文。' },
  { start: 109.0, end: 114.5, subtitle: '高风险策略强制 MANUAL', narration: '退款执行属于高风险动作，必须转人工。' },
  { start: 114.7, end: 119.7, subtitle: '消费者只看到自然接管提示', narration: '消费者只看到接管提示，系统没有声称退款完成。' },
  { start: 120.3, end: 126.0, subtitle: '真实回归：你们支持线下试穿吗？', narration: '真实 E017 回归问题是：你们支持线下试穿吗？' },
  { start: 126.2, end: 131.7, subtitle: '旧失败：用退货政策回答试穿', narration: '旧失败用退货政策回答试穿，相关但没有回答问题。' },
  { start: 131.9, end: 136.5, subtitle: 'Gate：无证据，且没有回答问题', narration: '两个 Gate 捕获它：无证据，而且没有回答问题。' },
  { start: 136.7, end: 139.7, subtitle: '当前结果：安全转人工确认', narration: '当前结果不编造支持，安全转人工确认。' },
  { start: 140.3, end: 145.0, subtitle: 'Trace 只展示结构化脱敏证据', narration: 'Trace 只展示结构化脱敏证据，不返回 Prompt 或思维链。' },
  { start: 145.2, end: 151.0, subtitle: 'Raw Message → UserTurn\n→ TaskBundle', narration: 'Raw Message 进入 UserTurn，再形成 TaskBundle。' },
  { start: 151.2, end: 157.2, subtitle: 'Context → Evidence\n→ Policy', narration: 'Context 绑定实体，Evidence 固化依据，Policy 决定模式。' },
  { start: 157.4, end: 162.2, subtitle: 'SendGuard / Receipt\n闭合发送链路', narration: 'SendGuard 和 Receipt 闭合可靠发送链路。' },
  { start: 162.5, end: 169.0, subtitle: 'AIkefu', narration: '有依据时自动处理，不确定时安全交给人。' },
  { start: 169.2, end: 174.7, subtitle: 'DeepSeek · Hybrid RAG\nHuman-in-the-loop', narration: '演示使用 DeepSeek 和 Hybrid RAG，平台与业务数据均为模拟。' },
]);

export function validateVideoV2Spec() {
  if (VIDEO_V2_CLIPS.length !== 7) throw new Error(`VIDEO_V2_CLIP_COUNT:${VIDEO_V2_CLIPS.length}`);
  let cursor = 0;
  for (const clip of VIDEO_V2_CLIPS) {
    if (clip.start !== cursor || clip.end <= clip.start) throw new Error(`VIDEO_V2_CLIP_BOUNDARY:${clip.id}`);
    cursor = clip.end;
  }
  if (cursor !== VIDEO_V2_TARGET_SECONDS) throw new Error(`VIDEO_V2_DURATION:${cursor}`);
  const stale = VIDEO_V2_CLIPS.find((clip) => clip.id === 'stale-replan');
  const business = VIDEO_V2_CLIPS.filter((clip) => ['evidence-auto', 'multi-turn', 'stale-replan', 'human-handoff'].includes(clip.id));
  if (!stale || business.some((clip) => clip.id !== stale.id && clip.end - clip.start >= stale.end - stale.start)) throw new Error('VIDEO_V2_STALE_NOT_LONGEST');
  for (let index = 0; index < VIDEO_V2_CUES.length; index += 1) {
    const cue = VIDEO_V2_CUES[index];
    if (cue.start < 0 || cue.end > VIDEO_V2_TARGET_SECONDS || cue.end <= cue.start) throw new Error(`VIDEO_V2_CUE_BOUNDARY:${index + 1}`);
    if (index > 0 && cue.start < VIDEO_V2_CUES[index - 1].end) throw new Error(`VIDEO_V2_CUE_OVERLAP:${index + 1}`);
    const lines = cue.subtitle.split('\n');
    if (lines.length > 2 || lines.some((line) => [...line].length > 22)) throw new Error(`VIDEO_V2_CUE_LENGTH:${index + 1}`);
  }
  return true;
}
