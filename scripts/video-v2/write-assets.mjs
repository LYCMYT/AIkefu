import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIDEO_V2_CLIPS, VIDEO_V2_CUES, validateVideoV2Spec } from './spec.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputRoot = path.join(repoRoot, 'artifacts', 'video-v2');
validateVideoV2Spec();
await mkdir(outputRoot, { recursive: true });

const recordingManifestPath = path.join(outputRoot, 'VIDEO_V2_RECORDING_MANIFEST.json');
let recordingManifest;
try {
  recordingManifest = JSON.parse(await readFile(recordingManifestPath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const voiceover = [
  '# AIkefu Demo V2 中文旁白',
  '',
  '- 目标时长：175 秒',
  '- 目标语速：260–300 汉字/分钟',
  '- 最终字幕为精简摘要，不逐字复刻旁白',
  '- 语音草稿：Microsoft Edge 在线神经语音 `zh-CN-XiaoxiaoNeural`，`+45%`',
  '',
  ...VIDEO_V2_CUES.flatMap((cue, index) => [
    `## ${String(index + 1).padStart(2, '0')} · ${formatClock(cue.start)}–${formatClock(cue.end)}`,
    '',
    `旁白：${cue.narration}`,
    '',
    `字幕：${cue.subtitle.replaceAll('\n', ' / ')}`,
    '',
  ]),
].join('\n');

const srt = VIDEO_V2_CUES.map((cue, index) => [
  String(index + 1),
  `${formatSrt(cue.start)} --> ${formatSrt(cue.end)}`,
  cue.subtitle,
  '',
].join('\n')).join('\n');

const shotlist = [
  '# AIkefu Video V2 Shotlist',
  '',
  '| Clip | 时间 | Focus | 真实机制与结果 |',
  '|---|---:|---|---|',
  '| `00-hook.webm` | 0–8s | Buyer + Workbench | 首屏直接进入真实会话工作区 |',
  '| `01-evidence-auto.webm` | 8–34s | Evidence | 商品上下文 → Evidence → AUTO → SendGuard → SENT |',
  '| `02-multi-turn.webm` | 34–59s | Turn | 3 Raw Messages → 1 UserTurn；后续商品指代；ASSIST Draft |',
  '| `03-stale-replan.webm` | 59–96s | Stale | contextVersion 增加；旧 Job STALE / NOT DELIVERED；新 Evidence 与回执 |',
  '| `04-human-handoff.webm` | 96–120s | Risk | 订单 + 图片 Fixture + 退款投诉 → HIGH RISK → MANUAL |',
  '| `05-quality-regression.webm` | 120–140s | Quality | E017 线下试穿 false positive → 两项 Gate → 当前安全结果 |',
  '| `06-trace-closing.webm` | 140–175s | Trace / Closing | 七阶段脱敏 Trace → 浅色产品式收尾 |',
  '',
  '所有画面均来自真实运行页面；Recording V2 只改变布局与焦点，不改变业务状态。',
].join('\n');

const editManifest = {
  schemaVersion: 1,
  target: { duration: 175, width: 1920, height: 1080, fps: 30, codec: 'H.264 yuv420p' },
  transitions: { type: 'hard-cut', duration: 0 },
  clips: VIDEO_V2_CLIPS.map((clip) => {
    const recorded = recordingManifest?.clips?.find((entry) => entry.id === clip.id);
    const cueNumbers = VIDEO_V2_CUES.map((cue, index) => ({ cue, number: index + 1 }))
      .filter(({ cue }) => cue.start < clip.end && cue.end > clip.start)
      .map(({ number }) => number);
    return {
      clip: `raw/${clip.file}`,
      in: recorded?.source?.in ?? null,
      out: recorded?.source?.out ?? null,
      duration: clip.end - clip.start,
      timeline: { start: clip.start, end: clip.end },
      focus: clip.focus,
      overlay: clip.id === 'stale-replan' ? ['STALE', 'OLD REPLY · NOT DELIVERED', 'SendGuard PASS']
        : clip.id === 'human-handoff' ? ['Pipeline Fixture', 'HIGH RISK', 'MANUAL']
          : [],
      subtitleRange: cueNumbers.length ? [cueNumbers[0], cueNumbers.at(-1)] : [],
      narrationRange: cueNumbers.length ? [cueNumbers[0], cueNumbers.at(-1)] : [],
      markers: recorded?.markers ?? [],
    };
  }),
};

const voiceSegments = VIDEO_V2_CUES.map((cue, index) => ({
  index: index + 1,
  file: `segment-${String(index + 1).padStart(2, '0')}.mp3`,
  offsetMs: Math.round(cue.start * 1000),
  endMs: Math.round(cue.end * 1000),
  text: cue.narration,
}));

await Promise.all([
  writeFile(path.join(outputRoot, 'VIDEO_V2_SHOTLIST.md'), `${shotlist}\n`, 'utf8'),
  writeFile(path.join(outputRoot, 'AIkefu-demo-v2-voiceover.md'), `${voiceover}\n`, 'utf8'),
  writeFile(path.join(outputRoot, 'AIkefu-demo-v2-subtitles.srt'), `${srt}\n`, 'utf8'),
  writeFile(path.join(outputRoot, 'VIDEO_V2_EDIT_MANIFEST.json'), `${JSON.stringify(editManifest, null, 2)}\n`, 'utf8'),
  writeFile(path.join(outputRoot, 'VIDEO_V2_VOICE_SEGMENTS.json'), `${JSON.stringify({ voice: 'zh-CN-XiaoxiaoNeural', rate: '+45%', segments: voiceSegments }, null, 2)}\n`, 'utf8'),
]);

process.stdout.write(`VIDEO_V2_EDITORIAL_ASSETS=${outputRoot}\n`);

function formatClock(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`;
}

function formatSrt(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
