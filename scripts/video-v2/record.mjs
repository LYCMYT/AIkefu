import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { VIDEO_V2_CLIPS, validateVideoV2Spec } from './spec.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const artifactRoot = path.resolve(repoRoot, 'artifacts', 'video-v2');
const rawRoot = insideArtifactRoot('raw');
const baseUrl = process.env.VIDEO_V2_BASE_URL?.trim() || 'http://127.0.0.1:5173';

validateVideoV2Spec();
await mkdir(artifactRoot, { recursive: true });
await clearGeneratedArtifacts();
await mkdir(rawRoot, { recursive: true });

const browser = await chromium.launch({ headless: true });
const browserDiagnostics = [];
const clipEvidence = [];
let provider = '';
let sharedStorage;

try {
  const prepare = await browser.newContext(recordingContextOptions());
  const page = await prepare.newPage();
  observePage(page, 'prepare');
  await gotoRecording(page, 'buyer');
  provider = await readProvider(page);
  if (provider !== 'DeepSeek') throw new Error(`VIDEO_V2_REAL_PROVIDER_REQUIRED:${provider}`);
  sharedStorage = await prepare.storageState();
  await prepare.close();

  for (const clip of VIDEO_V2_CLIPS) {
    const evidence = await recordClip(clip, sharedStorage);
    clipEvidence.push(evidence);
  }
} finally {
  await browser.close();
}

if (browserDiagnostics.length) {
  throw new Error(`VIDEO_V2_BROWSER_DIAGNOSTICS:\n${browserDiagnostics.join('\n')}`);
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baseUrl,
  viewport: { width: 1920, height: 1080 },
  provider,
  platform: 'MockDouyinAdapter',
  dataBoundary: 'Synthetic Data',
  imageBoundary: 'Pipeline Fixture',
  traceBoundary: 'Structured redacted metadata only',
  clips: clipEvidence,
};
await writeFile(insideArtifactRoot('VIDEO_V2_RECORDING_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`VIDEO_V2_RECORDING_MANIFEST=${insideArtifactRoot('VIDEO_V2_RECORDING_MANIFEST.json')}\n`);
process.stdout.write(`VIDEO_V2_RAW_CLIPS=${clipEvidence.length}\n`);
process.stdout.write(`VIDEO_V2_PROVIDER=${provider}\n`);

function insideArtifactRoot(relative) {
  const resolved = path.resolve(artifactRoot, relative);
  const rel = path.relative(artifactRoot, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`VIDEO_V2_PATH_OUTSIDE_ARTIFACT_ROOT:${relative}`);
  }
  return resolved;
}

async function clearGeneratedArtifacts() {
  const files = [
    'VIDEO_V2_RECORDING_MANIFEST.json',
    'VIDEO_V2_EDIT_MANIFEST.json',
    'AIkefu-demo-v2-visual-master.mp4',
    'AIkefu-demo-v2-no-voice.mp4',
    'AIkefu-demo-v2-tts-draft.mp4',
    'AIkefu-demo-v2-final.mp4',
    'AIkefu-demo-v2-thumbnail.png',
    'VIDEO_V2_CONTACT_SHEET.jpg',
    'VIDEO_V2_EVIDENCE.md',
  ];
  await Promise.all(files.map((file) => rm(insideArtifactRoot(file), { force: true })));
  await rm(rawRoot, { recursive: true, force: true });
  await rm(insideArtifactRoot('edit'), { recursive: true, force: true });
  await rm(insideArtifactRoot('qa'), { recursive: true, force: true });
  await rm(insideArtifactRoot('voice'), { recursive: true, force: true });
}

function recordingContextOptions(storageState) {
  return {
    viewport: { width: 1920, height: 1080 },
    recordVideo: storageState ? { dir: rawRoot, size: { width: 1920, height: 1080 } } : undefined,
    locale: 'zh-CN',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    ...(storageState ? { storageState } : {}),
  };
}

function observePage(page, label) {
  page.on('pageerror', (error) => browserDiagnostics.push(`${label}:pageerror:${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      browserDiagnostics.push(`${label}:console-${message.type()}:${message.text()}`);
    }
  });
}

async function gotoRecording(page, focus, suffix = '') {
  await page.goto(`${baseUrl}/showcase?recording=v2&focus=${focus}${suffix}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.showcase-page.is-recording-v2').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('heading', { level: 1, name: '多店铺电商 AI 客服与 Agent 协同平台' }).waitFor({ state: 'visible', timeout: 30_000 });
  if (focus !== 'quality') {
    // Recording V2 intentionally hides the ordinary LiveTest header to keep
    // the frame compact. The indicator remains attached as truthful state.
    await page.getByLabel(/实时连接：已连接/).waitFor({ state: 'attached', timeout: 30_000 });
  }
  await assertSurface(page);
}

async function assertSurface(page) {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  }));
  if (dimensions.width > dimensions.viewportWidth || dimensions.height > dimensions.viewportHeight) {
    throw new Error(`VIDEO_V2_SURFACE_OVERFLOW:${JSON.stringify(dimensions)}`);
  }
}

