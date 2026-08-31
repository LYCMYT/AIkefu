import { expect, test, type Page } from '@playwright/test';
import { captureConsoleDiagnostics, createOperationalShop, expectConnected, expectNoDiagnostics, expectNoGlobalOverflow } from './rearchitecture-helpers';

const realInfraReason = 'requires the migrated PostgreSQL/Redis/MinIO stack and running API/Web';

const scenarios = [
  { button: '1 商品知识有据回答', title: '商品知识有据回答', proof: /不建议烘干/, screenshot: '01-product-care.png' },
  { button: '2 连续消息与多轮上下文', title: '连续消息与多轮上下文', proof: /AI草稿/, screenshot: '02-multi-turn.png' },
  { button: '3 生成中补充信息', title: '生成中补充信息', proof: /旧回复已失效，新回复通过发送守卫/, screenshot: '03-stale-replan.png' },
  { button: '4 图片售后与人工接管', title: '图片售后与人工接管', proof: /高风险售后已进入人工，未执行退款动作/, screenshot: '04-image-human.png' },
  { button: '5 安全问候，无需知识也可自然回复', title: '安全问候，无需知识也可自然回复', proof: /您好，我在的/, screenshot: '05-safe-greeting.png' },
  { button: '6 店铺 AI 关闭后只处理未来消息', title: '店铺 AI 关闭后只处理未来消息', proof: /您好，我在的/, screenshot: '06-ai-off-future-message.png' },
] as const;

async function expectCaptureReady(page: Page, title: (typeof scenarios)[number]['title']) {
  const pipeline = page.getByLabel('本轮消息处理状态');
  if (title === '商品知识有据回答') {
    await expect(page.locator('.live-message-bubble').filter({ hasText: /不建议.*烘干/ }).last()).toBeVisible();
    await expect(pipeline.locator('.live-pipeline-stage.is-done').filter({ hasText: '发送回执' })).toBeVisible();
    return;
  }
  if (title === '连续消息与多轮上下文') {
    const draft = page.locator('.live-draft-card');
    await expect(page.getByText('轻薄连帽卫衣', { exact: true }).last()).toBeVisible();
    await expect(draft).toBeVisible();
    await expect(draft).not.toContainText('请问您咨询的是哪件商品');
    return;
  }
  if (title === '生成中补充信息') {
    await expect(page.locator('.live-message-bubble').filter({ hasText: /新疆|偏远地区/ }).last()).toBeVisible();
    await expect(pipeline.locator('.live-pipeline-stage.is-done').filter({ hasText: '回复完成' })).toBeVisible();
    await expect(pipeline.locator('.live-pipeline-stage.is-done').filter({ hasText: '发送回执' })).toBeVisible();
    return;
  }
  if (title === '安全问候，无需知识也可自然回复' || title === '店铺 AI 关闭后只处理未来消息') {
    await expect(page.locator('.live-message-bubble').filter({ hasText: /您好，我在的/ }).last()).toBeVisible();
    await expect(pipeline.locator('.live-pipeline-stage.is-done').filter({ hasText: '发送回执' })).toBeVisible();
    return;
  }
  await expect(page.getByText('商品破损图片', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('疑似商品破损', { exact: true }).last()).toBeVisible();
  await expect(page.locator('.live-message-bubble').filter({ hasText: '（空消息）' })).toHaveCount(0);
}

test('recording mode is a clean 1920x1080 capture surface with an honest closing frame', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(process.env.RUN_REAL_INFRA_E2E !== '1', realInfraReason);
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/showcase?recording=1');
  await expect(page.getByRole('heading', { level: 1, name: '多店铺电商 AI 客服与 Agent 协同平台' })).toBeVisible({ timeout: 30_000 });
  const scenarioButtons = page.locator('[data-scenario-id]');
  await expect(scenarioButtons).toHaveCount(6);
  const scenarioCount = await scenarioButtons.count();
  await expect(page.getByLabel('录制进度')).toContainText(`SCENE 01 / ${String(scenarioCount).padStart(2, '0')}`);
  const providerLabel = await page.getByLabel('演示运行边界').locator('.showcase-mode').innerText();
  await expect(page.getByLabel('产品模块')).toHaveCount(0);
  await expect(page.getByText('AIkefu · MockDouyin 演示环境')).toHaveCount(0);
  await expectNoGlobalOverflow(page);
  expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual({ width: 1920, height: 1080 });

  await page.goto('/showcase?recording=1&closing=1');
  await expect(page.getByRole('heading', { level: 2, name: '让每一次 AI 回复都可追踪、可降级、可恢复' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('合成演示数据', { exact: true })).toBeVisible();
  await expect(page.getByText('MockDouyin', { exact: true })).toBeVisible();
  if (providerLabel.includes('DeepSeek')) await expect(page.getByText('DeepSeek（服务端配置）', { exact: true })).toBeVisible();
  else await expect(page.getByText('DeepSeek（服务端配置）', { exact: true })).toHaveCount(0);
  await expectNoGlobalOverflow(page);
  await expectNoDiagnostics(diagnostics);
});

test('recording mode remains capture-safe at 1440x900', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(process.env.RUN_REAL_INFRA_E2E !== '1', realInfraReason);
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/showcase?recording=1');
  await expect(page.getByRole('heading', { level: 1, name: '多店铺电商 AI 客服与 Agent 协同平台' })).toBeVisible({ timeout: 30_000 });
  await expectNoGlobalOverflow(page);
  expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual({ width: 1440, height: 900 });
  await expectNoDiagnostics(diagnostics);
});

for (const scenario of scenarios) {
  test(`guided showcase completes ${scenario.title} through the real service chain`, async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(process.env.RUN_REAL_INFRA_E2E !== '1', realInfraReason);
    const diagnostics = captureConsoleDiagnostics(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/showcase');
    await expect(page.getByRole('heading', { level: 1, name: '引导演示' })).toBeVisible({ timeout: 30_000 });
    await expectConnected(page);
    await page.getByRole('button', { name: scenario.button }).click();
    await page.getByRole('button', { name: '开始演示' }).click();
    await expect(page.getByText('场景已完成', { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(scenario.proof).last()).toBeVisible();
    await expectCaptureReady(page, scenario.title);
    await expect(page.getByRole('status')).not.toContainText(/not found|失败|error/i);
    await expectNoGlobalOverflow(page);
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0 }));
    await page.screenshot({ path: `artifacts/showcase/${scenario.screenshot}`, fullPage: false });

    await page.getByRole('button', { name: '技术证据' }).click();
    const trace = page.getByRole('dialog', { name: 'Developer Trace' });
    await expect(trace).toBeVisible();
    await expect(trace).toContainText('仅展示结构化脱敏元数据，不展示 Prompt 或思维链');
    await expect(trace.locator('pre').first()).toBeVisible();
    if (scenario.title === '图片售后与人工接管') {
      await page.screenshot({ path: 'artifacts/showcase/developer-trace.png', fullPage: false });
    }
    await page.keyboard.press('Escape');
    await expect(trace).toBeHidden();
    await expectNoDiagnostics(diagnostics);
  });
}

