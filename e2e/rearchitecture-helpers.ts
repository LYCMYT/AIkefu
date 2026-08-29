import { expect, type Page } from '@playwright/test';

export interface ConsoleDiagnostics {
  level: 'error' | 'warn' | 'pageerror';
  text: string;
}

/** Collect only browser diagnostics that should fail a product gate. */
export function captureConsoleDiagnostics(page: Page): ConsoleDiagnostics[] {
  const diagnostics: ConsoleDiagnostics[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.push({ level: message.type() === 'error' ? 'error' : 'warn', text: message.text() });
    }
  });
  page.on('pageerror', (error) => diagnostics.push({ level: 'pageerror', text: error.message }));
  page.on('response', (response) => {
    if (response.status() === 404) diagnostics.push({ level: 'error', text: `HTTP 404 ${response.url()}` });
  });
  return diagnostics;
}

export async function expectNoGlobalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

export async function expectConnected(page: Page): Promise<void> {
  // The compact mobile shell intentionally hides the pagebar connection pill;
  // use the visible module/admin status region as the semantic fallback.
  await expect(page.locator(
      '[aria-label="服务状态：实时已连接"]:visible, '
      + '.module-topbar-status:has-text("实时已连接"):visible, '
      + '.sidebar-footer:has-text("实时已连接"):visible, '
      + '.page-footer:has-text("实时已连接"):visible',
  ).first()).toBeVisible({ timeout: 30_000 });
}

export async function createOperationalShop(
  page: Page,
  name = `E2E服饰店-${Date.now()}`,
  options: { expectInitialReadiness?: boolean } = {},
): Promise<{ name: string; shopId: string }> {
  await page.goto('/workbench');
  await expect(page.getByRole('heading', { level: 1, name: '店铺工作台' })).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expect(page.getByRole('heading', { level: 2, name: '添加第一家店铺，让 AI 客服开始工作' })).toBeVisible();

  await page.getByRole('button', { name: '添加店铺', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加店铺' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('店铺名称', { exact: true }).fill(name);
  await dialog.getByRole('radio', { name: /服饰店/ }).check();
  await dialog.getByRole('button', { name: '添加并进入工作台', exact: true }).click();

  await expect(page).toHaveURL(/\/workbench\/shops\/[^/]+$/);
  const shopId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
  await expect(page.getByRole('button', { name: new RegExp(`${escapeRegExp(name)} AI `) })).toBeVisible({ timeout: 30_000 });
  // Learning may already be complete on a fast worker, but an unreviewed shop
  // must still stay PREPARING until the operator confirms its copied policies.
  await expect(page.getByRole('button', { name: new RegExp(`${escapeRegExp(name)} AI 正在准备`) })).toBeVisible({ timeout: 30_000 });
  if (options.expectInitialReadiness) {
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(`${escapeRegExp(name)} 还需一步`) })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: '确认基础设置', exact: true })).toBeVisible();
  }

  await page.goto(`/workbench/shops/${encodeURIComponent(shopId)}/settings`);
  await expect(page.getByRole('heading', { level: 2, name: '基础设置' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('status')).toContainText('保存确认前，即使商品学习完成，AI 也不会自动发送');
  const welcome = page.getByLabel('进线欢迎语');
  await expect(welcome).toHaveValue(new RegExp(escapeRegExp(name)));
  await expect(welcome).not.toHaveValue(/MIA Fashion|Pixel Tech/);
  await page.getByRole('button', { name: '确认并启用 AI', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('设置已确认', { timeout: 30_000 });
  await page.goto(`/workbench/shops/${encodeURIComponent(shopId)}`);

  // Readiness must reflect both a durable SUCCEEDED learning job and the
  // explicit settings confirmation performed above.
  await expect(page.getByRole('button', { name: new RegExp(`${escapeRegExp(name)} AI 已就绪`) })).toBeVisible({ timeout: 120_000 });
  return { name, shopId };
}

export async function expectNoDiagnostics(diagnostics: ConsoleDiagnostics[]): Promise<void> {
  expect(diagnostics, diagnostics.map((item) => `${item.level}: ${item.text}`).join('\n')).toEqual([]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
