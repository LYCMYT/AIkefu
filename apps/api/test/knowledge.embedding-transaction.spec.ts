import { KnowledgeService } from '../src/knowledge/knowledge.service';

describe('Knowledge embedding transaction boundary', () => {
  it('resolves a configured embedding before opening the database transaction', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
    let transactionOpen = false;
    const embedding = {
      id: 'slow-provider',
      mode: 'PROVIDER' as const,
      embed: jest.fn(async () => {
        expect(transactionOpen).toBe(false);
        return Array(1536).fill(0);
      }),
    };
    const item = {
      id: 'knowledge-a',
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: 'shop-a',
      productId: null,
      scope: 'STORE',
      sourceType: 'MANUAL',
      businessStatus: 'ENABLED',
    };
    const version = {
      id: 'version-a',
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      knowledgeItemId: item.id,
      version: 1,
      question: '材质是什么？',
      answer: '316L 不锈钢',
      sourceText: '材质是什么？\n316L 不锈钢',
      sourceVersion: 'manual',
      confidence: 1,
      indexStatus: 'READY',
      contentHash: 'hash',
      supersedesId: null,
      effectiveFrom: new Date('2026-08-27T00:00:00.000Z'),
      effectiveTo: null,
      indexedAt: new Date('2026-08-27T00:00:00.000Z'),
      searchTokensJson: [],
    };
    const tx = {
      knowledgeItem: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(item),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeVersion: {
        create: jest.fn().mockResolvedValue(version),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(version),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
        transactionOpen = true;
        try {
          return await work(tx);
        } finally {
          transactionOpen = false;
        }
      }),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never, undefined, embedding);

    await expect(
      service.create(scope, {
        shopId: 'shop-a',
        question: '材质是什么？',
        answer: '316L 不锈钢',
      }),
    ).resolves.toMatchObject({ status: 'CREATED' });

    expect(embedding.embed).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does not open a write transaction or publish an active version when the provider fails', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
    const providerFailure = new Error('embedding gateway unavailable');
    const embedding = {
      id: 'failing-provider',
      mode: 'PROVIDER' as const,
      embed: jest.fn().mockRejectedValue(providerFailure),
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      $transaction: jest.fn(),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never, undefined, embedding);

    await expect(service.create(scope, {
      shopId: 'shop-a', question: '材质是什么？', answer: '316L 不锈钢',
    })).rejects.toBe(providerFailure);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('prepares an approval candidate embedding before its publish transaction', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
    let transactionOpen = false;
    const now = new Date('2026-08-29T00:00:00.000Z');
    const candidate = {
      id: 'candidate-a', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-a', productId: null,
      source: 'AUTO_FAQ', proposedQuestion: '材质是什么？', proposedAnswer: '316L 不锈钢', status: 'PENDING',
      duplicateOfId: null, conflictWithId: null, updatedAt: now,
    };
    const embedding = {
      id: 'approval-provider',
      mode: 'PROVIDER' as const,
      embed: jest.fn(async () => {
        expect(transactionOpen).toBe(false);
        return Array(1536).fill(0);
      }),
    };
    const tx = {
      knowledgeCandidate: {
        findFirst: jest.fn().mockResolvedValue(candidate),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeItem: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'knowledge-a', shopId: 'shop-a', productId: null, scope: 'STORE' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeVersion: {
        create: jest.fn().mockResolvedValue(version('version-a', 'knowledge-a', 1)),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(version('version-a', 'knowledge-a', 1)),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeCandidate: {
        findFirst: jest.fn(async ({ select }: { select?: unknown }) => select ? { shopId: 'shop-a' } : candidate),
      },
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
        transactionOpen = true;
        try {
          return await work(tx);
        } finally {
          transactionOpen = false;
        }
      }),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never, undefined, embedding);

    await expect(service.approveCandidate(scope, candidate.id)).resolves.toMatchObject({ status: 'ACCEPTED', knowledgeId: 'knowledge-a' });
    expect(embedding.embed).toHaveBeenCalledTimes(1);
  });

  it('prepares a reindex embedding outside the transaction and scopes the active CAS', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
    let transactionOpen = false;
    const active = version('version-a', 'knowledge-a', 1);
    const item = {
      id: 'knowledge-a', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-a', productId: null,
      scope: 'STORE', sourceType: 'MANUAL', businessStatus: 'ENABLED', deletedAt: null, activeVersionId: active.id, versions: [active],
    };
    const embedding = {
      id: 'reindex-provider',
      mode: 'PROVIDER' as const,
      embed: jest.fn(async () => {
        expect(transactionOpen).toBe(false);
        return Array(1536).fill(0);
      }),
    };
    const next = version('version-b', item.id, 2);
    const tx = {
      knowledgeItem: {
        findFirst: jest.fn().mockResolvedValue(item),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeVersion: {
        create: jest.fn().mockResolvedValue(next),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(next),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeItem: {
        findFirst: jest.fn(async ({ select }: { select?: unknown }) => select ? { shopId: 'shop-a' } : item),
      },
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
        transactionOpen = true;
        try {
          return await work(tx);
        } finally {
          transactionOpen = false;
        }
      }),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never, undefined, embedding);

    await expect(service.reindex(scope, item.id)).resolves.toMatchObject({ id: next.id, indexStatus: 'READY' });
    expect(tx.knowledgeItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: item.id, activeVersionId: active.id }),
    }));
    expect(embedding.embed).toHaveBeenCalledTimes(1);
  });

  it('rejects a revision when its pre-read active version changes while embedding is computed', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
    const active = version('version-a', 'knowledge-a', 1);
    const item = {
      id: 'knowledge-a',
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: 'shop-a',
      productId: null,
      scope: 'STORE',
      sourceType: 'MANUAL',
      businessStatus: 'ENABLED',
      deletedAt: null,
      activeVersionId: active.id,
      versions: [active],
    };
    let activeVersionId = active.id;
    const embedding = {
      id: 'revision-provider',
      mode: 'PROVIDER' as const,
      embed: jest.fn(async () => {
        activeVersionId = 'version-concurrent';
        return Array(1536).fill(0);
      }),
    };
    const tx = {
      knowledgeItem: {
        findFirst: jest.fn().mockResolvedValue(item),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(async ({ where }: { where: { activeVersionId?: string | null } }) => ({
          count: where.activeVersionId === activeVersionId ? 1 : 0,
        })),
      },
      knowledgeVersion: {
        create: jest.fn().mockResolvedValue(version('version-next', 'knowledge-a', 2)),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(version('version-next', 'knowledge-a', 2)),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeItem: {
        findFirst: jest.fn(async ({ select }: { select?: unknown }) => select ? { shopId: 'shop-a' } : item),
      },
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never, undefined, embedding);

    await expect(service.revise(scope, 'knowledge-a', { answer: '新版说明' })).rejects.toMatchObject({
      status: 409,
      response: { code: 'KNOWLEDGE_VERSION_CHANGED_RETRY' },
    });
    expect(tx.knowledgeItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ activeVersionId: active.id }),
    }));
    expect(tx.knowledgeVersion.create).toHaveBeenCalledTimes(1);
  });

  it('computes import-row embeddings before opening each row transaction', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
    const now = new Date('2026-08-29T00:00:00.000Z');
    let transactionOpen = false;
    const row = importRow('row-a');
    const imported = importHeader('PREVIEWED', now);
    const embedding = {
      id: 'import-provider',
      mode: 'PROVIDER' as const,
      embed: jest.fn(async () => {
        expect(transactionOpen).toBe(false);
        return Array(1536).fill(0);
      }),
    };
    const importDelegate = {
      findFirst: jest.fn(async ({ select }: { select?: unknown }) => select ? { shopId: 'shop-a' } : { ...imported, rows: [row] }),
      updateMany: jest.fn(async ({ where, data }: { where: { status?: string; updatedAt?: Date }; data: Record<string, unknown> }) => {
        if (where.status && where.status !== imported.status) return { count: 0 };
        if (where.updatedAt && where.updatedAt.getTime() !== imported.updatedAt.getTime()) return { count: 0 };
        Object.assign(imported, data);
        return { count: 1 };
      }),
    };
    const rowDelegate = {
      findMany: jest.fn(async ({ where }: { where?: { status?: string } }) => where?.status === 'VALID' ? [row] : [row]),
      findFirst: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row, data);
        return { count: 1 };
      }),
    };
    const tx = {
      knowledgeImport: importDelegate,
      knowledgeImportRow: rowDelegate,
      knowledgeItem: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'knowledge-a' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeVersion: {
        create: jest.fn().mockResolvedValue(version('version-a', 'knowledge-a', 1)),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(version('version-a', 'knowledge-a', 1)),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeImport: importDelegate,
      knowledgeImportRow: rowDelegate,
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
        transactionOpen = true;
        try {
          return await work(tx);
        } finally {
          transactionOpen = false;
        }
      }),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never, undefined, embedding);

    await expect(service.commitImport(scope, imported.id)).resolves.toMatchObject({ status: 'COMMITTED' });
    expect(embedding.embed).toHaveBeenCalledTimes(1);
  });

  it('computes product-learning source embeddings between short transactions', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
    let transactionOpen = false;
    const embedding = {
      id: 'product-provider',
      mode: 'PROVIDER' as const,
      embed: jest.fn(async () => {
        expect(transactionOpen).toBe(false);
        return Array(1536).fill(0);
      }),
    };
    const product = { id: 'product-a', title: '轻羽保温杯', description: '316L 不锈钢内胆，建议手洗。' };
    const tx = {
      product: { findFirst: jest.fn().mockResolvedValue(product), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      productLearningJobItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      knowledgeItem: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'knowledge-a' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeVersion: {
        create: jest.fn().mockResolvedValue(version('version-a', 'knowledge-a', 1)),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(version('version-a', 'knowledge-a', 1)),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
        transactionOpen = true;
        try {
          return await work(tx);
        } finally {
          transactionOpen = false;
        }
      }),
      productLearningJobItem: tx.productLearningJobItem,
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never, undefined, embedding);

    await expect((service as unknown as {
      learnOneProduct(workspace: typeof scope, shopId: string, jobId: string, productId: string): Promise<string>;
    }).learnOneProduct(scope, 'shop-a', 'job-a', product.id)).resolves.toBe('CREATED');
    expect(embedding.embed).toHaveBeenCalledTimes(1);
  });
});

