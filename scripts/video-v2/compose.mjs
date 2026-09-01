import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { VIDEO_V2_CLIPS, VIDEO_V2_TARGET_SECONDS, validateVideoV2Spec } from './spec.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const root = path.join(repoRoot, 'artifacts', 'video-v2');
const rawRoot = path.join(root, 'raw');
const editRoot = path.join(root, 'edit');
const voiceRoot = path.join(root, 'voice');
const recordingManifestPath = path.join(root, 'VIDEO_V2_RECORDING_MANIFEST.json');
const editManifestPath = path.join(root, 'VIDEO_V2_EDIT_MANIFEST.json');
const subtitlePath = path.join(root, 'AIkefu-demo-v2-subtitles.srt');
const visualMaster = path.join(root, 'AIkefu-demo-v2-visual-master.mp4');
const noVoice = path.join(root, 'AIkefu-demo-v2-no-voice.mp4');
const ttsDraft = path.join(root, 'AIkefu-demo-v2-tts-draft.mp4');
const finalPath = path.join(root, 'AIkefu-demo-v2-final.mp4');

validateVideoV2Spec();
await requireBinary('ffmpeg');
await requireBinary('ffprobe');
await mkdir(editRoot, { recursive: true });
await rm(finalPath, { force: true });

const recording = JSON.parse(await readFile(recordingManifestPath, 'utf8'));
const edit = JSON.parse(await readFile(editManifestPath, 'utf8'));
if (recording.provider !== 'DeepSeek') throw new Error(`VIDEO_V2_COMPOSE_PROVIDER_INVALID:${recording.provider}`);
if (recording.clips?.length !== 7 || edit.clips?.length !== 7) throw new Error('VIDEO_V2_COMPOSE_CLIP_COUNT');

const chapters = [];
for (let index = 0; index < VIDEO_V2_CLIPS.length; index += 1) {
  const spec = VIDEO_V2_CLIPS[index];
  const source = recording.clips.find((clip) => clip.id === spec.id);
  if (!source) throw new Error(`VIDEO_V2_RECORDING_CLIP_MISSING:${spec.id}`);
  const input = path.join(root, source.file);
  const chapter = path.join(editRoot, `chapter-${String(index).padStart(2, '0')}-${spec.id}.mp4`);
  const captureIn = Number(source.source?.in);
  const captureOut = Number(source.source?.out);
  const captureDuration = captureOut - captureIn;
  const targetDuration = spec.end - spec.start;
  if (![captureIn, captureOut, captureDuration].every(Number.isFinite) || captureDuration < targetDuration - 0.25) {
    throw new Error(`VIDEO_V2_CAPTURE_RANGE_INVALID:${spec.id}`);
  }
  const speed = captureDuration / targetDuration;
  if (speed < 0.98 || speed > 4) throw new Error(`VIDEO_V2_PLAYBACK_SPEED_INVALID:${spec.id}:${speed.toFixed(3)}`);
  const pts = (1 / speed).toFixed(9);
  const filter = `trim=start=${captureIn.toFixed(3)}:end=${captureOut.toFixed(3)},setpts=${pts}*(PTS-STARTPTS),scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#f4f6fb,setsar=1,fps=30,format=yuv420p`;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', filter, '-t', targetDuration.toFixed(3), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', chapter]);
  chapters.push(chapter);
  edit.clips[index].in = captureIn;
  edit.clips[index].out = captureOut;
  edit.clips[index].sourceDuration = captureDuration;
  edit.clips[index].playbackSpeed = Number(speed.toFixed(4));
}

const concatInputs = chapters.flatMap((chapter) => ['-i', chapter]);
const concatLabels = chapters.map((_, index) => `[${index}:v]`).join('');
await run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', ...concatInputs,
  '-filter_complex', `${concatLabels}concat=n=${chapters.length}:v=1:a=0[v]`,
  '-map', '[v]', '-t', String(VIDEO_V2_TARGET_SECONDS), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', visualMaster,
]);

const subtitleFilter = `subtitles='${escapeFilterPath(subtitlePath)}':force_style='FontName=Microsoft YaHei UI,FontSize=12,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H980B1220,BackColour=&H980B1220,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginL=28,MarginR=28,MarginV=24,WrapStyle=2'`;
await run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-i', visualMaster,
  '-vf', subtitleFilter, '-t', String(VIDEO_V2_TARGET_SECONDS), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', noVoice,
]);