test('showcase session, reset, provider labels, and operational workspace remain isolated', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(process.env.RUN_REAL_INFRA_E2E !== '1', realInfraReason);
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize({ width: 1366, height: 768 });

  await page.goto('/workbench');
  await expect(page.getByRole('heading', { level: 1, name: '店铺工作台' })).toBeVisible({ timeout: 30_000 });
  const operationalToken = await page.evaluate(() => localStorage.getItem('aikefu_operational_workspace_token_v2'));
  expect(operationalToken).toBeTruthy();

  await page.goto('/showcase');
  await expect(page.getByRole('heading', { level: 1, name: '引导演示' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('演示运行边界')).toContainText(/真实模型|显式离线模式|真实模型未配置/);
  await expect(page.getByLabel('演示运行边界')).toContainText('Mock 电商平台');
  await expect(page.getByLabel('演示运行边界')).toContainText('全部合成数据');
  const showcaseToken = await page.evaluate(() => localStorage.getItem('aikefu_showcase_workspace_token'));
  expect(showcaseToken).toBeTruthy();
  expect(showcaseToken).not.toBe(operationalToken);
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0 }));
  await page.screenshot({ path: 'artifacts/showcase/showcase-overview.png', fullPage: false });

  await page.getByRole('button', { name: '重置演示' }).first().click();
  await expect(page.getByRole('button', { name: '重置演示' }).first()).toBeEnabled({ timeout: 60_000 });
  expect(await page.evaluate(() => localStorage.getItem('aikefu_operational_workspace_token_v2'))).toBe(operationalToken);
  expect(await page.evaluate(() => localStorage.getItem('aikefu_showcase_workspace_token'))).toBe(showcaseToken);
  await expectNoGlobalOverflow(page);
  await expectNoDiagnostics(diagnostics);
});

test('showcase switches to the compact live-test layout without horizontal overflow', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(process.env.RUN_REAL_INFRA_E2E !== '1', realInfraReason);
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/showcase');
  await expect(page.getByRole('heading', { level: 1, name: '引导演示' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('tab', { name: '买家端' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '店铺端' })).toBeVisible();
  await expectNoGlobalOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0 }));
  await page.screenshot({ path: 'artifacts/showcase/showcase-mobile-390x844.png', fullPage: false });
  await expectNoDiagnostics(diagnostics);
});

test('dashboard evidence is produced from a real isolated operational event', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(process.env.RUN_REAL_INFRA_E2E !== '1', realInfraReason);
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await createOperationalShop(page, `Showcase dashboard ${Date.now()}`);

  await page.goto('/buyer-simulator');
  await expect(page.getByRole('heading', { level: 1, name: '买家模拟器' }).first()).toBeVisible({ timeout: 30_000 });
  const message = `Showcase dashboard event ${Date.now()}`;
  await page.getByLabel('买家咨询内容').fill(message);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('消息已送入 MockDouyin 管线', { timeout: 30_000 });

  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: '数据概览' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Workspace 指标')).toContainText('今日进线');
  await expect(page.getByText(/最近 7 天 · [1-9]\d* 条会话/)).toBeVisible({ timeout: 30_000 });
  await expectNoGlobalOverflow(page);
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0 }));
  await page.screenshot({ path: 'artifacts/showcase/dashboard-after-run.png', fullPage: false });
  await expectNoDiagnostics(diagnostics);
});
