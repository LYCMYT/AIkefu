import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHOWCASE_SCENARIO_RECORDING_SLOTS,
  SHOWCASE_VIDEO_TIMELINE,
  VOICEOVER_SEGMENTS,
  assertVideoTimeline,
  buildSubtitles,
} from './recording-timeline.mjs';

test('the editorial timeline is contiguous and exactly 180 seconds', () => {
  assert.doesNotThrow(() => assertVideoTimeline(SHOWCASE_VIDEO_TIMELINE));
  assert.equal(SHOWCASE_VIDEO_TIMELINE[0].start, 0);
  assert.equal(SHOWCASE_VIDEO_TIMELINE.at(-1).end, 180);
});

test('every narration segment stays inside its editorial chapter', () => {
  for (const segment of VOICEOVER_SEGMENTS) {
    const chapter = SHOWCASE_VIDEO_TIMELINE.find((item) => item.id === segment.chapter);
    assert.ok(chapter, `missing chapter for ${segment.chapter}`);
    assert.ok(segment.offset >= chapter.start);
    assert.ok(segment.offset < chapter.end);
    assert.ok(segment.subtitleEnd > segment.offset);
    assert.ok(segment.subtitleEnd <= chapter.end);
    assert.ok(segment.text.length > 8);
  }
});

test('subtitle output uses valid SRT timestamps and the approved Chinese copy', () => {
  const subtitles = buildSubtitles(VOICEOVER_SEGMENTS);
  assert.match(subtitles, /^1\r?\n00:00:00,300 --> 00:00:02,450/m);
  assert.match(subtitles, /AIkefu/);
  assert.match(subtitles, /旧回复不会发送/);
  assert.match(subtitles, /无真实退款/);
});

test('the recording contract opens in five seconds, closes in eight, and covers all six scenarios', () => {
  assert.equal(SHOWCASE_VIDEO_TIMELINE[0].id, 'intro');
  assert.equal(SHOWCASE_VIDEO_TIMELINE[0].end, 5);
  assert.equal(SHOWCASE_VIDEO_TIMELINE.at(-1).id, 'closing');
  assert.equal(SHOWCASE_VIDEO_TIMELINE.at(-1).start, 172);
  assert.equal(SHOWCASE_VIDEO_TIMELINE.at(-1).end, 180);

  const scenarioIds = SHOWCASE_VIDEO_TIMELINE
    .filter((chapter) => chapter.scenarioId)
    .map((chapter) => chapter.scenarioId);
  assert.deepEqual(scenarioIds, ['SC01', 'SC02', 'SC03', 'SC04', 'SC05', 'SC06']);
  const scenarioLab = SHOWCASE_VIDEO_TIMELINE.find((chapter) => chapter.id === 'scenario-lab-overview');
  assert.equal(scenarioLab?.kind, 'scenario-lab-overview');
  assert.ok(Math.abs((scenarioLab?.end ?? 0) - (scenarioLab?.start ?? 0) - 20.3) < 0.001);
  const trace = SHOWCASE_VIDEO_TIMELINE.find((chapter) => chapter.id === 'trace');
  assert.equal(trace?.kind, 'trace');
  assert.equal(trace?.end - trace?.start, 8);
});

test('every chapter boundary uses a short transition without a gap or long still hold', () => {
  const boundaries = SHOWCASE_VIDEO_TIMELINE.slice(1);
  assert.ok(boundaries.every((chapter) => chapter.transition?.duration === 0.2));
  assert.ok(boundaries.every((chapter) => chapter.transition?.type === 'fade'));
  const stillChapters = SHOWCASE_VIDEO_TIMELINE.filter((chapter) => chapter.source.endsWith('.png'));
  assert.ok(stillChapters.every((chapter) => chapter.end - chapter.start <= 8));
  const browserTours = SHOWCASE_VIDEO_TIMELINE.filter((chapter) => chapter.kind === 'product-tour');
  assert.deepEqual(browserTours.map((chapter) => Number((chapter.end - chapter.start).toFixed(3))), [36.8, 40.46]);
  assert.ok(browserTours.every((chapter) => chapter.browserCapture));
  assert.equal(SHOWCASE_VIDEO_TIMELINE.find((chapter) => chapter.id === 'scenario-lab-overview')?.liveCapture, true);
});

