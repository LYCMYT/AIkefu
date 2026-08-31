import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  MAX_SCENARIO_PLAYBACK_SPEED,
  SHOWCASE_PRODUCT_TOUR_RECORDING_SLOTS,
  SHOWCASE_SCENARIO_RECORDING_SLOTS,
  SHOWCASE_VIDEO_TIMELINE,
  assertRecordingSurfaceDimensions,
  assertVideoTimeline,
  chapterPlaybackTargetSeconds,
  resolveEvidenceDwellMs,
  resolvePlaybackPlan,
} from './recording-timeline.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const baseUrl = process.env.SHOWCASE_BASE_URL ?? 'http://127.0.0.1:5173';
const outputDir = path.resolve(root, 'artifacts', 'recording');
const rawDir = recordingArtifactPath('raw');
const execFileAsync = promisify(execFile);

assertVideoTimeline(SHOWCASE_VIDEO_TIMELINE);
await mkdir(outputDir, { recursive: true });
await clearStaleRecordingArtifacts();
await rm(rawDir, { recursive: true, force: true });
await mkdir(rawDir, { recursive: true });

function recordingArtifactPath(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('RECORDING_ARTIFACT_PATH_INVALID');
  const candidate = path.resolve(outputDir, name);
  const relative = path.relative(outputDir, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`RECORDING_ARTIFACT_PATH_OUTSIDE_ROOT:${name}`);
  }
  return candidate;
}

async function clearStaleRecordingArtifacts() {
  // A failed replacement recording must never leave a prior manifest, finished
  // video, voice track, screenshot or evidence file that showcase:build could
  // mistake for fresh proof. Keep this explicit whitelist inside the fixed
  // repository artifact root; do not delete the local Edge TTS runtime.
  const staleFiles = [
    'recording-manifest.json',
    'AIkefu-demo-3min-cn.mp4',
    'aikefu-3min-demo.mp4',
    'AIkefu-demo-3min-no-voice.mp4',
    'AIkefu-demo-thumbnail.png',
    'AIkefu-demo-subtitles.srt',
    'SUBTITLES_CN.srt',
    'RECORDING_EVIDENCE.md',
    'RECORDING_CHECKLIST.md',
    'SHOT_LIST.md',
    'VOICEOVER_CN.md',
    '00-recording-overview.png',
    '01-product-care.png',
    '02-multi-turn.png',
    '03-stale-replan.png',
    '04-image-human.png',
    '05-developer-trace.png',
    '05-safe-greeting.png',
    '06-ai-pause-recovery.png',
    '06-closing.png',
    '07-scenario-lab-overview.png',
    '08-workspace-operations-tour.png',
    '09-knowledge-workflow-tour.png',
  ];
  const staleDirectories = ['voice', 'edit', 'qa-current', 'qa-frames-final', 'ffmpeg-smoke'];
  await Promise.all([
    ...staleFiles.map((name) => rm(recordingArtifactPath(name), { force: true })),
    ...staleDirectories.map((name) => rm(recordingArtifactPath(name), { recursive: true, force: true })),
  ]);
}

const selectorOverrides = readSelectorOverrides(process.env.SHOWCASE_SCENARIO_SELECTORS);
const scenarios = SHOWCASE_SCENARIO_RECORDING_SLOTS.map((slot) => {
  const override = selectorOverrides[slot.scenarioId] ?? {};
  return {
    id: slot.scenarioId,
    chapter: slot.chapter,
    selector: {
      ...slot.selector,
      ...(override.button ? { name: override.button, css: undefined, pending: false } : {}),
      ...(override.selector ? { css: override.selector, pending: false } : {}),
    },
    fallbackNames: fallbackButtonNames(slot.scenarioId),
    proof: scenarioProof(slot.scenarioId),
    proofLabel: scenarioProofLabel(slot.scenarioId),
    screenshot: `${slot.scenarioId.slice(2)}-${scenarioFileStem(slot.scenarioId)}.png`,
    video: `${slot.scenarioId.slice(2)}-${scenarioFileStem(slot.scenarioId)}.webm`,
    override,
  };
});

const browser = await chromium.launch({ headless: true });
const diagnostics = [];
const clips = [];
const productTours = [];
let providerLabel = '';
let traceCaptured = false;
let scenarioLabEvidence;

