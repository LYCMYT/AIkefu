import { ReplyJobService } from '../src/replies/reply-job.service';

describe('ReplyJobService persistence boundary', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };
  const input = {
    conversationId: 'conversation-a',
    userTurnId: 'turn-a',
    mode: 'ASSIST' as const,
    sourceLastMessageId: 'message-9',
    sourceSequence: 9,
    sourceContextVersion: 4,
    idempotencyKey: 'reply:turn-a:v4',
    evidence: [{
      itemId: 'knowledge-a',
      versionId: 'version-a',
      version: 2,
      source: 'MANUAL' as const,
      scope: 'PRODUCT' as const,
      productId: 'product-a',
      contentSnapshot: { question: '能烘干吗？', answer: '不建议。' },
      retrievalScore: 0.91,
    }],
  };

  it('persists a ReplyJob plus immutable ReplyEvidence within the exact workspace/tenant/shop scope', async () => {
    const tx = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      userTurn: { findFirst: jest.fn().mockResolvedValue({ id: 'turn-a' }) },
      replyJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([{ id: 'reply-old' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'reply-a', status: 'PENDING' }),
      },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyEvidence: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversationMemory: { findFirst: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new ReplyJobService(prisma as never);

    await expect(service.create(scope, input)).resolves.toMatchObject({ id: 'reply-a', status: 'PENDING' });
    expect(tx.conversation.findFirst).toHaveBeenCalledWith({
      where: { id: 'conversation-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' },
      select: { id: true, contextVersion: true },
    });
    expect(tx.userTurn.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'turn-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
      },
      select: { id: true },
    });
    expect(tx.replyJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
        conversationId: 'conversation-a', userTurnId: 'turn-a',
        sourceContextVersion: 4, status: 'PENDING', mode: 'ASSIST',
      }),
    }));
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', conversationId: 'conversation-a',
        status: expect.objectContaining({ in: expect.arrayContaining(['PENDING', 'GENERATING', 'WAITING_HUMAN']) }),
      }),
      data: { status: 'STALE', staleReason: 'NEW_REPLY_JOB' },
    });
    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', replyJobId: { in: ['reply-old'] }, status: 'WAITING_HUMAN' },
      data: { status: 'STALE', staleReason: 'NEW_REPLY_JOB' },
    });
    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conversation-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', contextVersion: 4 },
      data: { needsReplan: false },
    });
    expect(tx.replyEvidence.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', replyJobId: 'reply-a',
        knowledgeItemId: 'knowledge-a', knowledgeVersionId: 'version-a', knowledgeVersionNumber: 2,
        retrievedContentSnapshotJson: { question: '能烘干吗？', answer: '不建议。' },
      })],
    });
  });

  it('does not read, write, or reveal a ReplyJob outside the exact shop scope', async () => {
    const prisma = {
      replyJob: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    };
    const service = new ReplyJobService(prisma as never);

    await expect(service.get({ ...scope, shopId: 'shop-b' }, 'reply-a')).resolves.toBeNull();
    expect(prisma.replyJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'reply-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-b' },
    }));
  });

  it('refuses a user turn that belongs to another shop before any ReplyJob/Evidence write', async () => {
    const tx = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      userTurn: { findFirst: jest.fn().mockResolvedValue(null) },
      replyJob: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn(), create: jest.fn() },
      replyEvidence: { createMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new ReplyJobService(prisma as never);

    await expect(service.create(scope, input)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'REPLY_CONTEXT_NOT_FOUND' }),
    });
    expect(tx.replyJob.create).not.toHaveBeenCalled();
    expect(tx.replyEvidence.createMany).not.toHaveBeenCalled();
  });
});
