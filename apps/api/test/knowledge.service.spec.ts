import { KnowledgeService } from '../src/knowledge/knowledge.service';

describe('KnowledgeService hard scope boundaries', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };

  it('adds workspace, tenant, shop and exact product metadata filters before RAG ranking', async () => {
    const items = [
      ragItem('store', { scope: 'STORE', productId: null }),
      ragItem('product-a', { scope: 'PRODUCT', productId: 'product-a' }),
      ragItem('other-workspace', { workspaceId: 'workspace-b', scope: 'PRODUCT', productId: 'product-a' }),
      ragItem('other-product', { scope: 'PRODUCT', productId: 'product-b' }),
      ragItem('indexing', { indexStatus: 'INDEXING', scope: 'PRODUCT', productId: 'product-a' }),
    ];
    const prisma = fakePrisma(items);
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    const result = await service.search(scope, {
      shopId: 'shop-a',
      productId: 'product-a',
      query: '保温杯材质',
    });

    expect(prisma.knowledgeItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: 'workspace-a',
          tenantId: 'tenant-a',
          shopId: 'shop-a',
          OR: [{ scope: 'STORE', productId: null }, { scope: 'PRODUCT', productId: 'product-a' }],
        }),
      }),
    );
    expect(result).toMatchObject({ status: 'EVIDENCE', conflictItemIds: [] });
    if (result.status !== 'EVIDENCE') throw new Error('expected evidence');
    expect(result.evidence.map((evidence) => evidence.itemId)).toEqual(['product-a', 'store']);
    expect(result.evidence[0]).toMatchObject({
      itemId: 'product-a',
      versionId: 'product-a-version',
      version: 1,
      source: 'MANUAL',
      scope: 'PRODUCT',
      productId: 'product-a',
      contentSnapshot: { question: '保温杯材质', answer: '316L 不锈钢' },
    });
    // Evidence is a snapshot, not a pointer to the mutable knowledge record.
    (items[1]?.versions[0] as { answer: string }).answer = 'later mutation';
    expect(result.evidence[0]?.contentSnapshot.answer).toBe('316L 不锈钢');
  });

  it('short-circuits an OPEN item/version conflict in the same scoped product and never auto-selects it', async () => {
    const enabled = ragItem('enabled', { scope: 'PRODUCT', productId: 'product-a' });
    const alternative = ragItem('alternative', { scope: 'PRODUCT', productId: 'product-a' });
    const prisma = fakePrisma([enabled, alternative], [
      {
        leftItemId: 'enabled',
        rightItemId: 'alternative',
        leftVersionId: 'enabled-version',
        rightVersionId: 'alternative-version',
      },
    ]);
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect(
      service.search(scope, { shopId: 'shop-a', productId: 'product-a', query: '保温杯材质' }),
    ).resolves.toMatchObject({ status: 'CONFLICTED', evidence: [], conflictItemIds: ['alternative', 'enabled'] });
    expect(prisma.knowledgeConflict.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: 'OPEN' },
      select: { leftItemId: true, rightItemId: true, leftVersionId: true, rightVersionId: true },
    });
  });

  it('uses the injected embedding provider seam for scoped pgvector retrieval', async () => {
    const prisma = fakePrisma([ragItem('store')]) as ReturnType<typeof fakePrisma> & { $queryRaw: jest.Mock };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    const embedding = { id: 'configured-test', mode: 'PROVIDER' as const, embed: jest.fn().mockResolvedValue(Array(1536).fill(0)) };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never, undefined, embedding);

    await service.search(scope, { shopId: 'shop-a', query: '杯子材质，联系电话 13800138000' });

    expect(embedding.embed).toHaveBeenCalledWith('杯子材质，联系电话 [REDACTED_PHONE]');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('derives shop ownership from a scoped entity id, then soft-deletes through the full predicate', async () => {
    const prisma = fakePrisma([]);
    prisma.knowledgeItem.updateMany.mockResolvedValue({ count: 1 });
    const gateway = { publish: jest.fn() };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never, gateway as never);

    await expect(service.delete(scope, 'knowledge-a')).resolves.toEqual({ id: 'knowledge-a', status: 'DELETED' });
    expect(prisma.knowledgeItem.findFirst).toHaveBeenCalledWith({
      where: { id: 'knowledge-a', workspaceId: 'workspace-a', tenantId: 'tenant-a' },
      select: { shopId: true },
    });
    expect(prisma.knowledgeItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'knowledge-a',
          workspaceId: 'workspace-a',
          tenantId: 'tenant-a',
          shopId: 'shop-a',
          deletedAt: null,
        }),
      }),
    );
    expect(gateway.publish).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'KNOWLEDGE_UPDATED',
      workspaceId: 'workspace-a',
      entityType: 'KNOWLEDGE',
      entityId: 'knowledge-a',
      payload: expect.objectContaining({ shopId: 'shop-a', knowledgeId: 'knowledge-a', businessStatus: 'DELETED' }),
    }));
  });

  it('lists candidates only through the workspace, tenant, and shop predicate', async () => {
    const prisma = fakePrisma([]);
    prisma.knowledgeCandidate.findMany.mockResolvedValue([
      {
        id: 'candidate-a',
        shopId: 'shop-a',
        productId: null,
        source: 'MANUAL_SAVE',
        proposedQuestion: '材质？',
        proposedAnswer: '316L',
        status: 'PENDING',
        duplicateOfId: null,
        conflictWithId: null,
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect(service.listCandidates(scope, 'shop-a')).resolves.toEqual([
      expect.objectContaining({ id: 'candidate-a', shopId: 'shop-a', status: 'PENDING' }),
    ]);
    expect(prisma.knowledgeCandidate.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' },
      orderBy: { updatedAt: 'desc' },
    });
  });

  it('returns scoped immutable left/right Q&A snapshots for conflict governance', async () => {
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeConflict: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'conflict-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
          leftItemId: 'left-item', rightItemId: 'right-item', leftVersionId: 'left-v', rightVersionId: 'right-v',
          status: 'OPEN', resolutionJson: null, resolvedAt: null, updatedAt: new Date('2026-08-28T00:00:00.000Z'),
        }]),
      },
      knowledgeVersion: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'left-v', knowledgeItemId: 'left-item', version: 1, question: '材质？', answer: '316L', indexStatus: 'READY' },
          { id: 'right-v', knowledgeItemId: 'right-item', version: 2, question: '材质？', answer: '陶瓷' , indexStatus: 'READY' },
        ]),
      },
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);
    const [conflict] = await service.listConflicts(scope, 'shop-a');

    expect(conflict).toMatchObject({
      id: 'conflict-a',
      left: { versionId: 'left-v', itemId: 'left-item', question: '材质？', answer: '316L' },
      right: { versionId: 'right-v', itemId: 'right-item', question: '材质？', answer: '陶瓷' },
    });
    expect(prisma.knowledgeVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 'workspace-a', tenantId: 'tenant-a', id: { in: ['left-v', 'right-v'] } }),
    }));
  });

  it('persists left/right item and version mappings plus a CONFLICTED candidate for a manual contradiction', async () => {
    const published = ragItem('published');
    const createdItem = { ...ragItem('new'), id: 'new', productId: null, scope: 'STORE' };
    const createdVersion = {
      ...createdItem.versions[0],
      id: 'new-version',
      knowledgeItemId: 'new',
      question: '保温杯材质',
      answer: '陶瓷内胆',
      indexStatus: 'READY',
    };
    const tx = {
      knowledgeItem: {
        findMany: jest.fn().mockResolvedValue([published]),
        create: jest.fn().mockResolvedValue(createdItem),
        updateMany: jest.fn(),
      },
      knowledgeVersion: {
        create: jest.fn().mockResolvedValue(createdVersion),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(createdVersion),
      },
      knowledgeConflict: { create: jest.fn() },
      knowledgeCandidate: { create: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect(
      service.create(scope, { shopId: 'shop-a', question: '保温杯材质', answer: '陶瓷内胆' }),
    ).resolves.toMatchObject({ status: 'CONFLICTED', knowledge: { id: 'new', activeVersionId: null } });
    expect(tx.knowledgeConflict.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'workspace-a',
        tenantId: 'tenant-a',
        shopId: 'shop-a',
        leftItemId: 'new',
        leftVersionId: 'new-version',
        rightItemId: 'published',
        rightVersionId: 'published-version',
        status: 'OPEN',
      }),
    });
    expect(tx.knowledgeCandidate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'workspace-a',
        tenantId: 'tenant-a',
        shopId: 'shop-a',
        status: 'CONFLICTED',
        conflictWithId: 'published',
      }),
    });
  });

  it('returns DYNAMIC_FACT_REQUIRED for live order/inventory questions without querying static knowledge', async () => {
    const prisma = fakePrisma([]);
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect(service.search(scope, { shopId: 'shop-a', query: '订单物流到哪里了？' })).resolves.toEqual({
      status: 'DYNAMIC_FACT_REQUIRED',
      evidence: [],
      conflictItemIds: [],
    });
    expect(prisma.knowledgeItem.findMany).not.toHaveBeenCalled();
  });

  it('commits import rows independently: one failed row is ERROR while earlier success remains committed', async () => {
    const now = new Date('2026-08-28T00:00:00.000Z');
    const rows = [
      importRow('row-ok', 'VALID'),
      importRow('row-bad', 'VALID'),
    ];
    const imported = {
      id: 'import-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
      status: 'PREVIEWED', totalRows: 2, validRows: 2, duplicateRows: 0, conflictRows: 0, errorRows: 0,
      committedAt: null, createdAt: now, updatedAt: now,
    };
    const rowDelegate = {
      findMany: jest.fn(async () => rows),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id && row.status === 'VALID') ?? null),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: { status?: string; reason?: string } }) => {
        const row = rows.find((entry) => entry.id === where.id);
        if (!row || row.status !== 'VALID') return { count: 0 };
        if (data.status) row.status = data.status;
        row.reason = data.reason ?? null;
        return { count: 1 };
      }),
    };
    const importDelegate = {
      findFirst: jest.fn(async (args: { select?: unknown; include?: unknown }) => {
        if (args.select) return { shopId: 'shop-a' };
        return { ...imported, rows };
      }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(imported, data);
        return { count: 1 };
      }),
    };
    const tx = { knowledgeImport: importDelegate, knowledgeImportRow: rowDelegate };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeImport: importDelegate,
      knowledgeImportRow: rowDelegate,
      $transaction: jest.fn(async (work: (transaction: typeof tx) => unknown) => work(tx)),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);
    jest.spyOn(service as unknown as { commitRow: (...args: unknown[]) => Promise<void> }, 'commitRow').mockImplementation(async (_tx, _scope, _shop, _import, row: unknown) => {
      const importRow = row as { id: string; status: string };
      if (importRow.id === 'row-bad') throw new Error('synthetic row failure');
      importRow.status = 'COMMITTED';
    });

    const result = await service.commitImport(scope, 'import-a');

    expect(result).toMatchObject({ status: 'COMMITTED', totals: { valid: 1, error: 1 } });
    expect(rows.map((row) => row.status)).toEqual(['COMMITTED', 'ERROR']);
    // Header claim + two row transactions + a dedicated ERROR write + finalization.
    expect(prisma.$transaction).toHaveBeenCalledTimes(5);
  });

  it('takes over a stale COMMITTING import lease and completes remaining rows idempotently', async () => {
    const imported = {
      id: 'import-stale', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
      status: 'COMMITTING', totalRows: 0, validRows: 0, duplicateRows: 0, conflictRows: 0, errorRows: 0,
      committedAt: null, createdAt: new Date('2026-08-01T00:00:00.000Z'), updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const rows: unknown[] = [];
    const importDelegate = {
      findFirst: jest.fn(async (args: { select?: unknown }) => args.select ? { shopId: 'shop-a' } : { ...imported, rows }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(imported, data);
        return { count: 1 };
      }),
    };
    const rowDelegate = { findMany: jest.fn().mockResolvedValue([]) };
    const tx = { knowledgeImport: importDelegate, knowledgeImportRow: rowDelegate };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeImport: importDelegate,
      knowledgeImportRow: rowDelegate,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect(service.commitImport(scope, 'import-stale')).resolves.toMatchObject({ id: 'import-stale', status: 'COMMITTED' });
    expect(importDelegate.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'COMMITTING', updatedAt: expect.any(Object) }),
      data: expect.objectContaining({ status: 'COMMITTING' }),
    }));
  });

  it('keeps a fresh COMMITTING import lease exclusive with HTTP 409 semantics', async () => {
    const now = new Date();
    const imported = {
      id: 'import-fresh', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
      status: 'COMMITTING', totalRows: 0, validRows: 0, duplicateRows: 0, conflictRows: 0, errorRows: 0,
      committedAt: null, createdAt: now, updatedAt: now,
    };
    const importDelegate = {
      findFirst: jest.fn(async (args: { select?: unknown }) => args.select ? { shopId: 'shop-a' } : { ...imported, rows: [] }),
      updateMany: jest.fn(),
    };
    const tx = { knowledgeImport: importDelegate, knowledgeImportRow: { findMany: jest.fn() } };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeImport: importDelegate,
      knowledgeImportRow: tx.knowledgeImportRow,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect(service.commitImport(scope, 'import-fresh')).rejects.toMatchObject({ status: 409 });
    expect(importDelegate.updateMany).not.toHaveBeenCalled();
  });

  it('uses the updatedAt lease token so a timed-out import worker cannot finalize after a takeover', async () => {
    const epoch = new Date('2026-08-28T00:00:00.000Z');
    let now = epoch;
    const imported = {
      id: 'import-lease', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
      status: 'PREVIEWED', totalRows: 1, validRows: 1, duplicateRows: 0, conflictRows: 0, errorRows: 0,
      committedAt: null as Date | null, createdAt: epoch, updatedAt: new Date(epoch.getTime() - 1),
    };
    const rows = [importRow('row-lease', 'VALID')];
    let rowFindManyCall = 0;
    let enterFirstFinal: (() => void) | undefined;
    let releaseFirstFinal: (() => void) | undefined;
    const firstFinalEntered = new Promise<void>((resolve) => { enterFirstFinal = resolve; });
    const firstFinalReleased = new Promise<void>((resolve) => { releaseFirstFinal = resolve; });
    const importDelegate = {
      findFirst: jest.fn(async (args: { select?: unknown }) => (
        args.select ? { shopId: 'shop-a' } : { ...imported, rows: [...rows] }
      )),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.status && where.status !== imported.status) return { count: 0 };
        if (where.updatedAt instanceof Date && where.updatedAt.getTime() !== imported.updatedAt.getTime()) return { count: 0 };
        if (typeof where.updatedAt === 'object' && where.updatedAt !== null && 'lte' in where.updatedAt) {
          const threshold = (where.updatedAt as { lte: Date }).lte;
          if (imported.updatedAt > threshold) return { count: 0 };
        }
        Object.assign(imported, data);
        return { count: 1 };
      }),
    };
    const rowDelegate = {
      findMany: jest.fn(async (args: { where?: { status?: string } }) => {
        rowFindManyCall += 1;
        if (rowFindManyCall === 2) {
          enterFirstFinal?.();
          await firstFinalReleased;
        }
        return args.where?.status === 'VALID' ? rows.filter((row) => row.status === 'VALID') : [...rows];
      }),
      findFirst: jest.fn(async ({ where }: { where: { id: string; status?: string } }) =>
        rows.find((row) => row.id === where.id && (!where.status || row.status === where.status)) ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const tx = { knowledgeImport: importDelegate, knowledgeImportRow: rowDelegate };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeImport: importDelegate,
      knowledgeImportRow: rowDelegate,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);
    jest.spyOn(service as unknown as { now: () => Date }, 'now').mockImplementation(() => now);
    jest.spyOn(service as unknown as { commitRow: (...args: unknown[]) => Promise<void> }, 'commitRow').mockImplementation(async (_tx, _scope, _shop, _importId, row: unknown) => {
      (row as { status: string }).status = 'COMMITTED';
    });

    const workerOne = service.commitImport(scope, 'import-lease');
    await firstFinalEntered;
    now = new Date(epoch.getTime() + 61_001);
    await expect(service.commitImport(scope, 'import-lease')).resolves.toMatchObject({ status: 'COMMITTED' });
    releaseFirstFinal?.();

    await expect(workerOne).rejects.toMatchObject({ status: 409, response: { code: 'KNOWLEDGE_IMPORT_LEASE_LOST' } });
    expect(imported.status).toBe('COMMITTED');
    expect(importDelegate.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'COMMITTING', updatedAt: expect.any(Date) }),
    }));
  });

  it('reclaims a stale same-fingerprint RUNNING product job and stale PROCESSING items through CAS', async () => {
    const now = new Date('2026-08-28T01:01:00.000Z');
    const stale = new Date(now.getTime() - 60_001);
    const existing = {
      id: 'job-stale', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', sourceFingerprint: 'fingerprint',
      status: 'RUNNING', totalProducts: 1, createdProducts: 0, updatedProducts: 0, skippedProducts: 0, failedProducts: 0,
      startedAt: stale, completedAt: null, createdAt: stale, updatedAt: stale,
      items: [{ productId: 'product-a', status: 'PROCESSING', reason: 'crashed', updatedAt: stale }],
    };
    const productLearningJob = { findFirst: jest.fn().mockResolvedValue(existing), updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    const productLearningJobItem = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    const tx = { productLearningJob, productLearningJobItem };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      productLearningJob,
      productLearningJobItem,
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);
    jest.spyOn(service as unknown as { now: () => Date }, 'now').mockReturnValue(now);
    const run = jest.spyOn(service as unknown as { runProductLearningJob: (...args: unknown[]) => Promise<unknown> }, 'runProductLearningJob')
      .mockResolvedValue({ id: 'job-stale', status: 'SUCCEEDED', totals: {}, items: [] });

    await expect(service.startProductLearning(scope, 'shop-a')).resolves.toMatchObject({ id: 'job-stale', status: 'SUCCEEDED' });
    expect(prisma.productLearningJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'job-stale', status: 'RUNNING', updatedAt: stale }),
      data: expect.objectContaining({ status: 'PENDING' }),
    }));
    expect(prisma.productLearningJobItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ jobId: 'job-stale', status: 'PROCESSING', updatedAt: { lte: new Date(now.getTime() - 60_000) } }),
      data: { status: 'PENDING', reason: null },
    }));
    expect(run).toHaveBeenCalledWith(scope, 'job-stale', 'shop-a');
  });

  it('leaves a fresh RUNNING product job alone instead of starting a duplicate worker', async () => {
    const now = new Date('2026-08-28T01:01:00.000Z');
    const existing = {
      id: 'job-fresh', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', sourceFingerprint: 'fingerprint',
      status: 'RUNNING', totalProducts: 1, createdProducts: 0, updatedProducts: 0, skippedProducts: 0, failedProducts: 0,
      startedAt: now, completedAt: null, createdAt: now, updatedAt: now,
      items: [{ productId: 'product-a', status: 'PROCESSING', reason: null }],
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      productLearningJob: { findFirst: jest.fn().mockResolvedValue(existing), updateMany: jest.fn() },
      productLearningJobItem: { updateMany: jest.fn() },
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);
    jest.spyOn(service as unknown as { now: () => Date }, 'now').mockReturnValue(now);

    await expect(service.startProductLearning(scope, 'shop-a')).resolves.toMatchObject({ id: 'job-fresh', status: 'RUNNING' });
    expect(prisma.productLearningJob.updateMany).not.toHaveBeenCalled();
    expect(prisma.productLearningJobItem.updateMany).not.toHaveBeenCalled();
  });

  it.each([false, true])('resumes a durable PENDING product job regardless of retryFailed=%s', async (retryFailed) => {
    const now = new Date('2026-08-28T01:01:00.000Z');
    const existing = {
      id: 'job-pending-resume', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', sourceFingerprint: 'fingerprint',
      status: 'PENDING', totalProducts: 1, createdProducts: 0, updatedProducts: 0, skippedProducts: 0, failedProducts: 0,
      startedAt: null, completedAt: null, createdAt: now, updatedAt: now,
      items: [{ productId: 'product-a', status: 'PENDING', reason: null }],
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'product-a', contentHash: 'hash-a', title: '保温杯', description: '316L' }]) },
      productLearningJob: { findFirst: jest.fn().mockResolvedValue(existing) },
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);
    const run = jest.spyOn(service as unknown as { runProductLearningJob: (...args: unknown[]) => Promise<unknown> }, 'runProductLearningJob')
      .mockResolvedValue({ id: 'job-pending-resume', status: 'SUCCEEDED', totals: {}, items: [] });

    await expect(service.startProductLearning(scope, 'shop-a', undefined, retryFailed)).resolves.toMatchObject({
      id: 'job-pending-resume', status: 'SUCCEEDED',
    });
    expect(run).toHaveBeenCalledWith(scope, 'job-pending-resume', 'shop-a');
  });

  it('CAS-claims a recovered PENDING job once while a concurrent caller only observes the RUNNING lease', async () => {
    const now = new Date('2026-08-28T01:01:00.000Z');
    const job = {
      id: 'job-pending-race', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', sourceFingerprint: 'fingerprint',
      status: 'PENDING', totalProducts: 1, createdProducts: 0, updatedProducts: 0, skippedProducts: 0, failedProducts: 0,
      startedAt: null as Date | null, completedAt: null as Date | null, createdAt: new Date(now.getTime() - 1), updatedAt: new Date(now.getTime() - 1),
      items: [{ productId: 'product-a', status: 'PENDING', reason: null as string | null }],
    };
    let signalFirstItem: (() => void) | undefined;
    let releaseFirstItem: (() => void) | undefined;
    const firstItemEntered = new Promise<void>((resolve) => { signalFirstItem = resolve; });
    const firstItemReleased = new Promise<void>((resolve) => { releaseFirstItem = resolve; });
    const snapshot = () => ({ ...job, items: job.items.map((item) => ({ ...item })) });
    const productLearningJob = {
      findFirst: jest.fn(async () => snapshot()),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.status && where.status !== job.status) return { count: 0 };
        if (where.updatedAt instanceof Date && where.updatedAt.getTime() !== job.updatedAt.getTime()) return { count: 0 };
        Object.assign(job, data);
        return { count: 1 };
      }),
    };
    const productLearningJobItem = { findMany: jest.fn(async () => job.items.map((item) => ({ ...item }))) };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'product-a', contentHash: 'hash-a', title: '保温杯', description: '316L' }]) },
      productLearningJob,
      productLearningJobItem,
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);
    jest.spyOn(service as unknown as { now: () => Date }, 'now').mockReturnValue(now);
    const learnOne = jest.spyOn(service as unknown as { learnOneProduct: (...args: unknown[]) => Promise<unknown> }, 'learnOneProduct')
      .mockImplementation(async () => {
        signalFirstItem?.();
        await firstItemReleased;
        job.items[0]!.status = 'SUCCEEDED';
        job.items[0]!.reason = 'CONTENT_UNCHANGED';
        return 'SKIPPED';
      });

    const owner = service.startProductLearning(scope, 'shop-a');
    await firstItemEntered;
    await expect(service.startProductLearning(scope, 'shop-a')).resolves.toMatchObject({ id: 'job-pending-race', status: 'RUNNING' });
    expect(learnOne).toHaveBeenCalledTimes(1);

    releaseFirstItem?.();
    await expect(owner).resolves.toMatchObject({ id: 'job-pending-race', status: 'SUCCEEDED' });
    expect(learnOne).toHaveBeenCalledTimes(1);
    expect(productLearningJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'job-pending-race', status: 'PENDING', updatedAt: expect.any(Date) }),
      data: expect.objectContaining({ status: 'RUNNING' }),
    }));
  });

  it('claims and finalizes product jobs through the current scoped lease token', async () => {
    const now = new Date('2026-08-28T01:01:00.000Z');
    const pending = {
      id: 'job-pending', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', sourceFingerprint: 'fingerprint',
      status: 'PENDING', totalProducts: 0, createdProducts: 0, updatedProducts: 0, skippedProducts: 0, failedProducts: 0,
      startedAt: null, completedAt: null, createdAt: now, updatedAt: new Date(now.getTime() - 1), items: [],
    };
    const prisma = {
      productLearningJob: {
        findFirst: jest.fn().mockImplementation(async () => ({ ...pending, items: [] })),
        updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (where.status && where.status !== pending.status) return { count: 0 };
          if (where.updatedAt instanceof Date && where.updatedAt.getTime() !== pending.updatedAt.getTime()) return { count: 0 };
          Object.assign(pending, data);
          return { count: 1 };
        }),
      },
      productLearningJobItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);
    jest.spyOn(service as unknown as { now: () => Date }, 'now').mockReturnValue(now);

    await expect((service as unknown as { runProductLearningJob: (workspace: typeof scope, jobId: string, shopId: string) => Promise<unknown> })
      .runProductLearningJob(scope, 'job-pending', 'shop-a')).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(prisma.productLearningJob.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: 'job-pending', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: 'PENDING', updatedAt: expect.any(Date) }),
      data: expect.objectContaining({ status: 'RUNNING', updatedAt: expect.any(Date) }),
    }));
    expect(prisma.productLearningJob.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ id: 'job-pending', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: 'RUNNING', updatedAt: expect.any(Date) }),
      data: expect.objectContaining({ status: 'SUCCEEDED' }),
    }));
  });

  it('rejects a model FAQ that lies about PII instead of creating a candidate', async () => {
    const tx = {
      product: { findFirst: jest.fn().mockResolvedValue({ id: 'product-a' }) },
      knowledgeCandidate: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)) };
    const runtime = {
      runStructured: jest.fn().mockResolvedValue({
        output: {
          question: '请联系 13800138000 了解材质？', answer: '客服会联系您。', scope: 'PRODUCT', productId: 'product-a',
          candidateType: 'NEW_KNOWLEDGE', shouldCreate: true, containsPII: false, containsTemporaryCommitment: false,
        },
      }),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);
    (service as unknown as { aiRuntime: unknown }).aiRuntime = runtime;

    await expect((service as unknown as { extractProductFaqCandidate: (workspace: typeof scope, shopId: string, source: { productId: string; title: string; sourceText: string }) => Promise<void> })
      .extractProductFaqCandidate(scope, 'shop-a', { productId: 'product-a', title: '保温杯', sourceText: '316L 不锈钢' })).resolves.toBeUndefined();
    expect(tx.knowledgeCandidate.create).not.toHaveBeenCalled();
  });

  it('rejects a PII-bearing candidate again at approval before any knowledge write', async () => {
    const candidate = {
      id: 'candidate-pii', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', productId: null,
      source: 'AUTO_FAQ', proposedQuestion: '客服电话是多少？', proposedAnswer: '请拨打 13800138000', status: 'PENDING',
      duplicateOfId: null, conflictWithId: null,
    };
    const tx = {
      knowledgeCandidate: { findFirst: jest.fn().mockResolvedValue(candidate) },
      knowledgeItem: { findMany: jest.fn(() => { throw new Error('PII must be rejected before matching'); }) },
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeCandidate: {
        findFirst: jest.fn(async ({ select }: { select?: unknown }) => select ? { shopId: 'shop-a' } : candidate),
      },
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect(service.approveCandidate(scope, 'candidate-pii')).rejects.toMatchObject({ response: { code: 'KNOWLEDGE_PII_FORBIDDEN' } });
    expect(tx.knowledgeItem.findMany).not.toHaveBeenCalled();
  });

  it('marks PII import preview rows with the stable policy error before they can be committed', async () => {
    const now = new Date('2026-08-28T01:01:00.000Z');
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeImport: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: { data: Record<string, any> }) => ({
          id: 'import-pii', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: 'PREVIEWED',
          totalRows: data.totalRows, validRows: data.validRows, duplicateRows: data.duplicateRows, conflictRows: data.conflictRows, errorRows: data.errorRows,
          committedAt: null, createdAt: now, updatedAt: now,
          rows: data.rows.create.map((row: Record<string, unknown>) => ({ ...row, id: 'row-pii', committedKnowledgeItemId: null, committedAt: null, createdAt: now, updatedAt: now })),
        })),
      },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      knowledgeItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect(service.previewImport(scope, {
      shopId: 'shop-a',
      csv: 'question,answer\n客服电话是多少？,请拨打 13800138000',
    })).resolves.toMatchObject({ totals: { error: 1 }, rows: [{ status: 'ERROR', reason: 'KNOWLEDGE_PII_FORBIDDEN' }] });
    expect(prisma.knowledgeImport.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        rows: { create: [expect.objectContaining({ status: 'ERROR', reason: 'KNOWLEDGE_PII_FORBIDDEN' })] },
      }),
    }));
  });

  it('rejects PII on manual create before a knowledge transaction begins', async () => {
    const prisma = { shop: { findFirst: jest.fn() } };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect(service.create(scope, {
      shopId: 'shop-a', question: '联系方式？', answer: '请拨打 13800138000',
    })).rejects.toMatchObject({ response: { code: 'KNOWLEDGE_PII_FORBIDDEN' } });
    expect(prisma.shop.findFirst).not.toHaveBeenCalled();
  });

  it('rejects PII on manual revise before it can create a new version', async () => {
    const active = {
      id: 'version-a', knowledgeItemId: 'knowledge-a', version: 1, question: '材质？', answer: '316L',
      indexStatus: 'READY', activeVersionId: 'version-a', effectiveFrom: new Date(), effectiveTo: null,
    };
    const tx = {
      knowledgeItem: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'knowledge-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', productId: null,
          scope: 'STORE', activeVersionId: 'version-a', versions: [active],
        }),
        findMany: jest.fn(() => { throw new Error('PII must be rejected before matching'); }),
      },
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      knowledgeItem: {
        findFirst: jest.fn(async ({ select }: { select?: unknown }) => select ? { shopId: 'shop-a' } : {
          id: 'knowledge-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', productId: null,
          scope: 'STORE', activeVersionId: 'version-a', versions: [active],
        }),
      },
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect(service.revise(scope, 'knowledge-a', { answer: '客服号码是 13800138000' }))
      .rejects.toMatchObject({ response: { code: 'KNOWLEDGE_PII_FORBIDDEN' } });
    expect(tx.knowledgeItem.findMany).not.toHaveBeenCalled();
  });

  it('rechecks persisted VALID import text for PII inside the commit transaction', async () => {
    const row = { ...importRow('row-commit-pii', 'VALID'), question: '联系方式？', answer: '请拨打 13800138000' };
    const tx = {
      knowledgeImportRow: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      knowledgeItem: { findMany: jest.fn(() => { throw new Error('PII must be rejected before import write'); }) },
    };
    const service = new KnowledgeService({} as never, { load: jest.fn() } as never);

    const commitRow = (service as unknown as { commitRow: (...args: unknown[]) => Promise<void> }).commitRow;
    await expect(commitRow.call(service, tx, scope, 'shop-a', 'import-pii', row)).resolves.toBeUndefined();
    expect(tx.knowledgeImportRow.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'row-commit-pii', shopId: 'shop-a' }),
      data: { status: 'ERROR', reason: 'KNOWLEDGE_PII_FORBIDDEN' },
    }));
    expect(tx.knowledgeItem.findMany).not.toHaveBeenCalled();
  });

  it('fails deterministic product learning before an enabled version or FAQ candidate when catalog text contains PII', async () => {
    const tx = {
      product: { findFirst: jest.fn().mockResolvedValue({ id: 'product-a', title: '保温杯 13800138000', description: '售后邮箱 service@example.com' }) },
      productLearningJobItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      knowledgeItem: { findFirst: jest.fn(() => { throw new Error('PII source must not reach knowledge writes'); }) },
    };
    const prisma = { $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);

    await expect((service as unknown as { learnOneProduct: (workspace: typeof scope, shopId: string, jobId: string, productId: string) => Promise<string> })
      .learnOneProduct(scope, 'shop-a', 'job-pii', 'product-a')).resolves.toBe('FAILED');
    expect(tx.productLearningJobItem.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ jobId: 'job-pii', productId: 'product-a' }),
      data: { status: 'FAILED', reason: 'KNOWLEDGE_PII_FORBIDDEN' },
    }));
    expect(tx.knowledgeItem.findFirst).not.toHaveBeenCalled();
  });

  it('auto-enables high-confidence synthetic source facts while saving an AI FAQ as a review candidate', async () => {
    const product = { id: 'product-a', title: '轻羽保温杯', description: '316L 不锈钢内胆。建议手洗。' };
    const readyVersion = { id: 'version-a', indexStatus: 'READY' };
    const tx = {
      product: { findFirst: jest.fn().mockResolvedValue(product), updateMany: jest.fn() },
      productLearningJobItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      knowledgeItem: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'knowledge-a' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeVersion: {
        create: jest.fn().mockResolvedValue({ id: 'version-a' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(readyVersion),
      },
      knowledgeCandidate: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'candidate-a' }),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = { $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)), productLearningJobItem: tx.productLearningJobItem };
    const runtime = {
      runStructured: jest.fn().mockResolvedValue({
        output: {
          question: '可以用洗碗机清洗吗？', answer: '建议手洗以延长内胆寿命。', scope: 'PRODUCT', productId: 'product-a',
          candidateType: 'NEW_KNOWLEDGE', shouldCreate: true, containsPII: false, containsTemporaryCommitment: false,
        },
      }),
    };
    const service = new KnowledgeService(prisma as never, { load: jest.fn() } as never);
    (service as unknown as { aiRuntime: unknown }).aiRuntime = runtime;

    await expect(
      (service as unknown as { learnOneProduct: (workspace: { workspaceId: string; tenantId: string }, shopId: string, jobId: string, productId: string) => Promise<string> })
        .learnOneProduct(scope, 'shop-a', 'job-a', 'product-a'),
    ).resolves.toBe('CREATED');

    expect(tx.knowledgeItem.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sourceType: 'AUTO_LEARNED', businessStatus: 'ENABLED', productId: 'product-a' }),
    }));
    expect(tx.knowledgeVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ confidence: 0.95 }),
    }));
    expect(runtime.runStructured).toHaveBeenCalledWith(
      { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' },
      expect.objectContaining({ purpose: 'KNOWLEDGE_EXTRACT', schema: 'KnowledgeCandidate' }),
    );
    expect(tx.knowledgeCandidate.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        source: 'AUTO_FAQ', productId: 'product-a', status: 'PENDING',
        proposedQuestion: '可以用洗碗机清洗吗？', proposedAnswer: '建议手洗以延长内胆寿命。',
      }),
    }));
  });

  it('publishes a scoped PRODUCT_UPDATED event after synthetic product sync commits', async () => {
    const tx = {
      product: { upsert: jest.fn().mockResolvedValue({ id: 'product-a' }) },
      productSku: { upsert: jest.fn().mockResolvedValue({ id: 'sku-a' }) },
    };
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a', seedKey: 'shop-seed' }) },
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const seeds = {
      load: jest.fn().mockResolvedValue({
        products: [{
          key: 'product-seed',
          shopKey: 'shop-seed',
          externalProductId: 'external-product-a',
          title: '保温杯',
          description: '稳定商品描述',
          status: 'ACTIVE',
          recommendable: true,
          skus: [{ externalSkuId: 'sku-external-a', attributes: {}, price: '39.00', inventory: 10 }],
        }],
      }),
    };
    const gateway = { publish: jest.fn() };
    const service = new KnowledgeService(prisma as never, seeds as never, gateway as never);

    await expect(service.syncProducts(scope, 'shop-a')).resolves.toEqual({
      status: 'SUCCEEDED', synthetic: true, productsSynced: 1,
    });
    expect(gateway.publish).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'PRODUCT_UPDATED',
      workspaceId: 'workspace-a',
      entityType: 'PRODUCT',
      entityId: 'product-a',
      payload: expect.objectContaining({ shopId: 'shop-a', productId: 'product-a' }),
    }));
  });
});