await run('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptDir, 'generate-voice.ps1')], { cwd: repoRoot });
const voiceManifest = JSON.parse(await readFile(path.join(voiceRoot, 'manifest.json'), 'utf8').then((value) => value.replace(/^\uFEFF/, '')));
const voiceInputs = [];
const audioFilters = [];
const labels = [];
for (let index = 0; index < voiceManifest.segments.length; index += 1) {
  const segment = voiceManifest.segments[index];
  const inputIndex = index + 1;
  voiceInputs.push('-i', path.join(voiceRoot, segment.file));
  const label = `voice${index}`;
  audioFilters.push(`[${inputIndex}:a]aresample=48000,adelay=${segment.offsetMs}:all=1[${label}]`);
  labels.push(`[${label}]`);
}
const silenceIndex = voiceManifest.segments.length + 1;
audioFilters.push(`[${silenceIndex}:a]atrim=duration=${VIDEO_V2_TARGET_SECONDS}[silence]`);
audioFilters.push(`[silence]${labels.join('')}amix=inputs=${labels.length + 1}:duration=longest:normalize=0,loudnorm=I=-17:LRA=7:TP=-2.5,volume=-3dB,alimiter=limit=0.8:level=false,atrim=duration=${VIDEO_V2_TARGET_SECONDS}[aout]`);
await run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-i', noVoice, ...voiceInputs,
  '-f', 'lavfi', '-t', String(VIDEO_V2_TARGET_SECONDS), '-i', 'anullsrc=r=48000:cl=stereo',
  '-filter_complex', audioFilters.join(';'), '-map', '0:v', '-map', '[aout]', '-t', String(VIDEO_V2_TARGET_SECONDS),
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', ttsDraft,
]);

await createThumbnail(noVoice, path.join(root, 'AIkefu-demo-v2-thumbnail.png'));
await createContactSheet(noVoice, path.join(root, 'VIDEO_V2_CONTACT_SHEET.jpg'));

edit.outputs = {
  visualMaster: path.basename(visualMaster),
  noVoice: path.basename(noVoice),
  ttsDraft: path.basename(ttsDraft),
  final: null,
  finalReason: 'No verified human voiceover-final.wav was provided; neural TTS is labelled draft.',
};
edit.voice = { kind: voiceManifest.kind, voice: voiceManifest.voice, rate: voiceManifest.rate, segments: voiceManifest.segments.length };
await writeFile(editManifestPath, `${JSON.stringify(edit, null, 2)}\n`, 'utf8');

for (const output of [visualMaster, noVoice, ttsDraft]) {
  const outputProbe = await probe(output);
  if (Math.abs(Number(outputProbe.format.duration) - VIDEO_V2_TARGET_SECONDS) > 0.2) throw new Error(`VIDEO_V2_OUTPUT_DURATION:${path.basename(output)}:${outputProbe.format.duration}`);
}

process.stdout.write(`VIDEO_V2_VISUAL_MASTER=${visualMaster}\n`);
process.stdout.write(`VIDEO_V2_NO_VOICE=${noVoice}\n`);
process.stdout.write(`VIDEO_V2_TTS_DRAFT=${ttsDraft}\n`);
process.stdout.write('VIDEO_V2_FINAL=NOT_GENERATED_NO_HUMAN_VOICE\n');

async function createThumbnail(input, output) {
  const font = escapeFilterPath('C:/Windows/Fonts/msyhbd.ttc');
  const filter = [
    'scale=1920:1080',
    'drawbox=x=56:y=62:w=1040:h=230:color=white@0.90:t=fill',
    `drawtext=fontfile='${font}':text='AIkefu':x=98:y=92:fontsize=62:fontcolor=#111827`,
    `drawtext=fontfile='${font}':text='AI 客服：从“会回答”到“敢发送”':x=98:y=174:fontsize=38:fontcolor=#4f46e5`,
    'drawbox=x=1260:y=875:w=560:h=118:color=#0b1428@0.88:t=fill',
    `drawtext=fontfile='${font}':text='Evidence   Stale/Replan   Human-in-the-loop':x=1295:y=916:fontsize=24:fontcolor=white`,
  ].join(',');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '4', '-i', input, '-frames:v', '1', '-vf', filter, output]);
}

async function createContactSheet(input, output) {
  const times = [4, 18, 43, 73, 103, 129, 149, 168];
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const time of times) args.push('-ss', String(time), '-i', input);
  const scales = times.map((_, index) => `[${index}:v]scale=480:270,setsar=1[v${index}]`);
  const layout = ['0_0', '480_0', '960_0', '1440_0', '0_270', '480_270', '960_270', '1440_270'];
  args.push('-filter_complex', `${scales.join(';')};${times.map((_, index) => `[v${index}]`).join('')}xstack=inputs=8:layout=${layout.join('|')}[sheet]`, '-map', '[sheet]', '-frames:v', '1', '-q:v', '2', output);
  await run('ffmpeg', args);
}

async function requireBinary(binary) {
  await run(binary, ['-version']);
}

async function probe(file) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels', '-of', 'json', '--', file]);
  return JSON.parse(stdout);
}

function escapeFilterPath(value) {
  return value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, '$1\\:').replaceAll("'", "\\'");
}

async function run(binary, args, options = {}) {
  try {
    return await execFileAsync(binary, args, { cwd: options.cwd ?? repoRoot, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
    throw new Error(`VIDEO_V2_COMMAND_FAILED:${binary}\n${detail}`);
  }
}
