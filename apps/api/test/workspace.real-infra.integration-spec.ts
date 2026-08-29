import { randomUUID } from 'node:crypto';
import { PrismaWorkspaceRepository } from '../src/database/prisma-workspace.repository';
import { PrismaService } from '../src/database/prisma.service';
import { SeedCatalog } from '../src/seed/seed-catalog';
import { KnowledgeService } from '../src/knowledge/knowledge.service';
import { ProductLearningRequestWorker } from '../src/knowledge/product-learning-request.worker';

const describeReal = process.env.RUN_REAL_INFRA_INTEGRATION === '1' ? describe : describe.skip;

describeReal('Workspace reset against real PostgreSQL', () => {
  const prisma = new PrismaService();
  const repository = new PrismaWorkspaceRepository(prisma);
  const workspaceIds: string[] = [];

  beforeAll(async () => prisma.$connect());
  afterAll(async () => {
    if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.$disconnect();
  });

  it('resets a freshly seeded workspace and keeps the frozen counts', async () => {
    const seed = await new SeedCatalog().load();
    const created = await repository.createWithSeed({
      tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      now: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      seed,
    });
    workspaceIds.push(created.workspaceId);

    await expect(repository.reset(created, seed)).resolves.toMatchObject({
      shops: 2,
      buyers: 4,
      products: 10,
      orders: 10,
      knowledge: 80,
      workflows: 2,
    });
    const seededShops = await repository.listShops(created);
    expect(seededShops).toHaveLength(2);
    expect(seededShops.every((shop) => shop.aiReadiness === 'READY')).toBe(true);
    await expect(prisma.productLearningJob.count({
      where: { workspaceId: created.workspaceId, tenantId: created.tenantId, status: 'SUCCEEDED' },
    })).resolves.toBe(2);

    const template = seed.shops.find((shop) => shop.key === 'shop_mia_fashion')!;
    const shop = await repository.createShop(created, {
      template, catalog: seed, name: 'Real PG Clone', externalShopId: `real-pg-${randomUUID()}`,
      aiMode: 'ASSIST_ONLY',
    });
    expect(shop).toMatchObject({ name: 'Real PG Clone', aiMode: 'ASSIST_ONLY', platform: 'DOUYIN_DEMO' });
    const scope = { workspaceId: created.workspaceId, tenantId: created.tenantId };
    await expect(prisma.product.count({ where: { ...scope, shopId: shop.id } })).resolves.toBe(
      seed.products.filter((product) => product.shopKey === template.key).length,
    );
    await expect(prisma.order.count({ where: { ...scope, shopId: shop.id } })).resolves.toBe(
      seed.orders.filter((order) => order.shopKey === template.key).length,
    );
    await expect(prisma.knowledgeItem.count({ where: { ...scope, shopId: shop.id } })).resolves.toBe(
      seed.knowledge.filter((item) => item.shopKey === template.key && item.sourceType !== 'AUTO_LEARNED').length,
    );
    await expect(repository.setShopAiMode(created, shop.id, 'AUTO_ALLOWED')).resolves.toMatchObject({
      id: shop.id, aiMode: 'AUTO_ALLOWED',
    });
  });

  it('supports an empty operational workspace, scoped settings, and durable automatic learning end to end', async () => {
    const seeds = new SeedCatalog();
    const seed = await seeds.load();
    const created = await repository.createWithSeed({
      tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      now: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      seed,
      profile: 'EMPTY',
    });
    workspaceIds.push(created.workspaceId);
    const scope = { workspaceId: created.workspaceId, tenantId: created.tenantId };
    await expect(repository.getBootstrap(scope)).resolves.toMatchObject({
      shops: [], seed: { counts: { shops: 0, buyers: 0, products: 0, orders: 0, knowledge: 0, workflows: 0 } },
    });

    const template = seed.shops.find((entry) => entry.key === 'shop_pixel_tech')!;
    const shop = await repository.createShop(scope, {
      template,
      catalog: seed,
      name: 'Empty Workspace Clone',
      externalShopId: `empty-pg-${randomUUID()}`,
      aiMode: 'AUTO_ALLOWED',
    });
    expect(shop).toMatchObject({ aiMode: 'AUTO_ALLOWED', aiReadiness: 'PREPARING' });
    const expectedProducts = seed.products.filter((entry) => entry.shopKey === template.key);
    const expectedOrders = seed.orders.filter((entry) => entry.shopKey === template.key);
    const expectedBuyerKeys = new Set(expectedOrders.map((entry) => entry.buyerKey));
    const expectedStableKnowledge = seed.knowledge.filter(
      (entry) => entry.shopKey === template.key && entry.sourceType !== 'AUTO_LEARNED',
    );
    await expect(prisma.product.count({ where: { ...scope, shopId: shop.id } })).resolves.toBe(expectedProducts.length);
    await expect(prisma.order.count({ where: { ...scope, shopId: shop.id } })).resolves.toBe(expectedOrders.length);
    await expect(prisma.buyer.count({ where: { ...scope } })).resolves.toBe(expectedBuyerKeys.size);
    await expect(prisma.knowledgeItem.count({ where: { ...scope, shopId: shop.id } })).resolves.toBe(expectedStableKnowledge.length);
    await expect(prisma.processingOutbox.count({
      where: { ...scope, shopId: shop.id, eventType: 'PRODUCT_LEARNING_REQUESTED' },
    })).resolves.toBe(1);

    const settings = await repository.getShopSettings(scope, shop.id);
    expect(settings).toMatchObject({ shopId: shop.id, welcomeMessage: template.settings.welcomeMessage });
    const replacement = {
      ...settings!,
      tone: '专业简洁',
      welcomeMessage: '欢迎光临演示店铺',
      transferKeywords: ['人工', '投诉'],
    };
    const { shopId: _shopId, ...input } = replacement;
    await expect(repository.updateShopSettings(scope, shop.id, input)).resolves.toMatchObject(replacement);
    const other = await repository.createWithSeed({
      tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      now: new Date(), expiresAt: new Date(Date.now() + 60_000), seed, profile: 'EMPTY',
    });
    workspaceIds.push(other.workspaceId);
    await expect(repository.getShopSettings(other, shop.id)).resolves.toBeNull();

    const knowledge = new KnowledgeService(prisma, seeds);
    const worker = new ProductLearningRequestWorker(prisma, knowledge);
    await worker.dispatchOnce();
    const jobs = await knowledge.listProductLearningJobs(scope, shop.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'SUCCEEDED', totals: { total: expectedProducts.length, failed: 0 } });
    await expect(prisma.processingReceipt.count({
      where: { ...scope, shopId: shop.id, eventId: `product-learning:shop-created:${shop.id}` },
    })).resolves.toBe(1);
    await expect(repository.getShop(scope, shop.id)).resolves.toMatchObject({ aiReadiness: 'READY' });

    await expect(repository.reset(scope, seed, 'EMPTY')).resolves.toEqual({
      shops: 0, buyers: 0, products: 0, orders: 0, knowledge: 0, workflows: 0,
    });
    await expect(repository.listShops(scope)).resolves.toEqual([]);
  });
});
