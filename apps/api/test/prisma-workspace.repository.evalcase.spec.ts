import { PrismaWorkspaceRepository } from '../src/database/prisma-workspace.repository';
import { SeedCatalog } from '../src/seed/seed-catalog';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };

describe('PrismaWorkspaceRepository frozen EvalCase seeding', () => {
  it('uses actual frozen shop keys and is idempotent across two production seedScope passes', async () => {
    const evalUpsert = jest.fn().mockResolvedValue({ id: 'eval-a' });
    const tx = {
      shop: { upsert: jest.fn(async ({ create }: { create: { seedKey: string } }) => ({ id: `shop:${create.seedKey}` })) },
      shopSettings: { upsert: jest.fn().mockResolvedValue({}) },
      buyer: { upsert: jest.fn(async ({ create }: { create: { seedKey: string } }) => ({ id: `buyer:${create.seedKey}` })) },
      product: { upsert: jest.fn(async ({ create }: { create: { seedKey: string } }) => ({ id: `product:${create.seedKey}` })) },
      productSku: { upsert: jest.fn(async ({ create }: { create: { externalSkuId: string } }) => ({ id: `sku:${create.externalSkuId}` })) },
      order: { upsert: jest.fn().mockResolvedValue({}) },
      knowledgeItem: { upsert: jest.fn(async ({ create }: { create: { seedKey: string } }) => ({ id: `knowledge:${create.seedKey}` })), update: jest.fn().mockResolvedValue({}) },
      knowledgeVersion: { upsert: jest.fn(async ({ create }: { create: { knowledgeItemId: string } }) => ({ id: `version:${create.knowledgeItemId}` })) },
      productLearningJob: { upsert: jest.fn().mockResolvedValue({}) },
      workflow: { upsert: jest.fn(async ({ create }: { create: { seedKey: string } }) => ({ id: `workflow:${create.seedKey}` })), update: jest.fn().mockResolvedValue({}) },
      workflowVersion: { upsert: jest.fn(async ({ create }: { create: { workflowId: string } }) => ({ id: `workflow-version:${create.workflowId}` })) },
      evalCase: { upsert: evalUpsert },
    };
    const repository = new PrismaWorkspaceRepository({} as never);
    const seedScope = (repository as unknown as { seedScope(tx: unknown, scope: unknown, seed: unknown): Promise<void> }).seedScope;
    const seed = await new SeedCatalog().load();
    await seedScope.call(repository, tx, scope, seed);
    await seedScope.call(repository, tx, scope, seed);

    expect(evalUpsert).toHaveBeenCalledTimes(seed.evalCases.length * 2);
    expect(evalUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_tenantId_key: { workspaceId: 'workspace-a', tenantId: 'tenant-a', key: 'fixed:E002' } },
      create: expect.objectContaining({ shopId: 'shop:shop_pixel_tech', source: 'FIXED' }),
    }));
  });
});
