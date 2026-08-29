import { expect, test } from '@playwright/test';
import {
  captureConsoleDiagnostics,
  createOperationalShop,
  expectConnected,
  expectNoDiagnostics,
  expectNoGlobalOverflow,
} from './rearchitecture-helpers';

test('a real buyer event reaches workbench and live-test on the same shop', async ({ page }) => {
  test.setTimeout(150_000);
  test.skip(
    process.env.RUN_REAL_INFRA_E2E !== '1',
    'requires the migrated PostgreSQL/Redis/MinIO stack and running API/Web',
  );
  const diagnostics = captureConsoleDiagnostics(page);
  const activeWorkspaceSockets = new Set<object>();
  const isWorkspaceSocket = (url: string) => {
    try { return new URL(url).pathname.startsWith('/ws'); } catch { return url.includes('/ws'); }
  };
  // A full document navigation creates a new Application/socket while the
  // browser may report the old WebSocket close a few ticks later. Keep only
  // sockets belonging to the current document; SPA route changes retain the
  // set and therefore prove LiveTest reuses the active connection.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) activeWorkspaceSockets.clear();
  });
  page.on('websocket', (websocket) => {
    if (!isWorkspaceSocket(websocket.url())) return;
    const socket = websocket as unknown as object;
    activeWorkspaceSockets.add(socket);
    websocket.on('close', () => activeWorkspaceSockets.delete(socket));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const { shopId, name } = await createOperationalShop(page, `Luna-flow-${Date.now()}`);

  await page.goto('/buyer-simulator');
  await expectConnected(page);
  await expect(page.getByRole('heading', { level: 2, name: '买家模拟器' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('combobox', { name: '买家' })).not.toHaveValue('', { timeout: 30_000 });
  const message = `Luna 实时链路 ${Date.now()}`;
  await page.getByPlaceholder('输入咨询内容…').fill(message);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('link', { name: '工作台', exact: true }).click();
  await expect(page).toHaveURL(/\/workbench$/);
  // The scheduled welcome or a fast AI receipt may replace the buyer text in
  // the conversation preview between visibility and click. Select the sole
  // durable conversation, then prove the buyer turn exists in its transcript.
  const conversation = page.getByRole('region', { name: '会话列表' }).locator('.conversation-row').first();
  await expect(conversation).toBeVisible({ timeout: 45_000 });
  await conversation.click();
  await expect(page.getByRole('region', { name: '聊天与消息' }).getByText(message, { exact: true })).toBeVisible({ timeout: 30_000 });

  // LiveTestPage receives Application's realtime event/status props and must
  // not establish a second socket for the same operational session.
  await expect.poll(() => activeWorkspaceSockets.size, { timeout: 30_000 }).toBe(1);
  await page.getByRole('button', { name: `${name} 更多操作` }).click();
  await page.getByRole('menu', { name: '店铺操作' }).getByRole('menuitem', { name: '打开实时联调' }).click();
  await expect(page).toHaveURL(`/live-test/${encodeURIComponent(shopId)}`);
  await expect(page.getByRole('heading', { level: 1, name: '实时联调' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('实时连接：已连接')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('combobox', { name: '选择模拟买家' })).not.toHaveValue('', { timeout: 30_000 });
  await expect(page.getByRole('region', { name: '买家端' }).getByText(message, { exact: true })).toBeVisible({ timeout: 45_000 });
  // The same operational socket may reconnect while the worker is busy; the
  // invariant is that LiveTest has one active workspace socket and did not
  // open a second connection for its own state.
  expect(activeWorkspaceSockets.size).toBe(1);

  const storeTab = page.getByRole('tab', { name: '店铺端' });
  if (await storeTab.isVisible()) await storeTab.click();
  await expect(page.getByRole('region', { name: '店铺端' })).toBeVisible();
  const takeover = page.getByRole('button', { name: '人工接管', exact: true });
  await expect(takeover).toBeVisible({ timeout: 30_000 });
  await takeover.click();
  await expect(page.getByRole('status')).toContainText('人工接管已开启', { timeout: 60_000 });
  await expect(page.getByRole('button', { name: '交还 AI', exact: true })).toBeVisible({ timeout: 60_000 });

  await expectNoGlobalOverflow(page);
  await expectNoDiagnostics(diagnostics);
});
