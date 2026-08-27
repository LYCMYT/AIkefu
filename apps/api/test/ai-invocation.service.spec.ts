import { BadRequestException } from '@nestjs/common';
import { AIInvocationService } from '../src/ai/ai-invocation.service';

describe('AIInvocationService', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

  it('persists immutable evidence snapshots without accepting a full prompt', async () => {
    const repository = {
      create: jest.fn(async (_scope, input) => ({ id: 'invoke-1', ...input })),
      findById: jest.fn(),
      complete: jest.fn(),
      recordUsage: jest.fn(),
      listUsage: jest.fn(),
    };
    const service = new AIInvocationService(repository as never);
    const evidence = {
      itemId: 'item-1',
      versionId: 'version-1',
      version: 2,
      source: 'MANUAL' as const,
      scope: 'PRODUCT' as const,
      productId: 'product-1',
      contentSnapshot: { question: '材质？', answer: '316L 不锈钢' },
      retrievalScore: 0.91,
    };

    await service.start(scope, {
      purpose: 'REPLY_CONTEXT',
      provider: 'offline',
      model: 'deterministic-v1',
      promptVersion: 'p3',
      includedDataClasses: ['knowledge.snapshot'],
      excludedPII: ['buyer.phone'],
      evidence: [evidence],
    });

    expect(repository.create).toHaveBeenCalledWith(scope, expect.objectContaining({
      evidence: [expect.objectContaining({ contentSnapshot: { question: '材质？', answer: '316L 不锈钢' } })],
    }));
    evidence.contentSnapshot.answer = 'later changed knowledge';
    const persistedInput = repository.create.mock.calls[0]![1];
    expect(persistedInput.evidence[0].contentSnapshot.answer).toBe('316L 不锈钢');
    expect(JSON.stringify(persistedInput)).not.toContain('prompt"');
  });

  it('rejects evidence whose product scope or score is unsafe', async () => {
    const service = new AIInvocationService({} as never);
    await expect(service.start(scope, {
      purpose: 'REPLY_CONTEXT',
      provider: 'offline',
      model: 'deterministic-v1',
      promptVersion: 'p3',
      includedDataClasses: [],
      excludedPII: [],
      evidence: [{
        itemId: 'item-1', versionId: 'version-1', version: 1, source: 'MANUAL', scope: 'PRODUCT', productId: null,
        contentSnapshot: { question: 'q', answer: 'a' }, retrievalScore: Number.NaN,
      }],
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});