async function readProvider(page) {
  const value = (await page.locator('.showcase-mode').first().innerText()).trim();
  if (/DeepSeek/i.test(value)) return 'DeepSeek';
  if (/离线|offline/i.test(value)) return 'OFFLINE';
  return value || 'UNAVAILABLE';
}

async function recordClip(clip, storageState) {
  const context = await browser.newContext(recordingContextOptions(storageState));
  const page = await context.newPage();
  const video = page.video();
  const contextStartedAt = Date.now();
  let captureStartedAt = contextStartedAt;
  let captureEndedAt = contextStartedAt;
  const markers = [];
  observePage(page, clip.id);
  try {
    if (clip.id === 'quality-regression') {
      await gotoRecording(page, 'quality');
      await page.getByRole('heading', { level: 2, name: '不是只看通过率，也要验证 evaluator 自己' }).waitFor({ state: 'visible', timeout: 30_000 });
      captureStartedAt = Date.now();
      markers.push(marker('quality-evidence-visible', contextStartedAt));
      await dwellFrom(captureStartedAt, clip.end - clip.start);
    } else if (clip.id === 'trace-closing') {
      await gotoRecording(page, 'trace');
      await runScenario(page, clip.scenarioId);
      await openTrace(page);
      captureStartedAt = Date.now();
      markers.push(marker('trace-seven-stages-visible', contextStartedAt));
      await page.waitForTimeout(19_000);
      await page.goto(`${baseUrl}/showcase?recording=v2&focus=trace&closing=1`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { level: 2, name: '有依据时自动处理，不确定时安全交给人。' }).waitFor({ state: 'visible', timeout: 30_000 });
      markers.push(marker('closing-visible', contextStartedAt));
      await assertSurface(page);
      await dwellFrom(captureStartedAt, clip.end - clip.start);
    } else {
      await gotoRecording(page, clip.focus);
      captureStartedAt = Date.now();
      markers.push(marker('capture-start', contextStartedAt));
      if (clip.scenarioId) await runScenario(page, clip.scenarioId);
      else await page.locator('.live-test-layout').waitFor({ state: 'visible', timeout: 30_000 });
      markers.push(marker(clip.scenarioId ? 'verified-outcome-visible' : 'buyer-workbench-visible', contextStartedAt));
      await dwellFrom(captureStartedAt, clip.end - clip.start);
    }
    captureEndedAt = Date.now();
    markers.push(marker('capture-end', contextStartedAt));
  } finally {
    await page.close();
    if (video) {
      const automatic = await video.path();
      const target = path.join(rawRoot, clip.file);
      await video.saveAs(target);
      if (path.resolve(automatic) !== path.resolve(target)) await rm(automatic, { force: true });
    }
    await context.close();
  }

  const targetPath = path.join(rawRoot, clip.file);
  const actual = await probeDuration(targetPath);
  const captureIn = Math.max(0, (captureStartedAt - contextStartedAt) / 1000);
  const captureOut = Math.min(actual, Math.max(captureIn + 0.1, (captureEndedAt - contextStartedAt) / 1000));
  if (captureOut - captureIn < clip.end - clip.start - 0.25) {
    throw new Error(`VIDEO_V2_CAPTURE_TOO_SHORT:${clip.id}:${(captureOut - captureIn).toFixed(3)}`);
  }
  return {
    id: clip.id,
    file: `raw/${clip.file}`,
    focus: clip.focus,
    scenarioId: clip.scenarioId,
    target: { start: clip.start, end: clip.end, duration: clip.end - clip.start },
    source: { duration: Number(actual.toFixed(3)), in: Number(captureIn.toFixed(3)), out: Number(captureOut.toFixed(3)) },
    markers,
  };
}

function marker(name, contextStartedAt) {
  return { name, at: Number(((Date.now() - contextStartedAt) / 1000).toFixed(3)) };
}

