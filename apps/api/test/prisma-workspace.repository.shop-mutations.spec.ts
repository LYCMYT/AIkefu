import { PrismaWorkspaceRepository } from '../src/database/prisma-workspace.repository';

describe('PrismaWorkspaceRepository shop mutations', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
  const template = {
    key: 'shop_mia_fashion', name: 'MIA Fashion', platform: 'DOUYIN_DEMO', externalShopId: 'dy_demo_mia',
    aiMode: 'ASSIST_ONLY' as const, connectionState: 'CONNECTED' as const,
    settings: {
      tone: '亲切', logisticsPolicy: '物流规则', shippingPolicy: '发货规则', afterSalesPolicy: '售后规则',
      welcomeMessage: '欢迎', closingMessages: {}, transferKeywords: ['人工'], forbiddenTerms: [],
    },
  };

  it('creates a scoped shop and settings with a safe default and audit record', async () => {
    const created = {
      id: 'shop-new', ...scope, platform: 'DOUYIN_DEMO', externalShopId: 'demo-new', name: '新店铺',
      aiMode: 'ASSIST_ONLY', connectionState: 'CONNECTED', syncComplete: true,
    };
    const tx = {
      shop: { count: jest.fn().mockResolvedValue(2), create: jest.fn().mockResolvedValue(created) },
      shopSettings: { create: jest.fn().mockResolvedValue({ id: 'settings-new' }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-new' }) },
    };
    const repository = new PrismaWorkspaceRepository({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(repository.createShop(scope, {
      name: '新店铺', externalShopId: 'demo-new', aiMode: 'ASSIST_ONLY', template,
      catalog: { buyers: [], products: [], orders: [], knowledge: [] },
    })).resolves.toMatchObject({ id: 'shop-new', name: '新店铺', aiMode: 'ASSIST_ONLY' });
    expect(tx.shop.count).toHaveBeenCalledWith({ where: scope });
    expect(tx.shop.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      ...scope, name: '新店铺', externalShopId: 'demo-new', aiMode: 'ASSIST_ONLY', platform: 'DOUYIN_DEMO',
    }) });
    expect(tx.shopSettings.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ...scope, shopId: 'shop-new', tone: '亲切' }) });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'SHOP_CREATED', entityId: 'shop-new' }) });
  });

  it('uses a kill switch when lowering the ceiling and never revives old jobs when raising it', async () => {
    const shop = { id: 'shop-a', ...scope, platform: 'DOUYIN_DEMO', externalShopId: 'demo-a', name: '店铺 A', aiMode: 'AUTO_ALLOWED', connectionState: 'CONNECTED', syncComplete: true };
    const tx = {
      shop: {
        findFirst: jest.fn().mockResolvedValue(shop),
        update: jest.fn().mockResolvedValue({ ...shop, aiMode: 'ASSIST_ONLY' }),
      },
      replyJob: {
        findMany: jest.fn().mockResolvedValue([{ id: 'reply-auto' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      sendOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-mode' }) },
    };
    const repository = new PrismaWorkspaceRepository({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(repository.setShopAiMode(scope, 'shop-a', 'ASSIST_ONLY')).resolves.toMatchObject({ aiMode: 'ASSIST_ONLY' });
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'STALE', staleReason: 'SHOP_AI_MODE_DOWNGRADED' } }));
    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'STALE', staleReason: 'SHOP_AI_MODE_DOWNGRADED' } }));
    expect(tx.sendOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }));
    expect(tx.processingOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'FAILED' } }));
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'SHOP_AI_MODE_CHANGED', entityId: 'shop-a' }) });
  });
});
