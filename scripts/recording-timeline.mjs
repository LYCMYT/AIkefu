export const RECORDING_TOTAL_SECONDS = 180;
export const INTRO_DURATION_SECONDS = 5;
export const CLOSING_DURATION_SECONDS = 8;
export const SCENE_TRANSITION_SECONDS = 0.2;
export const MAX_SOURCE_SHORTFALL_SECONDS = 0.2;
export const MAX_SCENARIO_PLAYBACK_SPEED = 1.25;
export const MAX_EVIDENCE_DWELL_MS = 1_800;
export const SUBTITLE_MAX_LINE_CHARS = 22;
export const SHOWCASE_VOICE_RATE = '+50%';
export const SUBTITLE_PIXEL_DIFF_THRESHOLD = 0.25;
export const SUBTITLE_PIXEL_CHECK_TIMES = Object.freeze([3, 118, 155.5, 176.5]);

// ffprobe measurements from the six existing raw recordings. The editorial
// chapters below are deliberately budgeted against these values plus the
// builder's 200ms crossfade input overlap; no chapter relies on a long still
// or on clipping the final state.
export const SHOWCASE_SCENARIO_RAW_DURATIONS = Object.freeze({
  sc01: 11.32,
  sc02: 18.36,
  sc03: 9.8,
  sc04: 10.92,
  sc05: 7.52,
  sc06: 13.96,
});

// These are browser recordings of the existing operational product surfaces.
// They are intentionally separate from the six Showcase cases so the recovered
// runtime is spent navigating live Workspace state rather than holding a frame.
export const SHOWCASE_PRODUCT_TOUR_RECORDING_SLOTS = Object.freeze([
  {
    chapter: 'workspace-operations-tour',
    source: 'raw/08-workspace-operations-tour.webm',
    screenshot: '08-workspace-operations-tour.png',
    routes: Object.freeze(['/workbench', '/admin', '/admin/shops', '/workbench']),
    evidence: '真实 Workspace 工作台、店铺切换与运营总览快照',
  },
  {
    chapter: 'knowledge-workflow-tour',
    source: 'raw/09-knowledge-workflow-tour.webm',
    screenshot: '09-knowledge-workflow-tour.png',
    routes: Object.freeze(['/admin/knowledge', '/admin/workflows']),
    evidence: '真实知识治理视图与 Workflow 画布/运行状态',
  },
]);

/**
 * The edit is deliberately authored in one clock. A chapter's `start` and
 * `end` are the editorial clock; the builder adds 200ms of overlap to source
 * clips before applying xfade, so the final output remains 180s.
 */
export const SHOWCASE_VIDEO_TIMELINE = [
  { id: 'intro', start: 0, end: 5, kind: 'intro', source: '00-recording-overview.png' },
  { id: 'sc01', scenarioId: 'SC01', start: 5, end: 14.3, kind: 'scenario', source: 'raw/01-product-care.webm', transition: { type: 'fade', duration: SCENE_TRANSITION_SECONDS } },
  { id: 'sc02', scenarioId: 'SC02', start: 14.3, end: 29.3, kind: 'scenario', source: 'raw/02-multi-turn.webm', transition: { type: 'fade', duration: SCENE_TRANSITION_SECONDS } },
  { id: 'sc03', scenarioId: 'SC03', start: 29.3, end: 38.8, kind: 'scenario', source: 'raw/03-stale-replan.webm', transition: { type: 'fade', duration: SCENE_TRANSITION_SECONDS } },
  { id: 'sc04', scenarioId: 'SC04', start: 38.8, end: 47.4, kind: 'scenario', source: 'raw/04-image-human.webm', transition: { type: 'fade', duration: SCENE_TRANSITION_SECONDS } },
  { id: 'sc05', scenarioId: 'SC05', start: 47.4, end: 54.64, kind: 'scenario', source: 'raw/05-safe-greeting.webm', transition: { type: 'fade', duration: SCENE_TRANSITION_SECONDS } },
  { id: 'sc06', scenarioId: 'SC06', start: 54.64, end: 66.44, kind: 'scenario', source: 'raw/06-ai-pause-recovery.webm', transition: { type: 'fade', duration: SCENE_TRANSITION_SECONDS } },
  { id: 'workspace-operations-tour', start: 66.44, end: 103.24, kind: 'product-tour', browserCapture: true, source: 'raw/08-workspace-operations-tour.webm', transition: { type: 'fade', duration: SCENE_TRANSITION_SECONDS } },
  { id: 'knowledge-workflow-tour', start: 103.24, end: 143.7, kind: 'product-tour', browserCapture: true, source: 'raw/09-knowledge-workflow-tour.webm', transition: { type: 'fade', duration: SCENE_TRANSITION_SECONDS } },
  { id: 'scenario-lab-overview', start: 143.7, end: 164, kind: 'scenario-lab-overview', liveCapture: true, source: 'raw/07-scenario-lab-overview.webm', transition: { type: 'fade', duration: SCENE_TRANSITION_SECONDS } },
  { id: 'trace', start: 164, end: 172, kind: 'trace', source: '05-developer-trace.png', transition: { type: 'fade', duration: SCENE_TRANSITION_SECONDS } },
  { id: 'closing', start: 172, end: 180, kind: 'closing', source: '06-closing.png', transition: { type: 'fade', duration: SCENE_TRANSITION_SECONDS } },
];

