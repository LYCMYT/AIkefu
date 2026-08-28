import { randomUUID } from 'node:crypto';
import { PrismaWorkspaceRepository } from '../src/database/prisma-workspace.repository';
import { PrismaService } from '../src/database/prisma.service';
import { SeedCatalog } from '../src/seed/seed-catalog';

const describeReal = process.env.RUN_REAL_INFRA_INTEGRATION === '1' ? describe : describe.skip;

describeReal('Workspace reset against real PostgreSQL', () => {
  const prisma = new PrismaService();
  const repository = new PrismaWorkspaceRepository(prisma);
  let workspaceId = '';

  beforeAll(async () => prisma.$connect());
  afterAll(async () => {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
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
    workspaceId = created.workspaceId;

    await expect(repository.reset(created, seed)).resolves.toMatchObject({
      shops: 2,
      buyers: 4,
      products: 10,
      orders: 10,
      knowledge: 80,
      workflows: 2,
    });

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
      seed.knowledge.filter((item) => item.shopKey === template.key).length,
    );
    await expect(repository.setShopAiMode(created, shop.id, 'AUTO_ALLOWED')).resolves.toMatchObject({
      id: shop.id, aiMode: 'AUTO_ALLOWED',
    });
  });
});
