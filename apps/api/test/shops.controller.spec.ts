import { ShopsController } from '../src/shops/shops.controller';

describe('ShopsController mutations', () => {
  const workspace = {
    workspaceId: 'workspace-a', tenantId: 'tenant-a',
    workspace: { id: 'workspace-a' }, tenant: { id: 'tenant-a' },
  } as never;

  it('creates an enabled-but-fail-closed AUTO demo shop by default', async () => {
    const shop = { id: 'shop-new', name: '新店铺', aiMode: 'AUTO_ALLOWED', aiReadiness: 'PREPARING' };
    const workspaces = { createShop: jest.fn().mockResolvedValue(shop) };
    const controller = new ShopsController(workspaces as never);

    await expect(controller.create(workspace, { platform: 'DOUYIN_DEMO', templateKey: 'FASHION_DEMO', name: ' 新店铺 ' })).resolves.toEqual(shop);
    expect(workspaces.createShop).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-a', tenantId: 'tenant-a' }),
      { platform: 'DOUYIN_DEMO', templateKey: 'FASHION_DEMO', name: ' 新店铺 ' },
    );
  });

  it('reads and replaces scoped shop settings', async () => {
    const settings = {
      shopId: 'shop-a', tone: '亲切', logisticsPolicy: '物流', shippingPolicy: '发货', afterSalesPolicy: '售后',
      welcomeMessage: '欢迎', closingMessages: { NO_ORDER: '再见' }, transferKeywords: ['人工'],
      forbiddenTerms: [{ term: '绝对', replacement: '尽量' }],
    };
    const workspaces = {
      getShopSettings: jest.fn().mockResolvedValue(settings),
      updateShopSettings: jest.fn().mockResolvedValue(settings),
    };
    const controller = new ShopsController(workspaces as never);

    await expect(controller.getSettings(workspace, 'shop-a')).resolves.toEqual(settings);
    await expect(controller.updateSettings(workspace, 'shop-a', settings)).resolves.toEqual(settings);
    expect(workspaces.getShopSettings).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-a' }), 'shop-a');
    expect(workspaces.updateShopSettings).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-a' }), 'shop-a', settings);
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