export const REQUIRED_SCENARIO_IDS = Object.freeze(['SC01', 'SC02', 'SC03', 'SC04', 'SC05', 'SC06']);
export const DEFAULT_PROVIDER_LABEL = '离线确定性Provider';

// Stable catalog IDs keep the recorder decoupled from visible Showcase copy.
export const SHOWCASE_SCENARIO_RECORDING_SLOTS = Object.freeze([
  { scenarioId: 'SC01', catalogScenarioId: 'SC-01-PRODUCT-CARE', chapter: 'sc01', selector: { role: 'button', name: '1 商品知识有据回答', css: '[data-scenario-id="SC-01-PRODUCT-CARE"]' } },
  { scenarioId: 'SC02', catalogScenarioId: 'SC-02-MULTI-TURN', chapter: 'sc02', selector: { role: 'button', name: '2 连续消息与多轮上下文', css: '[data-scenario-id="SC-02-MULTI-TURN"]' } },
  { scenarioId: 'SC03', catalogScenarioId: 'SC-03-STALE-REPLAN', chapter: 'sc03', selector: { role: 'button', name: '3 生成中补充信息', css: '[data-scenario-id="SC-03-STALE-REPLAN"]' } },
  { scenarioId: 'SC04', catalogScenarioId: 'SC-04-IMAGE-HUMAN', chapter: 'sc04', selector: { role: 'button', name: '4 图片售后与人工接管', css: '[data-scenario-id="SC-04-IMAGE-HUMAN"]' } },
  { scenarioId: 'SC05', catalogScenarioId: 'SC-05-SAFE-GREETING', chapter: 'sc05', selector: { role: 'button', name: '5 安全问候，无需知识也可自然回复', css: '[data-scenario-id="SC-05-SAFE-GREETING"]' } },
  { scenarioId: 'SC06', catalogScenarioId: 'SC-06-SHOP-AI-OFF', chapter: 'sc06', selector: { role: 'button', name: '6 店铺 AI 关闭后只处理未来消息', css: '[data-scenario-id="SC-06-SHOP-AI-OFF"]' } },
]);

