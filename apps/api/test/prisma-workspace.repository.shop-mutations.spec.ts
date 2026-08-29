import { PrismaWorkspaceRepository } from '../src/database/prisma-workspace.repository';

describe('PrismaWorkspaceRepository shop mutations', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
  const template = {
    key: 'shop_mia_fashion', name: 'MIA Fashion', platform: 'DOUYIN_DEMO', externalShopId: 'dy_demo_mia',
    aiMode: 'ASSIST_ONLY' as const, connectionState: 'CONNECTED' as const,
    settings: {
      tone: '亲切', logisticsPolicy: '物流规则', shippingPolicy: '发货规则', afterSalesPolicy: '售后规则',
      welcomeMessage: '欢迎光临 MIA Fashion', closingMessages: { NO_ORDER: 'MIA Fashion 期待再见' }, transferKeywords: ['人工'], forbiddenTerms: [],
    },
  };

  it('creates a scoped shop, required buyers, and a durable product-learning request without AUTO_LEARNED duplication', async () => {
    const created = {
      id: 'shop-new', ...scope, platform: 'DOUYIN_DEMO', externalShopId: 'demo-new', name: '新店铺',
      aiMode: 'AUTO_ALLOWED', connectionState: 'CONNECTED', syncComplete: true,
    };
    const tx = {
      shop: { count: jest.fn().mockResolvedValue(2), create: jest.fn().mockResolvedValue(created) },
      shopSettings: { create: jest.fn().mockResolvedValue({ id: 'settings-new' }) },
      buyer: { upsert: jest.fn().mockResolvedValue({ id: 'buyer-new', seedKey: 'buyer-a' }) },
      product: { create: jest.fn().mockResolvedValue({ id: 'product-new' }) },
      productSku: { create: jest.fn().mockResolvedValue({ id: 'sku-new' }) },
      order: { create: jest.fn().mockResolvedValue({ id: 'order-new' }) },
      knowledgeItem: { create: jest.fn().mockResolvedValue({ id: 'knowledge-manual' }), update: jest.fn() },
      knowledgeVersion: { create: jest.fn().mockResolvedValue({ id: 'knowledge-version-manual' }) },
      processingOutbox: { upsert: jest.fn().mockResolvedValue({ id: 'learning-request' }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-new' }) },
    };
    const repository = new PrismaWorkspaceRepository({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(repository.createShop(scope, {
      name: '新店铺', externalShopId: 'demo-new', aiMode: 'AUTO_ALLOWED', template,
      catalog: {
        buyers: [{ key: 'buyer-a', externalBuyerId: 'buyer_external', displayName: '买家', tags: [] }],
        products: [{ key: 'product-a', shopKey: template.key, externalProductId: 'p-a', title: '商品', status: 'ON_SHELF', recommendable: true, description: '描述', skus: [{ externalSkuId: 'sku-a', attributes: {}, price: 9.9, inventory: 2 }] }],
        orders: [{ key: 'order-a', shopKey: template.key, buyerKey: 'buyer-a', productKey: 'product-a', sku: 'sku-a', externalOrderId: 'o-a', status: 'WAITING_SHIPMENT', amount: 9.9, orderedAt: '2026-01-01T00:00:00.000Z', logistics: null }],
        knowledge: [
          { key: 'manual-a', shopKey: template.key, productKey: null, scope: 'STORE', sourceType: 'MANUAL', businessStatus: 'ENABLED', indexStatus: 'READY', question: '人工问题', answer: '人工答案' },
          { key: 'auto-a', shopKey: template.key, productKey: 'product-a', scope: 'PRODUCT', sourceType: 'AUTO_LEARNED', businessStatus: 'ENABLED', indexStatus: 'READY', question: '自动问题', answer: '自动答案' },
        ],
      },
    })).resolves.toMatchObject({ id: 'shop-new', name: '新店铺', aiMode: 'AUTO_ALLOWED', aiReadiness: 'PREPARING' });
    expect(tx.shop.count).toHaveBeenCalledWith({ where: scope });
    expect(tx.shop.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      ...scope, name: '新店铺', externalShopId: 'demo-new', aiMode: 'AUTO_ALLOWED', platform: 'DOUYIN_DEMO',
    }) });
    expect(tx.shopSettings.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      ...scope, shopId: 'shop-new', tone: '亲切', welcomeMessage: '欢迎光临 新店铺',
      closingMessagesJson: { NO_ORDER: '新店铺 期待再见' },
    }) });
    expect(tx.buyer.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_tenantId_externalBuyerId: { ...scope, externalBuyerId: 'buyer_external' } },
    }));
    expect(tx.knowledgeItem.create).toHaveBeenCalledTimes(1);
    expect(tx.processingOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ eventType: 'PRODUCT_LEARNING_REQUESTED', aggregateId: 'shop-new', shopId: 'shop-new' }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'SHOP_CREATED', entityId: 'shop-new' }) });
  });

  it('confirms copied settings atomically before AUTO readiness can become READY', async () => {
    const settings = {
      id: 'settings-a', ...scope, shopId: 'shop-a', tone: '亲切', logisticsPolicy: '物流规则',
      shippingPolicy: '发货规则', afterSalesPolicy: '售后规则', welcomeMessage: '欢迎光临新店铺',
      closingMessagesJson: { NO_ORDER: '期待再见' }, transferKeywordsJson: ['人工'],
      forbiddenTermsJson: [], updatedAt: new Date('2026-08-29T00:00:00.000Z'),
    };
    const tx = {
      shop: {
        findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }),
        update: jest.fn().mockResolvedValue({ id: 'shop-a' }),
      },
      shopSettings: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(settings),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-settings' }) },
    };
    const repository = new PrismaWorkspaceRepository({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(repository.updateShopSettings(scope, 'shop-a', {
      tone: settings.tone,
      logisticsPolicy: settings.logisticsPolicy,
      shippingPolicy: settings.shippingPolicy,
      afterSalesPolicy: settings.afterSalesPolicy,
      welcomeMessage: settings.welcomeMessage,
      closingMessages: settings.closingMessagesJson,
      transferKeywords: settings.transferKeywordsJson,
      forbiddenTerms: [],
    })).resolves.toMatchObject({ shopId: 'shop-a', settingsConfirmed: true });
    expect(tx.shop.update).toHaveBeenCalledWith({
      where: { id: 'shop-a' },
      data: { settingsConfirmedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'SHOP_SETTINGS_UPDATED', entityId: 'shop-a' }),
    });
  });

  it('uses a kill switch when lowering the ceiling and never revives old jobs when raising it', async () => {
    const shop = { id: 'shop-a', ...scope, platform: 'DOUYIN_DEMO', externalShopId: 'demo-a', name: '店铺 A', aiMode: 'AUTO_ALLOWED', connectionState: 'CONNECTED', syncComplete: true, settingsConfirmedAt: new Date('2026-08-29T00:00:00.000Z') };
    const tx = {
      $queryRaw: jest.fn(),
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
      productLearningJob: { findFirst: jest.fn().mockResolvedValue({ status: 'SUCCEEDED' }) },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-mode' }) },
    };
    const repository = new PrismaWorkspaceRepository({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(repository.setShopAiMode(scope, 'shop-a', 'ASSIST_ONLY')).resolves.toMatchObject({ aiMode: 'ASSIST_ONLY' });
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'STALE', staleReason: 'SHOP_AI_MODE_DOWNGRADED' } }));
    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'STALE', staleReason: 'SHOP_AI_MODE_DOWNGRADED' } }));
    expect(tx.sendOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }));
    expect(tx.sendOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ replyJobId: expect.anything() }),
      data: expect.objectContaining({ status: 'CANCELLED' }),
    }));
    expect(tx.processingOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['PENDING', 'DISPATCHING'] } }),
      data: { status: 'FAILED' },
    }));
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'SHOP_AI_MODE_CHANGED', entityId: 'shop-a' }) });
  });

  it('treats MANUAL_ONLY as a non-sticky master ceiling, preserving real per-conversation takeover state when AI is turned back on', async () => {
    const autoShop = {
      id: 'shop-a', ...scope, platform: 'DOUYIN_DEMO', externalShopId: 'demo-a', name: '店铺 A',
      aiMode: 'AUTO_ALLOWED', connectionState: 'CONNECTED', syncComplete: true, settingsConfirmedAt: new Date('2026-08-29T00:00:00.000Z'),
    };
    const manualShop = { ...autoShop, aiMode: 'MANUAL_ONLY' as const };
    const tx = {
      $queryRaw: jest.fn(),
      shop: {
        findFirst: jest.fn()
          .mockResolvedValueOnce(autoShop)
          .mockResolvedValueOnce(manualShop),
        update: jest.fn()
          .mockResolvedValueOnce(manualShop)
          .mockResolvedValueOnce(autoShop),
      },
      replyJob: {
        findMany: jest.fn().mockResolvedValue([{ id: 'old-auto-job' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      sendOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      // The master setting must not rewrite normal AUTO conversations or a
      // genuine MANUAL/human takeover; their existing state is what lets the
      // effective-mode projection resume only the normal conversation later.
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      productLearningJob: { findFirst: jest.fn().mockResolvedValue({ status: 'SUCCEEDED' }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-mode' }) },
    };
    const repository = new PrismaWorkspaceRepository({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(repository.setShopAiMode(scope, 'shop-a', 'MANUAL_ONLY')).resolves.toMatchObject({ aiMode: 'MANUAL_ONLY', aiReadiness: 'OFF' });
    await expect(repository.setShopAiMode(scope, 'shop-a', 'AUTO_ALLOWED')).resolves.toMatchObject({ aiMode: 'AUTO_ALLOWED', aiReadiness: 'READY' });

    expect(tx.replyJob.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'STALE', staleReason: 'SHOP_AI_MODE_DOWNGRADED' } }));
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
  });
});
