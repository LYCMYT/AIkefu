import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  CLOSING_DURATION_SECONDS,
  DEFAULT_PROVIDER_LABEL,
  INTRO_DURATION_SECONDS,
  RECORDING_TOTAL_SECONDS,
  SCENE_TRANSITION_SECONDS,
  SHOWCASE_PRODUCT_TOUR_RECORDING_SLOTS,
  SHOWCASE_VOICE_RATE,
  SHOWCASE_VIDEO_TIMELINE,
  VOICEOVER_SEGMENTS,
  assertVideoTimeline,
  buildSubtitles,
  resolveVoiceoverSegments,
} from './recording-timeline.mjs';

const root = process.cwd();
const outputDir = path.join(root, 'artifacts', 'recording');
await mkdir(outputDir, { recursive: true });
assertVideoTimeline(SHOWCASE_VIDEO_TIMELINE);
const providerLabel = process.env.SHOWCASE_PROVIDER_LABEL === 'DeepSeek' ? 'DeepSeek' : DEFAULT_PROVIDER_LABEL;
const voiceoverSegments = resolveVoiceoverSegments(providerLabel);

function formatEditorialTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Number((totalSeconds - minutes * 60).toFixed(2));
  const secondText = Number.isInteger(seconds)
    ? String(seconds).padStart(2, '0')
    : seconds.toFixed(2).padStart(5, '0');
  return `${String(minutes).padStart(2, '0')}:${secondText}`;
}

const chapterRows = SHOWCASE_VIDEO_TIMELINE.map((chapter) => {
  const start = formatEditorialTime(chapter.start);
  const end = formatEditorialTime(chapter.end);
  const tour = SHOWCASE_PRODUCT_TOUR_RECORDING_SLOTS.find((slot) => slot.chapter === chapter.id);
  const evidence = chapter.id === 'scenario-lab-overview'
    ? 'Scenario Lab 当前 Workspace 实际运行 8 个 Case 后的总览'
    : chapter.id === 'trace'
      ? '八阶段 Developer Trace，脱敏元数据（短段）'
      : chapter.kind === 'product-tour'
        ? tour?.evidence ?? '真实产品界面导航与当前 Workspace 状态'
      : chapter.scenarioId
        ? `${chapter.scenarioId} 真实 Showcase 链路与最终证据`
        : chapter.kind === 'intro'
          ? 'Provider、MockDouyin、合成数据、Fixture 边界'
          : '证据驱动、人工接管、故障恢复与真实边界';
  return `| ${start}–${end} | ${chapter.scenarioId ?? chapter.id} | ${evidence} |`;
}).join('\n');

const shotList = `# AIkefu 3-Minute Showcase Shot List

时长固定 ${RECORDING_TOTAL_SECONDS} 秒；开场 ${INTRO_DURATION_SECONDS} 秒，结尾 ${CLOSING_DURATION_SECONDS} 秒；章节边界使用约 ${SCENE_TRANSITION_SECONDS} 秒淡化衔接。六个场景源片只在必要时以不高于 1.25x 加速，并完整保留终态；不靠空等、静止画面或裁切填满时间。

| 时间 | Chapter | 必须出现的真实证据 |
| --- | --- | --- |
${chapterRows}

SC01–SC06 使用独立 Showcase Workspace 的真实 API/WS 状态。SC05、SC06 的录制选择器由稳定 \`scenarioId\` 槽位对接主线程页面；不把回复文本硬编码进录制器。

\`workspace-operations-tour\` 与 \`knowledge-workflow-tour\` 是连续浏览器录制：前者实际浏览工作台、店铺、运营总览，后者实际切换知识治理视图并查看 Workflow 画布。它们仅在录制上下文中复用同一合成 Showcase Workspace，清单不保存 token；任何空 Workspace、横向溢出、缺少真实页面状态或源片时长不符合合同都会阻断录制。

Scenario Lab 总览必须新建/恢复独立 Scenario Workspace，本次依次运行 8 个 Case，等待每个 Case 进入终态后再截图；若未完成 8 个，录制直接失败且不得标成 8/8。
`;

