import { expect, test } from '@playwright/test';

const entries = [
  { route: '/workbench', heading: '消息工作台' },
  { route: '/buyer-simulator', heading: '买家模拟器' },
  { route: '/admin', heading: '数据概览' },
  { route: '/scenario-lab', heading: '场景实验室' },
] as const;

for (const entry of entries) {
  test(`${entry.route} exposes a recoverable Foundation boundary`, async ({ page }) => {
    test.skip(process.env.RUN_REAL_INFRA_E2E === '1', 'fallback boundary is covered only when the real stack is disabled');
    await page.goto(entry.route);
    await expect(page.getByRole('heading', { level: 1, name: entry.heading })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('尚未连接到 Foundation API');
    await expect(page.getByRole('button', { name: '重新连接' })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  });
}

test('the four primary entry links remain discoverable on desktop and narrow screens', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/workbench');
    const navigation = page.getByRole('navigation', { name: 'Primary' });
    await expect(navigation.getByRole('link', { name: /工作台/ })).toBeVisible();
    await expect(navigation.getByRole('link', { name: /买家模拟器/ })).toBeVisible();
    await expect(navigation.getByRole('link', { name: /运营后台/ })).toBeVisible();
    await expect(navigation.getByRole('link', { name: /场景实验室/ })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflow).toBe(false);
  }
});

test('admin overview alias and shops subroute stay routable', async ({ page }) => {
  await page.goto('/admin/overview');
  await expect(page.getByRole('heading', { level: 1, name: '数据概览' })).toBeVisible();
  await page.goto('/admin/shops');
  await expect(page.getByRole('heading', { level: 1, name: '店铺配置' })).toBeVisible();
});

test('real-infrastructure entry state is opt-in and never confused with the fallback gate', async ({ page }) => {
  test.skip(process.env.RUN_REAL_INFRA_E2E !== '1', 'requires a migrated PostgreSQL/Redis/MinIO stack and running API/Web');
  for (const entry of entries) {
    await page.goto(entry.route);
    await expect(page.getByRole('heading', { level: 1, name: entry.heading })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/API READY/)).toBeVisible();
  }
});
