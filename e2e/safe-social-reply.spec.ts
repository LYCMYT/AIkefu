import { expect, test } from '@playwright/test';
import {
  captureConsoleDiagnostics,
  createOperationalShop,
  expectConnected,
  expectNoDiagnostics,
} from './rearchitecture-helpers';

test('safe social turns reply without knowledge while mixed business text still uses shop evidence', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(
    process.env.RUN_REAL_INFRA_E2E !== '1',
    'requires the migrated PostgreSQL/Redis/MinIO stack and running API/Web',
  );
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await createOperationalShop(page, `Greeting-flow-${Date.now()}`);

  await page.goto('/buyer-simulator');
  await expectConnected(page);
  await expect(page.getByRole('combobox', { name: '买家' })).not.toHaveValue('', { timeout: 30_000 });

  const input = page.getByPlaceholder('输入咨询内容…');
  await input.fill('你好');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('您好，我在的。您可以咨询商品、库存、订单、物流或售后问题。', { exact: true }))
    .toBeVisible({ timeout: 60_000 });

  await input.fill('你好，请问多久发货？');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('普通现货商品通常在24小时内发出；预售商品以商品说明为准。', { exact: true }))
    .toBeVisible({ timeout: 60_000 });

  await expectNoDiagnostics(diagnostics);
});