function importRow(id: string, status: string): {
  id: string; workspaceId: string; tenantId: string; shopId: string; importId: string; rowNumber: number;
  scope: string; productId: null; productExternalId: null; question: string; answer: string; fingerprint: string;
  status: string; reason: string | null; committedKnowledgeItemId: null; committedAt: null; createdAt: Date; updatedAt: Date;
} {
  const now = new Date('2026-08-28T00:00:00.000Z');
  return {
    id, workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', importId: 'import-a', rowNumber: id === 'row-ok' ? 2 : 3,
    scope: 'STORE', productId: null, productExternalId: null, question: `${id} question`, answer: `${id} answer`, fingerprint: 'fp',
    status, reason: null, committedKnowledgeItemId: null, committedAt: null, createdAt: now, updatedAt: now,
  };
}

function fakePrisma(items: unknown[], conflicts: unknown[] = []) {
  return {
    shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
    product: { findFirst: jest.fn().mockResolvedValue({ id: 'product-a' }) },
    knowledgeItem: {
      findFirst: jest.fn().mockResolvedValue({ shopId: 'shop-a' }),
      findMany: jest.fn().mockResolvedValue(items),
      updateMany: jest.fn(),
    },
    knowledgeConflict: {
      findMany: jest.fn().mockResolvedValue(conflicts),
    },
    knowledgeCandidate: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function ragItem(
  id: string,
  overrides: Partial<{
    workspaceId: string;
    tenantId: string;
    shopId: string;
    scope: 'STORE' | 'PRODUCT';
    productId: string | null;
    businessStatus: 'ENABLED' | 'CONFLICTED';
    indexStatus: 'READY' | 'INDEXING';
  }> = {},
) {
  const versionId = `${id}-version`;
  return {
    id,
    workspaceId: 'workspace-a',
    tenantId: 'tenant-a',
    shopId: 'shop-a',
    productId: null,
    scope: 'STORE',
    sourceType: 'MANUAL',
    businessStatus: 'ENABLED',
    activeVersionId: versionId,
    deletedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    versions: [
      {
        id: versionId,
        workspaceId: overrides.workspaceId ?? 'workspace-a',
        tenantId: overrides.tenantId ?? 'tenant-a',
        knowledgeItemId: id,
        version: 1,
        question: '保温杯材质',
        answer: '316L 不锈钢',
        sourceText: '保温杯材质\n316L 不锈钢',
        sourceVersion: 'test',
        confidence: 1,
        indexStatus: overrides.indexStatus ?? 'READY',
        searchTokensJson: [],
        contentHash: 'hash',
        indexedAt: new Date('2026-08-01T00:00:00.000Z'),
        indexError: null,
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        effectiveTo: null,
        supersedesId: null,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ],
    ...overrides,
  };
}
