import { expect, test } from '@playwright/test';
import { captureConsoleDiagnostics, expectConnected, expectNoDiagnostics, expectNoGlobalOverflow } from './rearchitecture-helpers';

const realInfraReason = 'requires the migrated PostgreSQL/Redis/MinIO stack and running API/Web';

test('guided showcase completes SC05 safe greeting through the real API, WebSocket, database, and MockDouyin chain', async ({ page }) => {
  test.setTimeout(150_000);
  test.skip(process.env.RUN_REAL_INFRA_E2E !== '1', realInfraReason);
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/showcase');
  await expect(page.getByRole('heading', { level: 1, name: '引导演示' })).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);

  await page.getByRole('button', { name: /5 安全问候/ }).click();
  await expect(page.getByText('场景 5/6 · 安全问候，无需知识也可自然回复')).toBeVisible();
  await page.getByRole('button', { name: '开始演示' }).click();

  await expect(page.getByText('场景已完成', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.live-message-bubble').filter({ hasText: '您好，我在的。您可以咨询商品、库存、订单、物流或售后问题。' }).last()).toBeVisible();
  await page.getByRole('button', { name: '技术证据' }).click();
  const trace = page.getByRole('dialog', { name: 'Developer Trace' });
  await expect(trace).toContainText('BUILT_IN_SAFE_REPLY');
  await expect(trace).toContainText('"intent": "GREETING"');
  await expect(trace).toContainText('EVIDENCE');
  await expect(trace).toContainText('"evidenceCount": 0');
  await expect(trace).toContainText('SEND_RECEIPT');
  await page.keyboard.press('Escape');
  await expectNoGlobalOverflow(page);
  await expectNoDiagnostics(diagnostics);
});

test('guided showcase keeps SC06 AI-off messages free of AI artifacts and only processes a future message after re-enable', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(process.env.RUN_REAL_INFRA_E2E !== '1', realInfraReason);
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/showcase');
  await expect(page.getByRole('heading', { level: 1, name: '引导演示' })).toBeVisible({ timeout: 30_000 });
  await expectConnected(page);

  await page.getByRole('button', { name: /6 店铺 AI 关闭后/ }).click();
  await expect(page.getByText('场景 6/6 · 店铺 AI 关闭后只处理未来消息')).toBeVisible();
  await page.getByRole('button', { name: '开始演示' }).click();

  await expect(page.getByText('场景已完成', { exact: true })).toBeVisible({ timeout: 150_000 });
  await expect(page.getByText('关闭期间未产生 AI Job、Draft 或 Outbox；重新开启后仅处理新的买家消息。')).toBeVisible();
  await expect(page.locator('.live-message-bubble').filter({ hasText: '关闭期间的消息不应在重新开启后被补处理。' }).last()).toBeVisible();
  await expect(page.locator('.live-message-bubble').filter({ hasText: '您好，我在的。您可以咨询商品、库存、订单、物流或售后问题。' }).last()).toBeVisible();
  await expect(page.locator('.live-draft-card')).toHaveCount(0);
  await expectNoGlobalOverflow(page);
  await expectNoDiagnostics(diagnostics);
});
