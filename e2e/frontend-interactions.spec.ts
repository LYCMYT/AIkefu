import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import {
  captureConsoleDiagnostics,
  createOperationalShop,
  expectConnected,
  expectNoDiagnostics,
  expectNoGlobalOverflow,
} from './rearchitecture-helpers';

test('shop actions menu has keyboard focus management and scoped routes', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(
    process.env.RUN_REAL_INFRA_E2E !== '1',
    'requires the local PostgreSQL, Redis, MinIO, API and Web stack',
  );
  const diagnostics = captureConsoleDiagnostics(page);
  await page.setViewportSize({ width: 1366, height: 850 });
  const { name, shopId } = await createOperationalShop(page, `Luna-menu-${Date.now()}`);

  const trigger = page.getByRole('button', { name: `${name} 更多操作` });
  await trigger.focus();
  await trigger.click();
  const menu = page.getByRole('menu', { name: '店铺操作' });
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await menu.getByRole('menuitem', { name: '基础设置' }).click();
  await expect(page).toHaveURL(`/workbench/shops/${encodeURIComponent(shopId)}/settings`);
  await expect(page.getByRole('heading', { level: 2, name: '基础设置' })).toBeVisible({ timeout: 30_000 });
  const tone = page.getByLabel('客服语气');
  await expect(tone).toBeVisible({ timeout: 30_000 });
  const persistedTone = `Luna 验收语气 ${Date.now()}`;
  await tone.fill(persistedTone);
  let navigationPrompt = '';
  page.once('dialog', async (dialog) => {
    navigationPrompt = dialog.message();
    await dialog.dismiss();
  });
  await page.getByRole('link', { name: '买家模拟器', exact: true }).click();
  await expect.poll(() => navigationPrompt, { timeout: 5_000 }).toBe('设置尚未保存，确认离开吗？');
  await expect(page).toHaveURL(`/workbench/shops/${encodeURIComponent(shopId)}/settings`);

  navigationPrompt = '';
  page.once('dialog', async (dialog) => {
    navigationPrompt = dialog.message();
    await dialog.dismiss();
  });
  await page.evaluate(() => window.history.back());
  await expect.poll(() => navigationPrompt, { timeout: 5_000 }).toBe('设置尚未保存，确认离开吗？');
  await expect(page).toHaveURL(`/workbench/shops/${encodeURIComponent(shopId)}/settings`);

  const save = page.getByRole('button', { name: '保存设置' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('status')).toContainText('设置已确认', { timeout: 30_000 });
  await page.reload();
  await expect(page.getByLabel('客服语气')).toHaveValue(persistedTone, { timeout: 30_000 });

  await page.goto(`/workbench/shops/${encodeURIComponent(shopId)}/knowledge/import`);
  await expect(page.getByRole('heading', { level: 2, name: '导入知识' })).toBeVisible({ timeout: 30_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /选择 Excel \/ CSV 文件/ }).click();
  await (await chooser).setFiles(resolve(process.cwd(), 'apps/web/public/seed/knowledge-import-template.csv'));
  await expect(page.getByRole('status')).toContainText('服务端校验完成', { timeout: 30_000 });
  await expect(page.getByRole('cell', { name: /多久发货/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /可以烘干/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认导入可用行' })).toBeEnabled();
  await page.getByRole('button', { name: '确认导入可用行' }).click();
  await expect(page.getByRole('status')).toContainText('可导入行已提交', { timeout: 30_000 });

  await expectConnected(page);
  await expectNoGlobalOverflow(page);
  await expectNoDiagnostics(diagnostics);
});