export const VOICEOVER_SEGMENTS = [
  { chapter: 'intro', offset: 0.3, subtitleEnd: 2.45, text: 'AIkefu，多店 AI 客服。' },
  { chapter: 'intro', offset: 2.5, subtitleEnd: 4.9, text: `${DEFAULT_PROVIDER_LABEL}、MockDouyin，合成演示。` },

  { chapter: 'sc01', offset: 5.3, subtitleEnd: 8.4, text: 'SC01：锁定商品，读取洗护证据。' },
  { chapter: 'sc01', offset: 8.5, subtitleEnd: 11.4, text: '证据充分才自动回复，SendGuard 留痕。' },

  { chapter: 'sc02', offset: 16.2, subtitleEnd: 19.7, text: 'SC02：连续消息合为 UserTurn，保留偏好。' },
  { chapter: 'sc02', offset: 19.8, subtitleEnd: 21.9, text: '人工只收到可编辑草稿。' },

  { chapter: 'sc03', offset: 31.2, subtitleEnd: 34.6, text: 'SC03：补充新疆，旧 ReplyJob 失效。' },
  { chapter: 'sc03', offset: 34.8, subtitleEnd: 37.4, text: '旧回复不会发送，改用偏远政策。' },

  { chapter: 'sc04', offset: 39.3, subtitleEnd: 42.2, text: 'SC04：破损图片进入高风险。' },
  { chapter: 'sc04', offset: 42.4, subtitleEnd: 44.7, text: 'Pipeline Fixture 只标注图片。' },
  { chapter: 'sc04', offset: 44.8, subtitleEnd: 47.1, text: '系统转人工，不执行退款。' },

  { chapter: 'sc05', offset: 48.5, subtitleEnd: 51.8, text: 'SC05：安全问候可自动处理并留痕。' },

  { chapter: 'sc06', offset: 55.3, subtitleEnd: 59.3, text: 'SC06：暂停 AI 即停止发送，恢复再处理。' },

  { chapter: 'workspace-operations-tour', offset: 72.8, subtitleEnd: 76.5, text: '工作台把当前会话、商品和人工状态放在一处。' },
  { chapter: 'workspace-operations-tour', offset: 83, subtitleEnd: 86.5, text: '切换店铺和运营总览，都读取当前 Workspace。' },
  { chapter: 'workspace-operations-tour', offset: 95, subtitleEnd: 98.4, text: '无数据时明确显示空态，不伪造增长曲线。' },

  { chapter: 'knowledge-workflow-tour', offset: 105.8, subtitleEnd: 109.3, text: '知识页区分正式、候选、冲突与学习任务。' },
  { chapter: 'knowledge-workflow-tour', offset: 116.8, subtitleEnd: 119.7, text: '动态商业事实不会伪装成静态知识。' },
  { chapter: 'knowledge-workflow-tour', offset: 127, subtitleEnd: 130.8, text: 'Workflow 用版本化图和人工审批收住高风险动作。' },

  { chapter: 'scenario-lab-overview', offset: 144.2, subtitleEnd: 147, text: '快速查看 Scenario Lab 八个场景。' },
  { chapter: 'scenario-lab-overview', offset: 154.5, subtitleEnd: 157.7, text: '结果来自本次 Workspace，不写假八中八。' },

  { chapter: 'trace', offset: 164.4, subtitleEnd: 167.4, text: 'Trace 串起消息、任务包、上下文与证据。' },
  { chapter: 'trace', offset: 167.5, subtitleEnd: 170.6, text: '策略、SendGuard、回执和恢复均可查。' },

  { chapter: 'closing', offset: 172.4, subtitleEnd: 175.2, text: 'AIkefu 让回复有证据，人工可接管。' },
  { chapter: 'closing', offset: 175.4, subtitleEnd: 178, text: '故障可恢复；不连接真实抖音。' },
  { chapter: 'closing', offset: 178, subtitleEnd: 180, text: '合成数据，无真实退款。' },
];

/** Resolve the one provider mention without allowing an offline run to claim a real model. */
export function resolveVoiceoverSegments(providerLabel = DEFAULT_PROVIDER_LABEL) {
  const label = providerLabel === 'DeepSeek' ? 'DeepSeek' : DEFAULT_PROVIDER_LABEL;
  return VOICEOVER_SEGMENTS.map((segment) => ({
    ...segment,
    text: segment.text.replace(DEFAULT_PROVIDER_LABEL, label),
  }));
}

/**
 * Keep short source clips at natural speed. A source may be padded only for a
 * tiny encoder-duration rounding gap; otherwise the recorder must capture it
 * again rather than stretching UI evidence into a static hold.
 */
