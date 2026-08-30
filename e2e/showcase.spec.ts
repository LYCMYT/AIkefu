import { expect, test } from '@playwright/test';
import { captureConsoleDiagnostics, createOperationalShop, expectConnected, expectNoDiagnostics, expectNoGlobalOverflow } from './rearchitecture-helpers';

const realInfraReason = 'requires the migrated PostgreSQL/Redis/MinIO stack and running API/Web';

const scenarios = [
  { button: '1 商品知识有据回答', title: '商品知识有据回答', proof: /不建议烘干/, screenshot: '01-product-care.png' },
  { button: '2 连续消息与多轮上下文', title: '连续消息与多轮上下文', proof: /AI草稿/, screenshot: '02-multi-turn.png' },
  { button: '3 生成中补充信息', title: '生成中补充信息', proof: /旧回复已失效，新回复通过发送守卫/, screenshot: '03-stale-replan.png' },
  { button: '4 图片售后与人工接管', title: '图片售后与人工接管', proof: /高风险售后已进入人工，未执行退款动作/, screenshot: '04-image-human.png' },
] as const;

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
