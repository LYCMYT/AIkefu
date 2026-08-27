import { KnowledgeService } from '../src/knowledge/knowledge.service';

describe('Knowledge conflict version safety', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };

  it('matches only the current active version and never creates a conflict against history', async () => {
    const tx = {
      knowledgeItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'knowledge-a',
            activeVersionId: 'version-2',
            versions: [
              { id: 'version-1', question: '材质？', answer: '316L' },
              { id: 'version-2', question: '材质？', answer: '304' },
            ],
          },
        ]),
      },
    };
    const service = new KnowledgeService({} as never, { load: jest.fn() } as never);
    const findMatches = (
      service as unknown as {
        findQuestionMatchRecords: (
          transaction: typeof tx,
          requestScope: typeof scope,
          shopId: string,
          knowledgeScope: 'STORE',
          productId: null,
          question: string,
        ) => Promise<Array<{ itemId: string; versionId: string; answer: string }>>;
      }
    ).findQuestionMatchRecords.bind(service);

    await expect(findMatches(tx, scope, 'shop-a', 'STORE', null, '材质？')).resolves.toEqual([
      { itemId: 'knowledge-a', versionId: 'version-2', answer: '304' },
    ]);
  });

  it('rejects KEEP_* when a persisted conflict points at a historical expired side', async () => {
    const conflict = {
      id: 'conflict-a',
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: 'shop-a',
      leftItemId: 'left-item',
      rightItemId: 'right-item',
      leftVersionId: 'left-v1',
      rightVersionId: 'right-v1',
      status: 'OPEN',
    };
    const tx = {
      knowledgeConflict: {
        findFirst: jest.fn().mockResolvedValue(conflict),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeItem: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'left-item', scope: 'STORE', productId: null, activeVersionId: null },
          { id: 'right-item', scope: 'STORE', productId: null, activeVersionId: 'right-v2' },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeVersion: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'left-v1', knowledgeItemId: 'left-item', indexStatus: 'READY',
            effectiveFrom: new Date('2026-08-27T00:00:00.000Z'), effectiveTo: null,
          },
          {
            id: 'right-v1', knowledgeItemId: 'right-item', indexStatus: 'READY',
            effectiveFrom: new Date('2026-08-20T00:00:00.000Z'),
            effectiveTo: new Date('2026-08-25T00:00:00.000Z'),
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      knowledgeConflict: { findFirst: jest.fn().mockResolvedValue({ shopId: 'shop-a' }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect(
      service.resolveConflict(scope, conflict.id, { resolution: 'KEEP_RIGHT' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'KNOWLEDGE_CONFLICT_WINNER_STALE' }),
    });
    expect(tx.knowledgeItem.updateMany).not.toHaveBeenCalled();
    expect(tx.knowledgeConflict.updateMany).not.toHaveBeenCalled();
  });
});
