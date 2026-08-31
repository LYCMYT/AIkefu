import { chromium } from '@playwright/test';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const baseUrl = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:5173';
const outputDir = path.join(root, 'artifacts', 'demo');
const rawDir = path.join(outputDir, 'raw');
const outputPath = path.join(outputDir, 'aikefu-3min-demo-source.webm');

await mkdir(outputDir, { recursive: true });
await rm(rawDir, { recursive: true, force: true });
await mkdir(rawDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: rawDir, size: { width: 1440, height: 900 } },
  locale: 'zh-CN',
  colorScheme: 'light',
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const video = page.video();
const startedAt = Date.now();
const pageErrors = [];

page.on('pageerror', (error) => pageErrors.push(error.message));

async function at(second) {
  const remaining = startedAt + second * 1_000 - Date.now();
  if (remaining > 0) await page.waitForTimeout(remaining);
}

async function goto(route, readyText) {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
  if (readyText) {
    await page.getByText(readyText, { exact: false }).first().waitFor({
      state: 'visible',
      timeout: 30_000,
    });
  }
}

async function overlay(title, subtitle, options = {}) {
  const { center = false, eyebrow = 'AIKEFU · LIVE DEMO' } = options;
  await page.evaluate(
    ({ title, subtitle, center, eyebrow }) => {
      document.getElementById('codex-demo-overlay')?.remove();
      const root = document.createElement('section');
      root.id = 'codex-demo-overlay';
      root.setAttribute('aria-label', '演示章节字幕');
      root.innerHTML = `
        <div class="codex-demo-eyebrow"></div>
        <strong class="codex-demo-title"></strong>
        <span class="codex-demo-subtitle"></span>
      `;
      root.querySelector('.codex-demo-eyebrow').textContent = eyebrow;
      root.querySelector('.codex-demo-title').textContent = title;
      root.querySelector('.codex-demo-subtitle').textContent = subtitle;
      Object.assign(root.style, {
        position: 'fixed',
        zIndex: '2147483647',
        left: center ? '50%' : '28px',
        top: center ? '50%' : 'auto',
        bottom: center ? 'auto' : '28px',
        transform: center ? 'translate(-50%, -50%)' : 'translateY(0)',
        width: center ? 'min(760px, calc(100vw - 80px))' : 'min(620px, calc(100vw - 56px))',
        boxSizing: 'border-box',
        padding: center ? '34px 40px 36px' : '17px 22px 19px',
        border: '1px solid rgba(129, 140, 248, .34)',
        borderRadius: center ? '24px' : '16px',
        background: center ? 'rgba(11, 20, 40, .96)' : 'rgba(11, 20, 40, .92)',
        boxShadow: '0 24px 70px rgba(15, 23, 42, .34)',
        color: '#fff',
        fontFamily: 'Inter, "Microsoft YaHei", system-ui, sans-serif',
        backdropFilter: 'blur(16px)',
        pointerEvents: 'none',
      });
      const eyebrowNode = root.querySelector('.codex-demo-eyebrow');
      Object.assign(eyebrowNode.style, {
        marginBottom: '9px',
        color: '#a5b4fc',
        fontSize: center ? '14px' : '11px',
        fontWeight: '800',
        letterSpacing: '.16em',
      });
      const titleNode = root.querySelector('.codex-demo-title');
      Object.assign(titleNode.style, {
        display: 'block',
        fontSize: center ? '34px' : '21px',
        lineHeight: '1.25',
        letterSpacing: '-.02em',
      });
      const subtitleNode = root.querySelector('.codex-demo-subtitle');
      Object.assign(subtitleNode.style, {
        display: 'block',
        marginTop: '9px',
        color: '#dbe4ff',
        fontSize: center ? '17px' : '14px',
        lineHeight: '1.65',
      });
      document.body.appendChild(root);
    },
    { title, subtitle, center, eyebrow },
  );
}

async function clearOverlay() {
  await page.evaluate(() => document.getElementById('codex-demo-overlay')?.remove());
}

async function highlight(locator, duration = 1_600) {
  try {
    await locator.first().scrollIntoViewIfNeeded();
    await locator.first().evaluate((node) => {
      node.dataset.codexDemoOriginalOutline = node.style.outline;
      node.dataset.codexDemoOriginalOffset = node.style.outlineOffset;
      node.style.outline = '3px solid #6366f1';
      node.style.outlineOffset = '4px';
    });
    await page.waitForTimeout(duration);
    await locator.first().evaluate((node) => {
      node.style.outline = node.dataset.codexDemoOriginalOutline ?? '';
      node.style.outlineOffset = node.dataset.codexDemoOriginalOffset ?? '';
      delete node.dataset.codexDemoOriginalOutline;
      delete node.dataset.codexDemoOriginalOffset;
    });
  } catch {
    // The product may refresh the highlighted node through WebSocket updates.
  }
}

async function sendBuyerMessage(text) {
  const composer = page.getByPlaceholder(/输入咨询内容/);
  await composer.fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await composer.waitFor({ state: 'visible' });
  await page.waitForTimeout(900);
}