export function resolvePlaybackPlan(actualSeconds, targetSeconds, { maxSpeed = MAX_SCENARIO_PLAYBACK_SPEED } = {}) {
  if (!Number.isFinite(actualSeconds) || !Number.isFinite(targetSeconds) || actualSeconds <= 0 || targetSeconds <= 0) {
    throw new Error('RECORDING_PLAYBACK_DURATION_INVALID');
  }
  if (!Number.isFinite(maxSpeed) || maxSpeed < 1) throw new Error('RECORDING_PLAYBACK_SPEED_INVALID');
  if (actualSeconds <= targetSeconds) {
    const gap = targetSeconds - actualSeconds;
    if (gap > MAX_SOURCE_SHORTFALL_SECONDS) return { speed: 1, padSeconds: null, requiresRecapture: true };
    return { speed: 1, padSeconds: Number(gap.toFixed(3)), requiresRecapture: false };
  }
  const requiredSpeed = actualSeconds / targetSeconds;
  return {
    // A slight overrun uses its exact ratio to land on the editorial target;
    // normal browser clips stay at or below the 1.25x recording contract.
    // Live Scenario Lab may opt into maxSpeed=4 for its eight-case overview.
    speed: Number(Math.min(requiredSpeed, maxSpeed).toFixed(3)),
    padSeconds: null,
    // Never let the builder apply -t and silently discard the final evidence.
    requiresRecapture: requiredSpeed > maxSpeed,
  };
}

/**
 * Let a completed real result remain readable for at most 1.8 seconds when a
 * fast run lands just short of its edit budget. This is captured browser time,
 * not a duplicated frame or slowed interaction.
 */
export function resolveEvidenceDwellMs(
  elapsedMs,
  targetSeconds,
  { safetyMs = 500, maxDwellMs = MAX_EVIDENCE_DWELL_MS } = {},
) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(targetSeconds) || targetSeconds <= 0) {
    throw new Error('RECORDING_EVIDENCE_DWELL_INPUT_INVALID');
  }
  const dwellMs = Math.max(0, Math.ceil(targetSeconds * 1_000 - elapsedMs + safetyMs));
  if (dwellMs > maxDwellMs) {
    throw new Error(`RECORDING_EVIDENCE_DWELL_TOO_LONG:${dwellMs}/${maxDwellMs}`);
  }
  return dwellMs;
}

/** Match the builder's source target: editorial chapter length plus its next fade. */
export function chapterPlaybackTargetSeconds(timeline, chapterId) {
  const index = timeline.findIndex((chapter) => chapter.id === chapterId);
  if (index < 0) throw new Error(`RECORDING_CHAPTER_NOT_FOUND:${chapterId}`);
  const chapter = timeline[index];
  const nextTransition = timeline[index + 1]?.transition?.duration ?? 0;
  return Number((chapter.end - chapter.start + nextTransition).toFixed(3));
}

/** Keep the six real scenario recordings inside the builder's no-padding, no-truncation budget. */
export function assertScenarioPlaybackBudget(timeline) {
  for (const [chapterId, actualSeconds] of Object.entries(SHOWCASE_SCENARIO_RAW_DURATIONS)) {
    const targetSeconds = chapterPlaybackTargetSeconds(timeline, chapterId);
    const plan = resolvePlaybackPlan(actualSeconds, targetSeconds, { maxSpeed: MAX_SCENARIO_PLAYBACK_SPEED });
    if (plan.requiresRecapture || plan.speed > MAX_SCENARIO_PLAYBACK_SPEED) {
      throw new Error(`RECORDING_SCENARIO_PLAYBACK_BUDGET:${chapterId}:actual=${actualSeconds}:target=${targetSeconds}:speed=${plan.speed}`);
    }
  }
}

/**
 * Recording pages may be taller than the viewport and scroll vertically.
 * Only document-wide horizontal overflow can crop the 16:9 capture surface.
 */