function captureDiagnostics(page, label) {
  page.on('pageerror', (error) => diagnostics.push(`${label}:pageerror:${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') diagnostics.push(`${label}:console-${message.type()}:${message.text()}`);
  });
}

async function expectCaptureSurface(page) {
  await page.getByRole('heading', { level: 1, name: '多店铺电商 AI 客服与 Agent 协同平台' }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByLabel(/实时连接：已连接/).waitFor({ state: 'visible', timeout: 30_000 });
  const viewport = page.viewportSize();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  assertRecordingSurfaceDimensions(viewport, dimensions, 'RECORDING');
}

async function expectScenarioLabSurface(page) {
  await page.getByRole('heading', { level: 2, name: '场景实验室' }).waitFor({ state: 'visible', timeout: 30_000 });
  const viewport = page.viewportSize();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  assertRecordingSurfaceDimensions(viewport, dimensions, 'SCENARIO_LAB');
}

async function expectOperationalSurface(page, label) {
  const viewport = page.viewportSize();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  assertRecordingSurfaceDimensions(viewport, dimensions, label);
}

async function gotoOperationalRoute(page, route, heading) {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: heading }).waitFor({ state: 'visible', timeout: 30_000 });
  await expectOperationalSurface(page, `TOUR_${route.replaceAll('/', '_').toUpperCase()}`);
}

function createTourClock(page) {
  const startedAt = Date.now();
  return async (second) => {
    const remaining = startedAt + second * 1_000 - Date.now();
    if (remaining > 0) await page.waitForTimeout(remaining);
  };
}

async function selectDifferentOption(select) {
  const values = await select.locator('option').evaluateAll((options) => options.map((option) => option.value));
  if (values.length === 0) throw new Error('RECORDING_TOUR_SELECT_OPTIONS_EMPTY');
  const current = await select.inputValue();
  await select.selectOption(values.find((value) => value !== current) ?? values[0]);
}

async function clickIfVisible(locator) {
  const candidate = locator.first();
  if (!(await candidate.isVisible().catch(() => false))) return false;
  await candidate.click();
  return true;
}

async function assertTourUsesShowcaseWorkspace(page) {
  const reusesShowcaseToken = await page.evaluate(() => {
    const showcase = window.localStorage.getItem('aikefu_showcase_workspace_token')?.trim();
    const operational = window.localStorage.getItem('aikefu_operational_workspace_token_v2')?.trim();
    return Boolean(showcase && operational && showcase === operational);
  });
  if (!reusesShowcaseToken) throw new Error('RECORDING_TOUR_WORKSPACE_REUSE_MISSING');
}

async function readRecordedDuration(source) {
  const ffprobe = process.env.SHOWCASE_FFPROBE ?? 'ffprobe';
  const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', '--', source]);
  const actualSeconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(actualSeconds) || actualSeconds <= 0) throw new Error(`RECORDING_SOURCE_DURATION_INVALID:${source}`);
  return actualSeconds;
}

async function assertRecordedClipDuration(chapter, source) {
  const actualSeconds = await readRecordedDuration(source);
  const targetSeconds = chapterPlaybackTargetSeconds(SHOWCASE_VIDEO_TIMELINE, chapter.id);
  const maxSpeed = chapter.liveCapture ? 4 : MAX_SCENARIO_PLAYBACK_SPEED;
  const plan = resolvePlaybackPlan(actualSeconds, targetSeconds, { maxSpeed });
  if (plan.requiresRecapture) {
    throw new Error(`RECORDING_SOURCE_DURATION_OUT_OF_BOUNDS:${chapter.id}:actual=${actualSeconds.toFixed(3)}:target=${targetSeconds.toFixed(3)}:max-speed=${maxSpeed}`);
  }
  return { actualSeconds: Number(actualSeconds.toFixed(3)), targetSeconds, speed: plan.speed };
}

async function waitForPipelineDone(page, label) {
  await page.getByLabel('本轮消息处理状态')
    .locator('.live-pipeline-stage.is-done')
    .filter({ hasText: label })
    .waitFor({ state: 'visible', timeout: 30_000 });
}

async function waitForShowcaseScenario(page, timeoutMs = 150_000) {
  const progress = page.getByLabel('录制进度');
  const state = progress.locator('b');
  await state.waitFor({ state: 'visible', timeout: 30_000 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = (await state.textContent())?.trim() ?? '';
    if (value === '场景完成') return;
    if (value === '场景失败' || value === '已取消') {
      const detail = (await progress.locator('small').textContent())?.trim() ?? '';
      throw new Error(`RECORDING_SCENARIO_${value === '场景失败' ? 'FAILED' : 'CANCELLED'}:${detail}`);
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`RECORDING_SCENARIO_TIMEOUT:${timeoutMs}`);
}

async function waitForScenarioCapture(page, scenario) {
  if (scenario.id === 'SC01') {
    await page.locator('.live-message-bubble').filter({ hasText: /不建议.*烘干/ }).last().waitFor({ state: 'visible', timeout: 30_000 });
    await waitForPipelineDone(page, '发送回执');
    return;
  }
  if (scenario.id === 'SC02') {
    await page.getByText('轻薄连帽卫衣', { exact: true }).last().waitFor({ state: 'visible', timeout: 30_000 });
    const draft = page.locator('.live-draft-card');
    await draft.waitFor({ state: 'visible', timeout: 30_000 });
    if ((await draft.textContent())?.includes('请问您咨询的是哪件商品')) throw new Error('SC02_LOST_PRODUCT_CONTEXT');
    return;
  }
  if (scenario.id === 'SC03') {
    await page.locator('.live-message-bubble').filter({ hasText: /新疆|偏远地区/ }).last().waitFor({ state: 'visible', timeout: 30_000 });
    await waitForPipelineDone(page, '回复完成');
    await waitForPipelineDone(page, '发送回执');
    return;
  }
  if (scenario.id === 'SC04') {
    await page.getByText('商品破损图片', { exact: true }).last().waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText('疑似商品破损', { exact: true }).last().waitFor({ state: 'visible', timeout: 30_000 });
    const bubbles = await page.locator('.live-message-bubble').allTextContents();
    if (bubbles.some((value) => value.includes('（空消息）'))) throw new Error('SC04_IMAGE_RENDERED_EMPTY');
    return;
  }

  const proof = page.getByText(scenario.proof).last();
  await proof.waitFor({ state: 'visible', timeout: 30_000 });
}

async function clickScenario(page, scenario) {
  if (typeof scenario.selector.css === 'string' && scenario.selector.css.trim()) {
    const explicit = page.locator(scenario.selector.css.trim()).first();
    if (await explicit.count()) {
      await explicit.click();
      return;
    }
    throw new Error(`RECORDING_SCENARIO_SELECTOR_NOT_FOUND:${scenario.id}`);
  }
  const names = [];
  if (typeof scenario.selector.name === 'string' && scenario.selector.name.trim()) names.push(scenario.selector.name.trim());
  names.push(...scenario.fallbackNames);
  for (const name of [...new Set(names)]) {
    const candidate = page.getByRole('button', { name, exact: true });
    if (await candidate.count()) {
      await candidate.first().click();
      return;
    }
  }
  const dataSelector = page.locator(`[data-scenario-id="${scenario.id}"]`).first();
  if (await dataSelector.count()) {
    await dataSelector.click();
    return;
  }
  if (scenario.selector.pending) throw new Error(`RECORDING_SCENARIO_SELECTOR_PENDING:${scenario.id}`);
  throw new Error(`RECORDING_SCENARIO_SELECTOR_NOT_FOUND:${scenario.id}`);
}

async function readProviderLabel(page) {
  const mode = (await page.locator('.showcase-mode').first().innerText()).trim();
  if (!mode || /未配置|UNAVAILABLE/i.test(mode)) throw new Error(`RECORDING_PROVIDER_UNAVAILABLE:${mode || 'missing'}`);
  if (/DeepSeek/i.test(mode)) return 'DeepSeek';
  if (/离线|offline|显式/i.test(mode)) return '离线确定性Provider';
  throw new Error(`RECORDING_PROVIDER_UNRECOGNIZED:${mode}`);
}

async function captureTrace(page, scenario) {
  const trigger = page.getByRole('button', { name: '技术证据', exact: true });
  if (!(await trigger.count()) || !(await trigger.isEnabled())) return false;
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Developer Trace' });
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  const pending = dialog.locator('.recording-trace-row.is-pending');
  const pendingCount = await pending.count();
  if (pendingCount > 0) {
    const labels = (await pending.allTextContents()).map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean);
    throw new Error(`RECORDING_TRACE_INCOMPLETE:${scenario.id}:${labels.join('|') || pendingCount}`);
  }
  const completedCount = await dialog.locator('.recording-trace-row.is-done').count();
  if (completedCount !== 8) throw new Error(`RECORDING_TRACE_STAGE_COUNT:${scenario.id}:${completedCount}/8`);
  await page.screenshot({ path: path.join(outputDir, '05-developer-trace.png') });
  const close = page.getByRole('button', { name: /关闭 Developer Trace/ });
  if (await close.count()) await close.click();
  return true;
}

async function runWorkspaceOperationsTour(page) {
  await gotoOperationalRoute(page, '/workbench', '店铺工作台');
  await assertTourUsesShowcaseWorkspace(page);
  const initialProducts = page.getByLabel('切换商品').getByRole('button');
  await initialProducts.first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByLabel('会话列表').getByRole('button').first().waitFor({ state: 'visible', timeout: 30_000 });
  const at = createTourClock(page);

  await at(4);
  const shopSwitch = page.getByLabel('切换店铺');
  await shopSwitch.waitFor({ state: 'visible', timeout: 30_000 });
  await selectDifferentOption(shopSwitch);

  await at(8);
  await clickIfVisible(page.getByLabel('会话列表').getByRole('button'));

  await at(12);
  const products = page.getByLabel('切换商品').getByRole('button');
  if (await products.count()) await products.nth(Math.min(1, (await products.count()) - 1)).click();

  await at(16);
  await clickIfVisible(page.getByRole('button', { name: '订单', exact: true }));

  await at(20);
  await clickIfVisible(page.getByRole('button', { name: '关闭订单信息', exact: true }));

  await at(24);
  await gotoOperationalRoute(page, '/admin', '数据概览');
  await page.getByLabel('Workspace 指标').waitFor({ state: 'visible', timeout: 30_000 });

  await at(28);
  const range = page.getByLabel('总览时间范围');
  await range.waitFor({ state: 'visible', timeout: 30_000 });
  await selectDifferentOption(range);

  await at(31);
  const overviewShop = page.getByLabel('总览店铺');
  await overviewShop.waitFor({ state: 'visible', timeout: 30_000 });
  await selectDifferentOption(overviewShop);

  await at(34);
  await gotoOperationalRoute(page, '/admin/shops', '店铺配置');

  await at(36);
  await gotoOperationalRoute(page, '/workbench', '店铺工作台');
}

async function runKnowledgeWorkflowTour(page) {
  await gotoOperationalRoute(page, '/admin/knowledge', '知识运营');
  await assertTourUsesShowcaseWorkspace(page);
  const tabs = page.getByRole('tablist', { name: '知识治理视图' });
  await tabs.waitFor({ state: 'visible', timeout: 30_000 });
  const at = createTourClock(page);
  await page.locator('.knowledge-table, .knowledge-import-rail, .table-empty').first().waitFor({ state: 'visible', timeout: 30_000 });

  await at(4);
  await tabs.getByRole('tab', { name: /候选知识/ }).click();

  await at(8);
  await tabs.getByRole('tab', { name: /冲突知识/ }).click();

  await at(12);
  await tabs.getByRole('tab', { name: /学习任务/ }).click();

  await at(16);
  await gotoOperationalRoute(page, '/admin/knowledge', '知识运营');
  await page.getByRole('tablist', { name: '知识治理视图' })
    .getByRole('tab', { name: /正式知识/ })
    .waitFor({ state: 'visible', timeout: 30_000 });

  await at(20);
  await gotoOperationalRoute(page, '/admin/workflows', '工作流');

  await at(24);
  const workflowList = page.getByLabel('工作流列表');
  await workflowList.waitFor({ state: 'visible', timeout: 30_000 });
  const workflowButtons = workflowList.getByRole('button');
  const workflowCount = await workflowButtons.count();
  if (workflowCount === 0) throw new Error('RECORDING_TOUR_WORKFLOW_LIST_EMPTY');
  await workflowButtons.nth(Math.min(1, workflowCount - 1)).click();

  await at(28);
  await clickIfVisible(page.getByRole('button', { name: '放大画布', exact: true }));

  await at(32);
  await clickIfVisible(page.getByRole('button', { name: '缩小画布', exact: true }));

  await at(36);
  await clickIfVisible(page.getByRole('button', { name: '适应', exact: true }));

  await at(39);
  const workflowNodes = page.locator('.workflow-nodes > g');
  const workflowNodeCount = await workflowNodes.count();
  if (workflowNodeCount === 0) throw new Error('RECORDING_TOUR_WORKFLOW_GRAPH_EMPTY');
  await workflowNodes.nth(Math.min(1, workflowNodeCount - 1)).click();
}

async function captureProductTour(storageState, tour) {
  const chapter = SHOWCASE_VIDEO_TIMELINE.find((item) => item.id === tour.chapter);
  if (!chapter || chapter.kind !== 'product-tour' || chapter.source !== tour.source) {
    throw new Error(`RECORDING_TOUR_CHAPTER_INVALID:${tour.chapter}`);
  }
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    recordVideo: { dir: rawDir, size: { width: 1920, height: 1080 } },
    storageState,
  });
  // Operational routes normally create an EMPTY session. For this isolated
  // recording context only, reuse the same local synthetic Showcase Workspace
  // token so the tour shows the real seeded shop/knowledge/workflow state.
  // No token leaves browser storage or is added to the manifest/logs.
  await context.addInitScript(() => {
    const showcaseToken = window.localStorage.getItem('aikefu_showcase_workspace_token')?.trim();
    if (showcaseToken) window.localStorage.setItem('aikefu_operational_workspace_token_v2', showcaseToken);
  });
  const page = await context.newPage();
  const video = page.video();
  const targetPath = path.join(rawDir, path.basename(tour.source));
  let nextStorageState = storageState;
  let recording;
  try {
    captureDiagnostics(page, tour.chapter);
    if (tour.chapter === 'workspace-operations-tour') await runWorkspaceOperationsTour(page);
    else if (tour.chapter === 'knowledge-workflow-tour') await runKnowledgeWorkflowTour(page);
    else throw new Error(`RECORDING_TOUR_RUNNER_MISSING:${tour.chapter}`);

    await page.screenshot({ path: path.join(outputDir, tour.screenshot) });
    nextStorageState = await context.storageState();
    recording = {
      chapter: tour.chapter,
      output: tour.source,
      screenshot: tour.screenshot,
      routes: tour.routes,
      evidence: tour.evidence,
    };
  } finally {
    await page.close();
    if (video) {
      const automaticPath = await video.path();
      await video.saveAs(targetPath);
      if (path.resolve(automaticPath) !== path.resolve(targetPath)) await rm(automaticPath, { force: true });
    }
    await context.close();
  }
  const duration = await assertRecordedClipDuration(chapter, targetPath);
  return { recording: { ...recording, duration }, storageState: nextStorageState };
}

async function captureScenarioLabOverview(storageState) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    recordVideo: { dir: rawDir, size: { width: 1920, height: 1080 } },
    storageState,
  });
  // Never inherit a prior Scenario Lab token: the eight results in this frame
  // must be produced by this recording run in a fresh isolated workspace.
  await context.addInitScript(() => {
    window.localStorage.removeItem('aikefu_scenario_workspace_token');
  });
  const page = await context.newPage();
  const video = page.video();
  const chapter = SHOWCASE_VIDEO_TIMELINE.find((item) => item.id === 'scenario-lab-overview');
  if (!chapter) throw new Error('RECORDING_CHAPTER_NOT_FOUND:scenario-lab-overview');
  const targetPath = path.join(rawDir, '07-scenario-lab-overview.webm');
  let evidence;
  captureDiagnostics(page, 'scenario-lab');
  try {
    await page.goto(`${baseUrl}/scenario-lab?recording=1`, { waitUntil: 'domcontentloaded' });
    await expectScenarioLabSurface(page);
    const cases = page.locator('.scenario-index-list > button');
    await cases.first().waitFor({ state: 'visible', timeout: 30_000 });
    const count = await cases.count();
    if (count !== 8) throw new Error(`SCENARIO_LAB_CASE_COUNT:${count}/8`);

    const completed = [];
    for (let index = 0; index < count; index += 1) {
      await cases.nth(index).click();
      const runButton = page.getByRole('button', { name: '运行场景', exact: true });
      await runButton.waitFor({ state: 'visible', timeout: 30_000 });
      await runButton.click();
      await page.waitForFunction(() => {
        const status = document.querySelector('.scenario-detail-heading .status-badge')?.textContent?.trim();
        return status === 'SUCCEEDED' || status === 'FAILED';
      }, undefined, { timeout: 120_000, polling: 500 });
      const status = (await page.locator('.scenario-detail-heading .status-badge').first().innerText()).trim();
      if (status !== 'SUCCEEDED') throw new Error(`SCENARIO_LAB_CASE_FAILED:${index + 1}:${status}`);
      completed.push({ index: index + 1, status });
    }

    const finalCount = await page.locator('.scenario-index-list > button').count();
    if (finalCount !== 8 || completed.length !== 8) throw new Error(`SCENARIO_LAB_INCOMPLETE:${completed.length}/8`);
    await page.screenshot({ path: path.join(outputDir, '07-scenario-lab-overview.png') });
    evidence = { workspace: 'scenario', expectedCount: 8, completedCount: completed.length, statuses: completed, video: 'raw/07-scenario-lab-overview.webm' };
  } finally {
    await page.close();
    if (video) {
      const automaticPath = await video.path();
      await video.saveAs(targetPath);
      if (path.resolve(automaticPath) !== path.resolve(targetPath)) await rm(automaticPath, { force: true });
    }
    await context.close();
  }
  const duration = await assertRecordedClipDuration(chapter, targetPath);
  return { ...evidence, duration };
}

let sharedStorage;
try {
  const prepare = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce' });
  const preparePage = await prepare.newPage();
  captureDiagnostics(preparePage, 'prepare');
  await preparePage.goto(`${baseUrl}/showcase?recording=1`, { waitUntil: 'domcontentloaded' });
  await expectCaptureSurface(preparePage);
  providerLabel = await readProviderLabel(preparePage);
  await preparePage.screenshot({ path: path.join(outputDir, '00-recording-overview.png') });
  sharedStorage = await prepare.storageState();
  await prepare.close();

  for (const scenario of scenarios) {
    const chapter = SHOWCASE_VIDEO_TIMELINE.find((item) => item.id === scenario.chapter);
    if (!chapter) throw new Error(`RECORDING_CHAPTER_NOT_FOUND:${scenario.chapter}`);
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      recordVideo: { dir: rawDir, size: { width: 1920, height: 1080 } },
      locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', storageState: sharedStorage,
    });
    const recordingStartedAt = Date.now();
    const page = await context.newPage();
    const video = page.video();
    const targetPath = path.join(rawDir, scenario.video);
    let clip;
    try {
      captureDiagnostics(page, scenario.id);
      await page.goto(`${baseUrl}/showcase?recording=1`, { waitUntil: 'domcontentloaded' });
      await expectCaptureSurface(page);
      const observedProvider = await readProviderLabel(page);
      if (observedProvider !== providerLabel) throw new Error(`RECORDING_PROVIDER_CHANGED:${providerLabel}->${observedProvider}`);
      await clickScenario(page, scenario);
      await page.getByRole('button', { name: '开始演示', exact: true }).click();
      await waitForShowcaseScenario(page);
      await page.getByText(scenario.proof).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
      await waitForScenarioCapture(page, scenario);
      if (!traceCaptured) traceCaptured = await captureTrace(page, scenario);
      await page.screenshot({ path: path.join(outputDir, scenario.screenshot) });
      let evidenceDwellMs;
      try {
        evidenceDwellMs = resolveEvidenceDwellMs(
          Date.now() - recordingStartedAt,
          chapterPlaybackTargetSeconds(SHOWCASE_VIDEO_TIMELINE, chapter.id),
        );
      } catch (error) {
        throw new Error(`RECORDING_SCENARIO_DURATION:${scenario.id}:${error instanceof Error ? error.message : String(error)}`);
      }
      if (evidenceDwellMs > 0) await page.waitForTimeout(evidenceDwellMs);
      // The short dwell above only keeps the completed evidence readable. The
      // duration guard below still rejects any run that would need a long hold,
      // slowed playback or more than 1.25x acceleration.
      clip = {
        scenarioId: scenario.id,
        button: scenario.selector.name ?? scenario.override.button ?? null,
        proof: scenario.proofLabel,
        screenshot: scenario.screenshot,
        chapter: scenario.chapter,
        durationTargetSeconds: chapter.end - chapter.start,
        output: `raw/${scenario.video}`,
      };
    } finally {
      await page.close();
      if (video) {
        const automaticPath = await video.path();
        await video.saveAs(targetPath);
        if (path.resolve(automaticPath) !== path.resolve(targetPath)) await rm(automaticPath, { force: true });
      }
      await context.close();
    }
    if (!clip) throw new Error(`RECORDING_CLIP_EVIDENCE_MISSING:${scenario.id}`);
    const duration = await assertRecordedClipDuration(chapter, targetPath);
    clips.push({ ...clip, duration });
  }

  if (!traceCaptured) throw new Error('RECORDING_TRACE_NOT_CAPTURED');
  let operationalStorage = sharedStorage;
  for (const tour of SHOWCASE_PRODUCT_TOUR_RECORDING_SLOTS) {
    const captured = await captureProductTour(operationalStorage, tour);
    productTours.push(captured.recording);
    operationalStorage = captured.storageState;
  }
  scenarioLabEvidence = await captureScenarioLabOverview(sharedStorage);

  const closing = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce', storageState: sharedStorage });
  const closingPage = await closing.newPage();
  captureDiagnostics(closingPage, 'closing');
  await closingPage.goto(`${baseUrl}/showcase?recording=1&closing=1`, { waitUntil: 'domcontentloaded' });
  await closingPage.getByRole('heading', { name: '让每一次 AI 回复都可追踪、可降级、可恢复' }).waitFor({ state: 'visible', timeout: 30_000 });
  await closingPage.screenshot({ path: path.join(outputDir, '06-closing.png') });
  await closing.close();
} finally {
  await browser.close();
}

if (diagnostics.length) throw new Error(`RECORDING_BROWSER_DIAGNOSTICS:\n${diagnostics.join('\n')}`);

const manifest = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  viewport: { width: 1920, height: 1080 },
  provider: providerLabel,
  providerSource: 'live-showcase-mode',
  platform: 'MockDouyin',
  dataBoundary: 'SYNTHETIC_ONLY',
  clips,
  productTours,
  trace: { screenshot: '05-developer-trace.png', captured: traceCaptured },
  scenarioLab: scenarioLabEvidence,
};
await writeFile(path.join(outputDir, 'recording-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`SHOWCASE_RECORDING_MANIFEST=${path.join(outputDir, 'recording-manifest.json')}`);
console.log(`SHOWCASE_RECORDING_CLIPS=${clips.length}`);
console.log(`SHOWCASE_RECORDING_PRODUCT_TOURS=${productTours.length}`);
console.log(`SHOWCASE_RECORDING_PROVIDER=${providerLabel}`);
console.log(`SHOWCASE_SCENARIO_LAB_CASES=${scenarioLabEvidence.completedCount}`);

function readSelectorOverrides(value) {
  if (!value?.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('RECORDING_SCENARIO_SELECTORS_INVALID_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('RECORDING_SCENARIO_SELECTORS_INVALID_SHAPE');
  return parsed;
}

function fallbackButtonNames(id) {
  if (id === 'SC05') return ['5 安全问候，无需知识也可自然回复', '5 安全问候与边界', '5 安全问候', '5 安全问候与安全边界', 'SC05'];
  if (id === 'SC06') return ['6 店铺 AI 关闭后只处理未来消息', '6 AI 暂停与恢复', '6 AI 关闭与恢复', '6 暂停 AI 与恢复', 'SC06'];
  return [];
}

function scenarioProof(id) {
  if (id === 'SC05') return /您好，我在的|安全问候|低风险|边界清晰/;
  if (id === 'SC06') return /关闭期间未产生|重新开启|未来消息|您好，我在的/;
  if (id === 'SC01') return /不建议烘干/;
  if (id === 'SC02') return /AI草稿|轻薄连帽卫衣/;
  if (id === 'SC03') return /旧回复已失效|新疆|偏远地区/;
  return /高风险售后已进入人工|商品破损图片|疑似商品破损/;
}

function scenarioProofLabel(id) {
  if (id === 'SC05') return '安全问候真实结果与状态留痕';
  if (id === 'SC06') return 'AI 暂停/恢复真实状态与人工接管';
  if (id === 'SC01') return '买家可见回答包含“不建议烘干”';
  if (id === 'SC02') return '店铺端显示同一商品的真实 AI 草稿';
  if (id === 'SC03') return '旧回复失效且新回复已投影到买家端';
  return '图片分析可见且高风险售后进入人工';
}

function scenarioFileStem(id) {
  if (id === 'SC01') return 'product-care';
  if (id === 'SC02') return 'multi-turn';
  if (id === 'SC03') return 'stale-replan';
  if (id === 'SC04') return 'image-human';
  if (id === 'SC05') return 'safe-greeting';
  return 'ai-pause-recovery';
}