try {
  await goto('/workbench', '消息工作台');
  await overlay(
    'AIkefu · 多租户 AI 客服工作台',
    '真实 PostgreSQL、Redis、MinIO 与可审计 AI 回复链路 · 3 分钟产品演示',
    { center: true, eyebrow: 'PORTFOLIO DEMO · SYNTHETIC DATA ONLY' },
  );
  await at(8);
  await clearOverlay();

  await overlay(
    '01 · 统一客服工作台',
    '会话、消息、AI Draft、订单、商品与人工记忆在同一界面协作。',
  );
  await highlight(page.getByRole('main').first(), 1_200);
  await at(18);
  await clearOverlay();

  await goto('/buyer-simulator', '买家模拟器');
  await overlay(
    '02 · 买家连续咨询',
    '通过 MockDouyin 发送三条真实入站消息，后端会进行 Turn 聚合与幂等处理。',
  );
  const reset = page.getByRole('button', { name: '重置演示' });
  if (await reset.isVisible().catch(() => false)) {
    await reset.click();
    await page.getByRole('combobox', { name: '买家' }).waitFor({ state: 'visible', timeout: 30_000 });
  }
  await at(29);
  await sendBuyerMessage('你好');
  await sendBuyerMessage('什么时候发货？');
  await sendBuyerMessage('我是新疆的');
  await highlight(page.locator('.phone-messages'), 1_800);
  await at(48);
  await clearOverlay();

  await overlay(
    '消息已进入真实服务链',
    '三条消息在短窗口内被聚合为一个 UserTurn，避免重复规划与重复回复。',
  );
  await at(55);
  await clearOverlay();

  await goto('/workbench', '消息工作台');
  await page.getByText('我是新疆的', { exact: false }).first().waitFor({
    state: 'visible',
    timeout: 20_000,
  }).catch(() => undefined);
  await overlay(
    '03 · AI 草稿与人工接管',
    '系统基于店铺知识与偏远地区规则生成草稿；高风险或不确定场景由人工确认。',
  );
  await highlight(page.getByLabel('AI Draft 与 Human Final'), 1_600);
  await at(68);

  const chat = page.getByRole('region', { name: '聊天与消息' });
  const takeover = chat.getByRole('button', { name: '人工接管', exact: true });
  if (await takeover.isVisible().catch(() => false)) {
    await takeover.click();
    await chat.getByText('人工接管中', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  }
  const humanComposer = chat.getByPlaceholder('以客服身份回复…');
  if (await humanComposer.isVisible().catch(() => false)) {
    await humanComposer.fill('您好，新疆地区预计 72 小时内发货，我会继续为您跟进物流。');
    await highlight(humanComposer, 1_200);
    await chat.getByRole('button', { name: '发送回复', exact: true }).click();
  }
  await at(84);
  await clearOverlay();

  await goto('/admin', '数据概览');
  await overlay(
    '04 · 运营数据总览',
    '所有指标都来自当前 Workspace 的真实快照；无数据时明确显示空态，不伪造趋势。',
  );
  const period = page.getByLabel('总览时间范围');
  if (await period.isVisible().catch(() => false)) {
    await period.selectOption('30');
    await page.waitForTimeout(1_200);
    await period.selectOption('7');
  }
  await at(101);
  await clearOverlay();

  await goto('/admin/shops', '店铺配置');
  await overlay(
    '05 · 多店铺策略与 Kill Switch',
    '每家店独立配置 AUTO / ASSIST / MANUAL；降级会使旧任务与待发送消息立即失效。',
  );
  await highlight(page.locator('[aria-label="店铺列表"]'), 1_800);
  await at(118);
  await clearOverlay();

  await goto('/admin/knowledge', '正式知识');
  await overlay(
    '06 · 知识治理与安全导入',
    '正式、候选、冲突、学习任务四个视图；动态商业事实与冲突不会进入静态 RAG。',
  );
  const learningTab = page.getByRole('tab', { name: /学习任务/ });
  if (await learningTab.isVisible().catch(() => false)) {
    await learningTab.click();
    await page.waitForTimeout(1_300);
  }
  const publishedTab = page.getByRole('tab', { name: /正式知识/ });
  if (await publishedTab.isVisible().catch(() => false)) await publishedTab.click();
  await highlight(page.getByLabel('知识导入任务'), 1_500);
  await at(139);
  await clearOverlay();

  await goto('/admin/workflows', '流程画布');
  await overlay(
    '07 · 可发布工作流与人工审批',
    '版本化图编排、运行恢复、Action Proposal 与人工审批形成完整可审计闭环。',
  );
  const fit = page.getByRole('button', { name: '适应画布' });
  if (await fit.isVisible().catch(() => false)) await fit.click();
  const zoomIn = page.getByRole('button', { name: '放大画布' });
  if (await zoomIn.isVisible().catch(() => false)) {
    await zoomIn.click();
    await page.waitForTimeout(1_000);
    if (await fit.isVisible().catch(() => false)) await fit.click();
  }
  await at(159);
  await clearOverlay();

  await goto('/scenario-lab', '场景实验室');
  await overlay(
    '08 · 八个可复现验收场景',
    '连续消息、跨店隔离、动态库存、澄清、接管与崩溃恢复均可独立运行并查看 Trace。',
  );
  const case08 = page.getByRole('button', { name: /多订单澄清|Case 08|两轮澄清/ }).first();
  if (await case08.isVisible().catch(() => false)) await case08.click();
  await highlight(page.getByRole('button', { name: '运行场景' }), 1_500);
  await at(176);
  await clearOverlay();

  await overlay(
    '从真实消息到可审计回复',
    '多租户隔离 · Evidence 驱动 · Human-in-the-loop · Durable Recovery',
    { center: true, eyebrow: 'AIKEFU · DEMO COMPLETE' },
  );
  await at(184);
  await clearOverlay();
} finally {
  await page.close();
  await video?.saveAs(outputPath);
  await context.close();
  await browser.close();
}

if (pageErrors.length > 0) {
  console.warn(`录制期间捕获到 ${pageErrors.length} 个页面错误：`);
  for (const error of pageErrors) console.warn(`- ${error}`);
}

console.log(`DEMO_VIDEO=${outputPath}`);