export function assertRecordingSurfaceDimensions(viewport, documentSize, label = 'RECORDING') {
  if (!viewport || !documentSize || !Number.isFinite(viewport.width) || !Number.isFinite(documentSize.width)) {
    throw new Error(`${label}_SURFACE_DIMENSIONS_INVALID`);
  }
  if (documentSize.width > viewport.width) {
    throw new Error(`${label}_SURFACE_HORIZONTAL_OVERFLOW:${JSON.stringify({ viewport, dimensions: documentSize })}`);
  }
}

export const SUBTITLE_BURN_IN_STYLE = Object.freeze({
  alignment: 2,
  // libass renders SRT in its 384x288 script coordinate space. These values
  // become roughly 45px text, 90px bottom space and 120px side safety at 1080p.
  marginV: 24,
  marginL: 24,
  marginR: 24,
  wrapStyle: 2,
  fontName: 'Microsoft YaHei',
  fontSize: 12,
  outline: 1,
});

function assertFiniteNumber(value, name) {
  if (!Number.isFinite(value)) throw new Error(`RECORDING_TIMELINE_NUMBER:${name}`);
}

export function assertVideoTimeline(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) throw new Error('RECORDING_TIMELINE_EMPTY');
  let cursor = 0;
  for (const chapter of timeline) {
    assertFiniteNumber(chapter.start, `${chapter.id}:start`);
    assertFiniteNumber(chapter.end, `${chapter.id}:end`);
    if (chapter.start !== cursor || chapter.end <= chapter.start) throw new Error(`RECORDING_TIMELINE_GAP:${chapter.id}`);
    if (chapter.transition && (chapter.transition.type !== 'fade' || chapter.transition.duration !== SCENE_TRANSITION_SECONDS)) {
      throw new Error(`RECORDING_TIMELINE_TRANSITION:${chapter.id}`);
    }
    cursor = chapter.end;
  }
  if (timeline[0].id !== 'intro' || timeline[0].end !== INTRO_DURATION_SECONDS) throw new Error('RECORDING_INTRO_DURATION_INVALID');
  if (timeline.at(-1).id !== 'closing' || timeline.at(-1).end - timeline.at(-1).start !== CLOSING_DURATION_SECONDS) throw new Error('RECORDING_CLOSING_DURATION_INVALID');
  if (cursor !== RECORDING_TOTAL_SECONDS) throw new Error(`RECORDING_TIMELINE_DURATION:${cursor}`);

  const scenarioIds = timeline.filter((chapter) => chapter.scenarioId).map((chapter) => chapter.scenarioId);
  if (JSON.stringify(scenarioIds) !== JSON.stringify(REQUIRED_SCENARIO_IDS)) throw new Error(`RECORDING_SCENARIOS_INVALID:${scenarioIds.join(',')}`);
  assertScenarioPlaybackBudget(timeline);
}

function splitSubtitleTokens(text) {
  return String(text)
    .replace(/\s+/gu, ' ')
    .trim()
    .split(/(?<=[\s，。！？；：、,.!?;:])/u)
    .filter(Boolean);
}

/** Wrap a cue to the safe width used by the hard-burned subtitle track. */
export function wrapSubtitleText(text, maxChars = SUBTITLE_MAX_LINE_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('SUBTITLE_MAX_CHARS_INVALID');
  const lines = [];
  let current = '';
  for (const token of splitSubtitleTokens(text)) {
    const candidate = current + token;
    if (current && [...candidate].length > maxChars) {
      lines.push(current.trim());
      current = token.trimStart();
    } else {
      current = candidate;
    }
    while ([...current].length > maxChars) {
      lines.push([...current].slice(0, maxChars).join('').trim());
      current = [...current].slice(maxChars).join('').trimStart();
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

function srtTime(totalSeconds) {
  const totalMilliseconds = Math.round(totalSeconds * 1_000);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

export function buildSubtitles(segments) {
  return `${segments.map((segment, index) => `${index + 1}\n${srtTime(segment.offset)} --> ${srtTime(segment.subtitleEnd)}\n${wrapSubtitleText(segment.text).join('\n')}`).join('\n\n')}\n`;
}