test('narration stays concise while retaining every active recording chapter', () => {
  const legacyCharacterCount = 700;
  const currentCharacterCount = VOICEOVER_SEGMENTS.reduce((total, segment) => total + segment.text.length, 0);
  assert.ok(currentCharacterCount <= legacyCharacterCount * 0.8, `narration is ${currentCharacterCount} characters`);
  assert.deepEqual(
    [...new Set(VOICEOVER_SEGMENTS.map((segment) => segment.chapter))],
    ['intro', 'sc01', 'sc02', 'sc03', 'sc04', 'sc05', 'sc06', 'workspace-operations-tour', 'knowledge-workflow-tour', 'scenario-lab-overview', 'trace', 'closing'],
  );
});

test('subtitle cues are short, safe-area friendly, and never exceed two visible lines', () => {
  const subtitles = buildSubtitles([{ offset: 0, subtitleEnd: 3, text: '证据充分时 SendGuard 才允许自动回复，旧回复不会发送。' }]);
  const cueText = subtitles.split(/\r?\n\r?\n/)[0].split(/\r?\n/).slice(2).filter(Boolean);
  assert.ok(cueText.length <= 2);
  assert.ok(cueText.every((line) => [...line].length <= 22));
  assert.match(cueText.join('\n'), /SendGuard/);
});

test('the subtitle burn-in contract exposes bottom alignment, safe margins, and two-line wrapping', async () => {
  const timeline = await import('./recording-timeline.mjs');
  assert.equal(timeline.SUBTITLE_BURN_IN_STYLE.alignment, 2);
  assert.equal(timeline.SUBTITLE_BURN_IN_STYLE.fontSize, 12);
  assert.equal(timeline.SUBTITLE_BURN_IN_STYLE.marginV, 24);
  assert.equal(timeline.SUBTITLE_BURN_IN_STYLE.marginL, 24);
  assert.equal(timeline.SUBTITLE_BURN_IN_STYLE.outline, 1);
  assert.equal(timeline.SUBTITLE_BURN_IN_STYLE.wrapStyle, 2);
});

test('provider narration is truthful for real and offline recording modes', async () => {
  const timeline = await import('./recording-timeline.mjs');
  const realCopy = timeline.resolveVoiceoverSegments('DeepSeek').map((segment) => segment.text).join('\n');
  const offlineCopy = timeline.resolveVoiceoverSegments('离线确定性Provider').map((segment) => segment.text).join('\n');
  assert.match(realCopy, /DeepSeek/);
  assert.doesNotMatch(offlineCopy, /DeepSeek/);
  assert.match(offlineCopy, /离线确定性Provider/);
});

