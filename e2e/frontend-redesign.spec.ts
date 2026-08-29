import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  captureConsoleDiagnostics,
  createOperationalShop,
  expectConnected,
  expectNoDiagnostics,
  expectNoGlobalOverflow,
} from './rearchitecture-helpers';

const viewports = [
  { width: 1280, height: 800 },
  { width: 1366, height: 850 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
] as const;

async function attach(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' });
}

test('rearchitected routes stay usable at release viewport widths', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  test.skip(
    process.env.RUN_REAL_INFRA_E2E !== '1',
    'requires the local PostgreSQL, Redis, MinIO, API and Web stack',
  );
  const diagnostics = captureConsoleDiagnostics(page);
  const { shopId, name } = await createOperationalShop(page, `Luna-visual-${Date.now()}`);
  const shopPath = `/workbench/shops/${encodeURIComponent(shopId)}`;
  const routes = [
    { path: shopPath, heading: '店铺工作台' },
    { path: `${shopPath}/settings`, heading: '基础设置' },
    { path: `${shopPath}/knowledge/import`, heading: '导入知识' },
    { path: `/live-test/${encodeURIComponent(shopId)}`, heading: '实时联调' },
    { path: '/buyer-simulator', heading: '买家模拟器' },
    { path: '/admin', heading: '数据概览' },
  ] as const;

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible({ timeout: 30_000 });
      await expectConnected(page);
      await expectNoGlobalOverflow(page);
      if (viewport.width === 1440 && route.path === shopPath) await attach(page, testInfo, 'workbench-1440x900');
      if (viewport.width === 390 && route.path.startsWith('/live-test/')) await attach(page, testInfo, 'live-test-390x844');
    }
    // Keep the active operational shop visible after each route sweep. This
    // also catches a route transition accidentally returning to EMPTY state.
    await page.goto(shopPath);
    await expect(page.getByRole('button', { name: new RegExp(`${name} AI `) })).toBeVisible({ timeout: 30_000 });
    await expectNoGlobalOverflow(page);
  }

  await expectNoDiagnostics(diagnostics);
});

test('scenario lab is seeded independently from the operational shop token', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(
    process.env.RUN_REAL_INFRA_E2E !== '1',
    'requires the local PostgreSQL, Redis, MinIO, API and Web stack',
  );
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const { name } = await createOperationalShop(page, `Luna-scope-${Date.now()}`);

  await page.goto('/scenario-lab');
  await expect(page.getByRole('heading', { level: 1, name: '场景实验室' })).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expect(page.getByText('连续消息聚合', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('固定八个合成场景', { exact: false })).toBeVisible();

  await page.goto('/workbench');
  await expect(page.getByRole('heading', { level: 1, name: '店铺工作台' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: new RegExp(`${name} AI `) })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 2, name: '添加第一家店铺，让 AI 客服开始工作' })).toHaveCount(0);
  await expectNoGlobalOverflow(page);
  await expectNoDiagnostics(diagnostics);
});