const voiceover = `# AIkefu 3-Minute Chinese Voiceover

- Voice: Microsoft Edge online neural TTS — \`zh-CN-XiaoxiaoNeural\`
- Rate: \`${SHOWCASE_VOICE_RATE}\`
- Final duration: ${RECORDING_TOTAL_SECONDS} seconds
- Style: short sentence-level cues, neutral and trustworthy
- Provider label: ${providerLabel} (read from the live Showcase page; REAL/DeepSeek is recorded only when actually configured).

${voiceoverSegments.map((segment, index) => `## ${index + 1}. ${segment.chapter} · ${segment.offset.toFixed(1)}–${segment.subtitleEnd.toFixed(1)}s\n\n${segment.text}`).join('\n\n')}
`;

const checklist = `# AIkefu Recording Checklist

- [ ] PostgreSQL、Redis、MinIO、API 和 Web 健康。
- [ ] \`/showcase?recording=1\` 为 1920×1080，无全局溢出。
- [ ] Provider 标签来自页面真实状态：REAL 才写 DeepSeek，OFFLINE 写“离线确定性Provider”，UNAVAILABLE 直接阻断。
- [ ] SC01–SC06 均通过真实 Showcase 链路完成，六条 raw WebM 非空。
- [ ] SC03 证明旧回复未发送；SC04 保持人工处理且不声称退款成功。
- [ ] SC05/SC06 通过稳定 scenarioId 选择器实际录制，不依赖页面文字猜测。
- [ ] \`raw/08-workspace-operations-tour.webm\` 实际展示同一 Showcase Workspace 的工作台、店铺切换和运营总览；不创建 EMPTY Workspace，不输出 token。
- [ ] \`raw/09-knowledge-workflow-tour.webm\` 实际展示同一 Showcase Workspace 的知识治理视图和 Workflow 画布；不伪造表格、指标或运行状态。
- [ ] Scenario Lab 独立 Workspace 本次实际运行 8 个场景并等待全部终态后截图；未满 8 个不显示 8/8。
- [ ] Developer Trace 展示八阶段脱敏结构，不含 Prompt、思维链、密钥或 PII。
- [ ] 浏览器无 warning/error；过渡约 0.2 秒；PNG 静态证据仅限开场 5 秒、Trace 8 秒、结尾 8 秒，无长静止段。
- [ ] ffprobe 时长守卫确认 SC01–SC06 与 08/09 导览在各自章节加 0.2 秒重叠后无大于 0.2 秒短缺，且普通片段不高于 1.25x。
- [ ] 旁白使用 Xiaoxiao neural、${SHOWCASE_VOICE_RATE}，每条为短句字幕 cue。
- [ ] 外部 SRT 与 FFmpeg 硬烧录中文字幕来自同一 SRT；MP4 不嵌入会被播放器自动开启的重复软字幕轨。
- [ ] 硬字幕底部安全区（左右至少 96px、底部至少 84px），画面最多两行。
- [ ] 最终成片 H.264/AAC、1920×1080、30fps、${RECORDING_TOTAL_SECONDS}s、faststart。
- [ ] 对最终视频提取帧，确认中文字幕像素实际可见。
- [ ] Secret scan 和发布门禁通过；不提交、不推送、不改 GitHub Release。
`;

await Promise.all([
  writeFile(path.join(outputDir, 'SHOT_LIST.md'), shotList, 'utf8'),
  writeFile(path.join(outputDir, 'VOICEOVER_CN.md'), voiceover, 'utf8'),
  writeFile(path.join(outputDir, 'AIkefu-demo-subtitles.srt'), buildSubtitles(voiceoverSegments), 'utf8'),
  writeFile(path.join(outputDir, 'SUBTITLES_CN.srt'), buildSubtitles(voiceoverSegments), 'utf8'),
  writeFile(path.join(outputDir, 'RECORDING_CHECKLIST.md'), checklist, 'utf8'),
]);

console.log(`RECORDING_EDITORIAL_ASSETS=${outputDir}`);