test('showcase neural narration uses the accelerated fifty-percent rate', async () => {
  const timeline = await import('./recording-timeline.mjs');
  assert.equal(timeline.SHOWCASE_VOICE_RATE, '+50%');
  const generator = await readFile(new URL('./generate-showcase-voiceover.ps1', import.meta.url), 'utf8');
  assert.match(generator, /\[string\]\$Rate = '\+50%'/);
  assert.match(generator, /\$TtsMaxAttempts = 3/);
  assert.match(generator, /for \(\$Attempt = 1; \$Attempt -le \$TtsMaxAttempts/);
  const editorialGenerator = await readFile(new URL('./write-recording-editorial-assets.mjs', import.meta.url), 'utf8');
  assert.match(editorialGenerator, /旁白使用 Xiaoxiao neural、\$\{SHOWCASE_VOICE_RATE\}/);
  assert.doesNotMatch(editorialGenerator, /旁白使用 Xiaoxiao neural、\+30%/);
});

test('Scenario Lab overview is a live recording and hard subtitle QA samples several safe-area cues', async () => {
  const timeline = await import('./recording-timeline.mjs');
  const overview = timeline.SHOWCASE_VIDEO_TIMELINE.find((chapter) => chapter.id === 'scenario-lab-overview');
  assert.match(overview?.source ?? '', /raw[\\/]07-scenario-lab-overview\.webm$/);
  assert.ok(timeline.SUBTITLE_PIXEL_DIFF_THRESHOLD > 0);
  assert.ok(timeline.SUBTITLE_PIXEL_CHECK_TIMES.length >= 3);
  assert.ok(timeline.SUBTITLE_PIXEL_CHECK_TIMES.includes(155.5));
  assert.ok(timeline.SUBTITLE_PIXEL_CHECK_TIMES.every((time) => time >= 0 && time < 180));
});

test('short source clips stay at natural speed and only tolerate a tiny terminal pad', async () => {
  const timeline = await import('./recording-timeline.mjs');
  assert.deepEqual(timeline.resolvePlaybackPlan(10, 12), { speed: 1, padSeconds: null, requiresRecapture: true });
  assert.deepEqual(timeline.resolvePlaybackPlan(11.9, 12), { speed: 1, padSeconds: 0.1, requiresRecapture: false });
  assert.equal(timeline.resolvePlaybackPlan(15, 12).speed, 1.25);
  assert.equal(timeline.resolvePlaybackPlan(20, 12).speed, 1.25);
});

test('the condensed scenario chapters fit the observed raw recordings without a builder shortfall or excessive speed', async () => {
  const timeline = await import('./recording-timeline.mjs');
  for (const [chapterId, actualSeconds] of Object.entries(timeline.SHOWCASE_SCENARIO_RAW_DURATIONS)) {
    const chapter = timeline.SHOWCASE_VIDEO_TIMELINE.find((item) => item.id === chapterId);
    assert.ok(chapter, `missing scenario chapter ${chapterId}`);
    const targetSeconds = chapter.end - chapter.start + timeline.SCENE_TRANSITION_SECONDS;
    const plan = timeline.resolvePlaybackPlan(actualSeconds, targetSeconds, {
      maxSpeed: timeline.MAX_SCENARIO_PLAYBACK_SPEED,
    });
    assert.equal(plan.requiresRecapture, false, `${chapterId} must not be padded or truncated`);
    assert.ok(plan.speed >= 1 && plan.speed <= 1.25, `${chapterId} playback speed is ${plan.speed}`);
    assert.ok(actualSeconds >= targetSeconds - 0.2, `${chapterId} would trigger the builder shortfall guard`);
  }
});

test('a fast scenario may pause only briefly so its completed evidence remains readable', async () => {
  const timeline = await import('./recording-timeline.mjs');
  assert.equal(timeline.resolveEvidenceDwellMs(10_280, 11.2), 1420);
  assert.equal(timeline.resolveEvidenceDwellMs(11_300, 11.2), 400);
  assert.equal(timeline.resolveEvidenceDwellMs(8_619, 9.7), 1581);
  assert.throws(
    () => timeline.resolveEvidenceDwellMs(8_000, 11.2),
    /RECORDING_EVIDENCE_DWELL_TOO_LONG/,
  );
});

test('the recovered runtime is filled by two active browser-recorded product tours, not static stills', async () => {
  const timeline = await import('./recording-timeline.mjs');
  const tours = timeline.SHOWCASE_VIDEO_TIMELINE.filter((chapter) => chapter.kind === 'product-tour');
  assert.deepEqual(tours.map((chapter) => chapter.id), ['workspace-operations-tour', 'knowledge-workflow-tour']);
  assert.deepEqual(tours.map((chapter) => Number((chapter.end - chapter.start).toFixed(3))), [36.8, 40.46]);
  assert.ok(tours.every((chapter) => chapter.browserCapture === true));
  assert.ok(tours.every((chapter) => /raw[\\/]0[89]-.*\.webm$/.test(chapter.source)));
  assert.deepEqual(
    timeline.SHOWCASE_PRODUCT_TOUR_RECORDING_SLOTS.map((slot) => slot.chapter),
    tours.map((chapter) => chapter.id),
  );
});

test('product-tour timing begins after the real surface is ready and route changes are deterministic', async () => {
  const recorder = await readFile(new URL('./record-showcase.mjs', import.meta.url), 'utf8');
  const workspaceTour = recorder.slice(
    recorder.indexOf('async function runWorkspaceOperationsTour'),
    recorder.indexOf('async function runKnowledgeWorkflowTour'),
  );
  const knowledgeTour = recorder.slice(
    recorder.indexOf('async function runKnowledgeWorkflowTour'),
    recorder.indexOf('async function captureProductTour'),
  );
  assert.ok(workspaceTour.indexOf("await gotoOperationalRoute(page, '/workbench'") < workspaceTour.indexOf('const at = createTourClock(page)'));
  assert.ok(knowledgeTour.indexOf("await gotoOperationalRoute(page, '/admin/knowledge'") < knowledgeTour.indexOf('const at = createTourClock(page)'));
  assert.doesNotMatch(workspaceTour, /followOperationalLink/);
  assert.doesNotMatch(knowledgeTour, /followOperationalLink/);
  assert.match(
    knowledgeTour,
    /getByRole\('tab', \{ name: \/学习任务\/ \}\)\.click\(\);[\s\S]*?gotoOperationalRoute\(page, '\/admin\/knowledge', '知识运营'\)/,
  );
  assert.match(knowledgeTour, /locator\('\.workflow-nodes > g'\)/);
  assert.match(knowledgeTour, /RECORDING_TOUR_WORKFLOW_LIST_EMPTY/);
  assert.match(knowledgeTour, /RECORDING_TOUR_WORKFLOW_GRAPH_EMPTY/);
  assert.doesNotMatch(knowledgeTour, /if \(await workflowButtons\.count\(\)\) await workflowButtons/);
});

test('the variable image-risk scenario keeps a readable 8.6-second edit without exceeding 1.25x', async () => {
  const timeline = await import('./recording-timeline.mjs');
  const chapter = timeline.SHOWCASE_VIDEO_TIMELINE.find((item) => item.id === 'sc04');
  assert.equal(Number((chapter.end - chapter.start).toFixed(3)), 8.6);
  const target = timeline.chapterPlaybackTargetSeconds(timeline.SHOWCASE_VIDEO_TIMELINE, 'sc04');
  const plan = timeline.resolvePlaybackPlan(10.92, target, { maxSpeed: timeline.MAX_SCENARIO_PLAYBACK_SPEED });
  assert.equal(plan.requiresRecapture, false);
  assert.ok(plan.speed <= 1.25);
});

test('the product evidence scenario uses a 9.3-second edit across fast and slow runs', async () => {
  const timeline = await import('./recording-timeline.mjs');
  const chapter = timeline.SHOWCASE_VIDEO_TIMELINE.find((item) => item.id === 'sc01');
  assert.equal(Number((chapter.end - chapter.start).toFixed(3)), 9.3);
  const target = timeline.chapterPlaybackTargetSeconds(timeline.SHOWCASE_VIDEO_TIMELINE, 'sc01');
  const plan = timeline.resolvePlaybackPlan(11.32, target, { maxSpeed: timeline.MAX_SCENARIO_PLAYBACK_SPEED });
  assert.equal(plan.requiresRecapture, false);
  assert.ok(plan.speed <= 1.25);
});

test('the AI pause and recovery scenario uses an 11.8-second fast edit', async () => {
  const timeline = await import('./recording-timeline.mjs');
  const chapter = timeline.SHOWCASE_VIDEO_TIMELINE.find((item) => item.id === 'sc06');
  assert.equal(Number((chapter.end - chapter.start).toFixed(3)), 11.8);
  const target = timeline.chapterPlaybackTargetSeconds(timeline.SHOWCASE_VIDEO_TIMELINE, 'sc06');
  const plan = timeline.resolvePlaybackPlan(13.96, target, { maxSpeed: timeline.MAX_SCENARIO_PLAYBACK_SPEED });
  assert.equal(plan.requiresRecapture, false);
  assert.ok(plan.speed <= 1.25);
});

test('live Scenario Lab can use bounded 2.5–4x acceleration without truncating its final case', async () => {
  const timeline = await import('./recording-timeline.mjs');
  const plan = timeline.resolvePlaybackPlan(100, 35, { maxSpeed: 4 });
  assert.equal(plan.speed, 2.857);
  assert.equal(plan.requiresRecapture, false);
  assert.equal(timeline.resolvePlaybackPlan(200, 35, { maxSpeed: 4 }).requiresRecapture, true);
});

test('hard subtitle QA compares against a same-generation control and a non-subtitle noise region', async () => {
  const builder = await readFile(new URL('./build-showcase-video.ps1', import.meta.url), 'utf8');
  assert.match(builder, /\[System\.IO\.Path\]::GetRelativePath\(\$AllowedRoot, \$RecordingRoot\)/);
  assert.match(builder, /\[System\.IO\.Path\]::IsPathRooted\(\$RelativeRecordingRoot\)/);
  assert.match(builder, /\$MaxSpeed = if \(\$Chapter\.liveCapture\) \{ 4\.0 \} else \{ 1\.25 \}/);
  assert.match(builder, /subtitle-control/);
  assert.match(builder, /FontSize=12,Alignment=2,MarginL=24,MarginR=24,MarginV=24,Outline=1/);
  assert.doesNotMatch(builder, /'-c:s', 'mov_text'/);
  assert.match(builder, /SHOWCASE_UNEXPECTED_SOFT_SUBTITLE_STREAM/);
  assert.match(builder, /\$SubtitleCheckTimes = @\(3, 118, 155\.5, 176\.5\)/);
  assert.match(builder, /crop=1920:300:0:\$CropY/);
  assert.match(builder, /-CropY 780/);
  assert.match(builder, /-CropY 0/);
  assert.match(builder, /TopYavg/);
  assert.match(builder, /Get-FileHash[^\r\n]*\$Canonical[^\r\n]*\$RecordingManifestPath/);
});

test('recording surfaces allow vertical scrolling but reject global horizontal overflow', async () => {
  const timeline = await import('./recording-timeline.mjs');
  assert.doesNotThrow(() => timeline.assertRecordingSurfaceDimensions(
    { width: 1920, height: 1080 },
    { width: 1920, height: 1211 },
    'SCENARIO_LAB',
  ));
  assert.throws(
    () => timeline.assertRecordingSurfaceDimensions(
      { width: 1920, height: 1080 },
      { width: 1921, height: 1080 },
      'SCENARIO_LAB',
    ),
    /SCENARIO_LAB_SURFACE_HORIZONTAL_OVERFLOW/,
  );
});

test('a new recording invalidates every stale success artifact before clearing raw capture files', async () => {
  const recorder = await readFile(new URL('./record-showcase.mjs', import.meta.url), 'utf8');
  assert.match(recorder, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(recorder, /const root = path\.resolve\(scriptDir, '\.\.'\);/);
  assert.doesNotMatch(recorder, /const root = process\.cwd\(\);/);
  assert.match(recorder, /path\.relative\(outputDir, candidate\)/);
  assert.match(recorder, /RECORDING_ARTIFACT_PATH_OUTSIDE_ROOT/);
  const invalidateCall = recorder.indexOf('await clearStaleRecordingArtifacts();');
  const rawClear = recorder.indexOf('await rm(rawDir, { recursive: true, force: true });');
  assert.ok(invalidateCall >= 0, 'recording must invalidate stale publishable artifacts');
  assert.ok(rawClear >= 0, 'recording must clear the previous raw capture directory');
  assert.ok(invalidateCall < rawClear, 'stale success artifacts must be removed before raw capture is cleared');

  for (const staleArtifact of [
    'recording-manifest.json',
    'AIkefu-demo-3min-cn.mp4',
    'aikefu-3min-demo.mp4',
    'AIkefu-demo-3min-no-voice.mp4',
    'AIkefu-demo-thumbnail.png',
    'AIkefu-demo-subtitles.srt',
    'RECORDING_EVIDENCE.md',
    '00-recording-overview.png',
    '09-knowledge-workflow-tour.png',
  ]) {
    assert.match(recorder, new RegExp(`['\"]${staleArtifact.replace('.', '\\.') }['\"]`));
  }
  assert.match(recorder, /const staleDirectories = \['voice', 'edit', 'qa-current', 'qa-frames-final', 'ffmpeg-smoke'\];/);
  assert.match(recorder, /staleDirectories\.map\(\(name\) => rm\(recordingArtifactPath\(name\), \{ recursive: true, force: true \}\)\)/);
});

test('the recorder can select every catalog scenario by stable id without depending on visible copy', async () => {
  const catalog = JSON.parse(await readFile(new URL('../seed/showcase-scenarios.json', import.meta.url), 'utf8'));
  const catalogIds = catalog.scenarios.map((scenario) => scenario.id);

  assert.deepEqual(
    SHOWCASE_SCENARIO_RECORDING_SLOTS.map((slot) => slot.catalogScenarioId),
    catalogIds,
  );
  assert.deepEqual(
    SHOWCASE_SCENARIO_RECORDING_SLOTS.map((slot) => slot.selector.css),
    catalogIds.map((scenarioId) => `[data-scenario-id="${scenarioId}"]`),
  );
});

test('the video builder manifest gate rejects missing or incomplete recordings before build work starts', async () => {
  const { loadRecordingManifest } = await import('./recording-manifest.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'aikefu-recording-manifest-'));
  const manifestPath = join(directory, 'recording-manifest.json');

  try {
    await assert.rejects(() => loadRecordingManifest(manifestPath), /RECORDING_MANIFEST_NOT_FOUND/);
    await writeFile(manifestPath, JSON.stringify({ provider: 'DeepSeek', clips: [{ scenarioId: 'SC01' }] }), 'utf8');
    await assert.rejects(() => loadRecordingManifest(manifestPath), /RECORDING_MANIFEST_SCENARIOS_INVALID/);

    const complete = {
      provider: 'DeepSeek',
      clips: ['SC01', 'SC02', 'SC03', 'SC04', 'SC05', 'SC06'].map((scenarioId) => ({ scenarioId })),
    };
    await writeFile(manifestPath, JSON.stringify(complete), 'utf8');
    assert.deepEqual(await loadRecordingManifest(manifestPath), complete);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
