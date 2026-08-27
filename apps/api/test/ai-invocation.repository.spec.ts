import { PrismaAIInvocationRepository } from '../src/ai/ai-invocation.repository';

describe('PrismaAIInvocationRepository', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

  it('uses workspace/tenant/shop on every invocation and usage lookup', async () => {
    const prisma = {
      aIInvocation: {
        create: jest.fn().mockResolvedValue({ id: 'invocation-a' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'invocation-a' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      aIUsage: { upsert: jest.fn().mockResolvedValue({ id: 'usage-a' }), findMany: jest.fn().mockResolvedValue([]) },
    };
    const repository = new PrismaAIInvocationRepository(prisma as never);
    await repository.create(scope, {
      purpose: 'SUMMARY', provider: 'offline', model: 'offline-v1', promptVersion: 'summary-v1',
      includedDataClasses: ['messages'], excludedPII: ['PHONE'], evidence: [{
        itemId: 'item-a', versionId: 'version-a', version: 1, source: 'MANUAL', scope: 'STORE', productId: null,
        contentSnapshot: { question: '配送政策？', answer: '通常 24 小时内发出。' }, retrievalScore: 0.8,
      }],
    });
    await repository.findById(scope, 'invocation-a');
    await repository.recordUsage(scope, 'invocation-a', {
      purpose: 'SUMMARY', provider: 'offline', model: 'offline-v1', inputTokens: 2, outputTokens: 1, success: true,
    });

    expect(prisma.aIInvocation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }),
    }));
    expect(prisma.aIInvocation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'invocation-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }),
    }));
    expect(prisma.aIUsage.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }),
    }));
  });
});
