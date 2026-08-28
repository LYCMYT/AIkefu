import { ShopsController } from '../src/shops/shops.controller';

describe('ShopsController mutations', () => {
  const workspace = {
    workspaceId: 'workspace-a', tenantId: 'tenant-a',
    workspace: { id: 'workspace-a' }, tenant: { id: 'tenant-a' },
  } as never;

  it('creates a safe ASSIST_ONLY demo shop by default', async () => {
    const shop = { id: 'shop-new', name: '新店铺', aiMode: 'ASSIST_ONLY' };
    const workspaces = { createShop: jest.fn().mockResolvedValue(shop) };
    const controller = new ShopsController(workspaces as never);

    await expect(controller.create(workspace, { platform: 'DOUYIN_DEMO', templateKey: 'FASHION_DEMO', name: ' 新店铺 ' })).resolves.toEqual(shop);
    expect(workspaces.createShop).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-a', tenantId: 'tenant-a' }),
      { platform: 'DOUYIN_DEMO', templateKey: 'FASHION_DEMO', name: ' 新店铺 ' },
    );
  });

  it('changes the shop AI ceiling through the explicit safety endpoint', async () => {
    const shop = { id: 'shop-a', aiMode: 'AUTO_ALLOWED' };
    const workspaces = { setShopAiMode: jest.fn().mockResolvedValue(shop) };
    const controller = new ShopsController(workspaces as never);

    await expect(controller.setAiMode(workspace, 'shop-a', { mode: 'AUTO_ALLOWED' })).resolves.toEqual(shop);
    expect(workspaces.setShopAiMode).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-a', tenantId: 'tenant-a' }),
      'shop-a',
      'AUTO_ALLOWED',
    );
  });
});
