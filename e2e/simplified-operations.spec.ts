import { expect, test } from '@playwright/test';
import {
  captureConsoleDiagnostics,
  createOperationalShop,
  expectConnected,
  expectNoDiagnostics,
  expectNoGlobalOverflow,
} from './rearchitecture-helpers';

test('operational EMPTY workspace creates a fashion shop and keeps AI gating explicit', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(
    process.env.RUN_REAL_INFRA_E2E !== '1',
    'requires the local PostgreSQL, Redis, MinIO, API and Web stack',
  );
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  const { name } = await createOperationalShop(page, `Luna-AUTO-${Date.now()}`, { expectInitialReadiness: true });
  const aiSwitch = page.getByRole('checkbox', { name: `${name} AI 开关` });
  await expect(aiSwitch).toBeChecked();

  // The switch is the durable shop-level upper bound. Turning it off must
  // visibly fail closed, while the learning job itself remains independent.
  // The visual switch track intentionally sits over the native checkbox and
  // the API mutation is asynchronous. Click the semantic input, then wait on
  // the durable controlled state instead of Playwright's immediate checkbox
  // assertion.
  await aiSwitch.click({ force: true });
  await expect(aiSwitch).not.toBeChecked({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: `${name} AI 已停止` })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('status')).toContainText('会话 AI 已停止', { timeout: 30_000 });

  await aiSwitch.click({ force: true });
  await expect(aiSwitch).toBeChecked({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: `${name} AI 已就绪` })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('status')).toContainText('AI 已开启', { timeout: 30_000 });

  await expectConnected(page);
  await expectNoGlobalOverflow(page);
  await expectNoDiagnostics(diagnostics);
});
