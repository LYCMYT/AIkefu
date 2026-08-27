import { expect, test } from '@playwright/test';

test('real buyer-to-human-final flow stays visible across Buyer Simulator and Workbench', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(process.env.RUN_REAL_INFRA_E2E !== '1', 'requires the migrated PostgreSQL/Redis/MinIO stack and running API/Web');

  const buyerMessages = ['你好', '什么时候发货？', '我是新疆的'];
  const humanFinal = '您好，偏远地区发货时效以实际物流信息为准，我来继续为您处理。';

  await page.goto('/buyer-simulator');
  await expect(page.getByText('API READY')).toBeVisible();
  await expect(page.getByText('实时已连接', { exact: true })).toBeVisible();

  // This isolated browser context owns a newly created synthetic Workspace.
  // Reset proves the durable seed/reset path without touching another test.
  const reset = page.getByRole('button', { name: 'Reset demo' });
  await reset.click();
  await expect(reset).toHaveText('Reset demo', { timeout: 30_000 });
  await expect(page.getByRole('combobox', { name: '买家' })).not.toHaveValue('');

  const composer = page.getByPlaceholder('输入咨询内容…');
  const send = page.getByRole('button', { name: '发送', exact: true });
  for (const message of buyerMessages) {
    await composer.fill(message);
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(composer).toHaveValue('', { timeout: 30_000 });
  }

  await page.reload();
  for (const message of buyerMessages) await expect(page.getByText(message, { exact: true })).toBeVisible();

  await page.getByRole('link', { name: /工作台/ }).click();
  await expect(page.getByRole('button', { name: /小林.*我是新疆的/ })).toBeVisible({ timeout: 20_000 });
  const chat = page.getByRole('region', { name: '聊天与消息' });
  for (const message of buyerMessages) await expect(chat.getByText(message, { exact: true })).toBeVisible();
  await expect(chat.getByRole('textbox', { name: 'Human Final 编辑区' })).toHaveValue(/.+/, { timeout: 20_000 });

  await chat.getByRole('button', { name: '人工接管', exact: true }).click();
  await expect(chat.getByText('人工接管中', { exact: true })).toBeVisible();
  await chat.getByPlaceholder('以客服身份回复…').fill(humanFinal);
  await chat.getByRole('button', { name: '发送回复', exact: true }).click();
  await expect(chat.getByText(/Human Final 已接受/)).toBeVisible({ timeout: 20_000 });
  await expect(chat.getByText(humanFinal, { exact: true })).toBeVisible();

  await page.getByRole('link', { name: /买家模拟器/ }).click();
  await expect(page.getByText(humanFinal, { exact: true })).toBeVisible({ timeout: 20_000 });
});