function version(id: string, knowledgeItemId: string, number: number) {
  return {
    id,
    workspaceId: 'workspace-a',
    tenantId: 'tenant-a',
    knowledgeItemId,
    version: number,
    question: '材质是什么？',
    answer: '316L 不锈钢',
    sourceText: '材质是什么？\n316L 不锈钢',
    sourceVersion: 'manual',
    confidence: 1,
    indexStatus: 'READY',
    contentHash: 'hash',
    supersedesId: null,
    effectiveFrom: new Date('2026-08-27T00:00:00.000Z'),
    effectiveTo: null,
    indexedAt: new Date('2026-08-27T00:00:00.000Z'),
    searchTokensJson: [],
  };
}

function importHeader(status: 'PREVIEWED' | 'COMMITTING' | 'COMMITTED', now: Date) {
  return {
    id: 'import-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status,
    totalRows: 1, validRows: 1, duplicateRows: 0, conflictRows: 0, errorRows: 0,
    committedAt: null as Date | null, createdAt: now, updatedAt: now,
  };
}

function importRow(id: string) {
  const now = new Date('2026-08-29T00:00:00.000Z');
  return {
    id, workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', importId: 'import-a', rowNumber: 1,
    scope: 'STORE', productId: null, productExternalId: null, question: '材质是什么？', answer: '316L 不锈钢',
    fingerprint: 'material', status: 'VALID', reason: null, committedKnowledgeItemId: null, committedAt: null,
    createdAt: now, updatedAt: now,
  };
}