async function dwellFrom(startedAt, targetSeconds) {
  const remaining = startedAt + Math.ceil((targetSeconds + 0.35) * 1000) - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

async function runScenario(page, scenarioId) {
  const selector = `[data-scenario-id="${scenarioId}"]`;
  await page.locator(selector).waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator(selector).click();
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => /开始演示|重新运行/.test(candidate.textContent || ''));
    if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error('VIDEO_V2_RUN_BUTTON_UNAVAILABLE');
    button.click();
  });
  const status = page.getByLabel('录制进度').locator('b');
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const value = (await status.textContent())?.trim();
    if (value === '场景完成') break;
    if (value === '场景失败' || value === '已取消') {
      const detail = (await page.getByLabel('录制进度').locator('small').textContent())?.trim();
      throw new Error(`VIDEO_V2_SCENARIO_${value}:${scenarioId}:${detail}`);
    }
    await page.waitForTimeout(250);
  }
  if ((await status.textContent())?.trim() !== '场景完成') throw new Error(`VIDEO_V2_SCENARIO_TIMEOUT:${scenarioId}`);
  await assertScenarioOutcome(page, scenarioId);
}

async function assertScenarioOutcome(page, scenarioId) {
  if (scenarioId === 'SC-01-PRODUCT-CARE') {
    await page.locator('.live-message-bubble').filter({ hasText: /不建议.*烘干/ }).last().waitFor({ state: 'visible', timeout: 30_000 });
    await waitPipeline(page, '发送回执');
    return;
  }
  if (scenarioId === 'SC-02-MULTI-TURN') {
    const draft = page.locator('.live-draft-card');
    await draft.waitFor({ state: 'visible', timeout: 30_000 });
    const text = await draft.innerText();
    if (/请问您咨询的是哪件商品/.test(text)) throw new Error('VIDEO_V2_SC02_PRODUCT_CONTEXT_LOST');
    return;
  }
  if (scenarioId === 'SC-03-STALE-REPLAN') {
    await page.getByText(/旧回复.*未发送|旧回复已失效|NOT DELIVERED/).first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.live-message-bubble').filter({ hasText: /新疆|偏远地区/ }).last().waitFor({ state: 'visible', timeout: 30_000 });
    await waitPipeline(page, '发送回执');
    return;
  }
  if (scenarioId === 'SC-04-IMAGE-HUMAN') {
    await page.getByText('商品破损图片', { exact: true }).last().waitFor({ state: 'visible', timeout: 30_000 });
    const humanDraft = page.locator('.live-draft-card');
    await humanDraft.waitFor({ state: 'visible', timeout: 30_000 });
    if (!/WAITING_HUMAN|需要人工|人工确认/.test(await humanDraft.innerText())) {
      throw new Error('VIDEO_V2_SC04_HUMAN_HANDOFF_NOT_VISIBLE');
    }
    const pageText = await page.locator('.showcase-page').innerText();
    if (/退款成功|已完成退款/.test(pageText)) throw new Error('VIDEO_V2_SC04_FALSE_REFUND_COMPLETION');
  }
}

async function waitPipeline(page, label) {
  await page.getByLabel('本轮消息处理状态').locator('.live-pipeline-stage.is-done').filter({ hasText: label })
    .waitFor({ state: 'visible', timeout: 30_000 });
}

async function openTrace(page) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('技术证据'));
    if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error('VIDEO_V2_TRACE_BUTTON_UNAVAILABLE');
    button.click();
  });
  const dialog = page.getByRole('dialog', { name: 'Developer Trace' });
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  const pending = await dialog.locator('.recording-trace-row.is-pending').count();
  const done = await dialog.locator('.recording-trace-row.is-done').count();
  if (pending !== 0 || done !== 7) throw new Error(`VIDEO_V2_TRACE_INCOMPLETE:${done}/7:pending=${pending}`);
  // The dialog footer explicitly says that Prompt/CoT/Secret are not shown;
  // scan only the seven evidence rows so that this truthful boundary copy is
  // not mistaken for leaked content.
  const text = await dialog.locator('.recording-trace-list').innerText();
  if (/prompt|chain.of.thought|api.?key|secret|cookie/i.test(text)) throw new Error('VIDEO_V2_TRACE_SENSITIVE_CONTENT');
}

async function probeDuration(file) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', '--', file]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`VIDEO_V2_RAW_DURATION_INVALID:${file}`);
  return duration;
}
