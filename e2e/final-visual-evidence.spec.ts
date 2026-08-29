import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  captureConsoleDiagnostics,
  createOperationalShop,
  expectConnected,
  expectNoDiagnostics,
  expectNoGlobalOverflow,
} from './rearchitecture-helpers';

const FINAL_VIEWPORT = { width: 1440, height: 900 } as const;

async function saveFinalScreenshot(page: Parameters<typeof captureConsoleDiagnostics>[0], name: string) {
  const directory = resolve(process.cwd(), 'artifacts/ui/final');
  mkdirSync(directory, { recursive: true });
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: resolve(directory, `${name}.png`),
    fullPage: false,
  });
}

test('final visual evidence covers the real operational and scenario surfaces', async ({ page }) => {
  test.setTimeout(300_000);
  test.skip(
    process.env.RUN_REAL_INFRA_E2E !== '1',
    'requires the local PostgreSQL, Redis, MinIO, API and Web stack',
  );
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize(FINAL_VIEWPORT);

  // Capture the true first-run EMPTY state before creating any shop.
  await page.goto('/workbench');
  await expect(page.getByRole('heading', { level: 1, name: '店铺工作台' })).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expect(page.getByRole('heading', { level: 2, name: '添加第一家店铺，让 AI 客服开始工作' })).toBeVisible();
  await expectNoGlobalOverflow(page);
  await saveFinalScreenshot(page, 'empty-home');

  const { shopId } = await createOperationalShop(page, `Luna-final-${Date.now()}`);
  const shopPath = `/workbench/shops/${encodeURIComponent(shopId)}`;

  await expect(page.getByRole('heading', { level: 1, name: '店铺工作台' })).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expectNoGlobalOverflow(page);
  await saveFinalScreenshot(page, 'shop-overview');

  // Use the real buyer event so the chat screenshot represents a populated
  // conversation rather than a fabricated local message.
  await page.goto('/buyer-simulator');
  await expect(page.getByRole('heading', { level: 1, name: '买家模拟器' }).first()).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expect(page.getByLabel('买家咨询内容')).toBeVisible({ timeout: 30_000 });
  const message = `Luna final visual ${Date.now()}`;
  await page.getByLabel('买家咨询内容').fill(message);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('status')).toContainText('消息已送入 MockDouyin 管线', { timeout: 30_000 });
  await expect(page.getByLabel('买家咨询内容')).toHaveValue('');
  await expectNoGlobalOverflow(page);
  await saveFinalScreenshot(page, 'buyer-simulator');

  await page.goto(shopPath);
  await expect(page.getByRole('heading', { level: 1, name: '店铺工作台' })).toBeVisible({ timeout: 30_000 });
  // The scheduled welcome can legitimately become the latest conversation
  // preview before this page loads. Select the sole real conversation, then
  // prove that the buyer message itself is present in the durable transcript.
  const conversation = page.getByRole('region', { name: '会话列表' }).locator('.conversation-row').first();
  await expect(conversation).toBeVisible({ timeout: 45_000 });
  await conversation.click();
  await expect(page.getByRole('region', { name: '聊天与消息' }).getByText(message, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expectNoGlobalOverflow(page);
  await saveFinalScreenshot(page, 'shop-chat');

  await page.goto(`${shopPath}/settings`);
  await expect(page.getByRole('heading', { level: 2, name: '基础设置' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('客服语气')).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expectNoGlobalOverflow(page);
  await saveFinalScreenshot(page, 'shop-settings');

  await page.goto(`${shopPath}/knowledge/import`);
  await expect(page.getByRole('heading', { level: 2, name: '导入知识' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /选择 Excel \/ CSV 文件/ })).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expectNoGlobalOverflow(page);
  await saveFinalScreenshot(page, 'knowledge-import');

  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: '数据概览' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 2, name: '数据概览' })).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expectNoGlobalOverflow(page);
  await saveFinalScreenshot(page, 'admin');

  await page.goto('/admin/workflows');
  await expect(page.getByRole('heading', { level: 1, name: '工作流' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/工作流快照|正在读取工作流快照/).first()).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expectNoGlobalOverflow(page);
  await saveFinalScreenshot(page, 'workflow');

  await page.goto(`/live-test/${encodeURIComponent(shopId)}`);
  await expect(page.getByRole('heading', { level: 1, name: '实时联调' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('实时连接：已连接')).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expectNoGlobalOverflow(page);
  await saveFinalScreenshot(page, 'live-test');

  await page.goto('/scenario-lab');
  await expect(page.getByRole('heading', { level: 1, name: '场景实验室' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('连续消息聚合', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);
  await expectNoGlobalOverflow(page);
  await saveFinalScreenshot(page, 'scenario-lab');

  // Keep this assertion at the end so every screenshot route contributes to
  // one auditable zero-warning/error result.
  await expectNoDiagnostics(diagnostics);
});
