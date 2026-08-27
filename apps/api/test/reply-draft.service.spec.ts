import { ReplyDraftService } from '../src/replies/reply-draft.service';

describe('ReplyDraftService', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

  it('creates an ASSIST draft with a durable five-minute TTL and moves the exact job to WAITING_HUMAN', async () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    const tx = {
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({ id: 'reply-a', conversationId: 'conversation-a', status: 'PENDING', sourceContextVersion: 5, sourceLastMessageId: 'message-8', sourceSequence: 8 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyDraft: { upsert: jest.fn().mockResolvedValue({ id: 'draft-a', status: 'WAITING_HUMAN' }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE' }) },
      $executeRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new ReplyDraftService(prisma as never);

    await expect(service.createWaitingHuman(scope, {
      replyJobId: 'reply-a', aiDraft: '现货商品通常 48 小时内发货。',
      sourceContextVersion: 5, sourceLastMessageId: 'message-8', sourceSequence: 8,
    }, now)).resolves.toMatchObject({ id: 'draft-a', status: 'WAITING_HUMAN' });

    expect(tx.replyJob.findFirst).toHaveBeenCalledWith({
      where: { id: 'reply-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' },
      select: { id: true, conversationId: true, status: true, sourceContextVersion: true, sourceLastMessageId: true, sourceSequence: true },
    });
    expect(tx.replyDraft.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { replyJobId: 'reply-a' },
      create: expect.objectContaining({
        workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', replyJobId: 'reply-a',
        status: 'WAITING_HUMAN', aiDraft: '现货商品通常 48 小时内发货。',
        expiresAt: new Date('2026-08-29T00:05:00.000Z'),
      }),
    }));
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'reply-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', sourceContextVersion: 5, status: { in: ['PENDING', 'GENERATING', 'FAST_PATH_READY'] } },
      data: { status: 'WAITING_HUMAN' },
    });
  });

  it('does not upsert a draft or revive a job when a newer message already made its source context stale', async () => {
    const tx = {
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({ id: 'reply-a', conversationId: 'conversation-a', status: 'GENERATING', sourceContextVersion: 5, sourceLastMessageId: 'message-8', sourceSequence: 8 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      replyDraft: { upsert: jest.fn() },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 6, humanActive: false, state: 'ACTIVE' }) },
      $executeRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new ReplyDraftService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(service.createWaitingHuman(scope, {
      replyJobId: 'reply-a', aiDraft: '旧回复', sourceContextVersion: 5, sourceLastMessageId: 'message-8', sourceSequence: 8,
    })).rejects.toMatchObject({ response: { code: 'REPLY_CONTEXT_STALE' } });
    expect(tx.replyDraft.upsert).not.toHaveBeenCalled();
    expect(tx.replyJob.updateMany).not.toHaveBeenCalled();
  });

  it('expires due drafts and their still-waiting ReplyJobs without crossing the shop boundary', async () => {
    const now = new Date('2026-08-29T00:05:00.000Z');
    const tx = {
      replyDraft: {
        findMany: jest.fn().mockResolvedValue([{ replyJobId: 'reply-a' }, { replyJobId: 'reply-b' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new ReplyDraftService(prisma as never);

    await expect(service.expireDue(scope, now)).resolves.toBe(2);
    expect(tx.replyDraft.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: 'WAITING_HUMAN', expiresAt: { lte: now } },
      select: { replyJobId: true },
    });
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['reply-a', 'reply-b'] }, workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: 'WAITING_HUMAN',
      },
      data: { status: 'EXPIRED' },
    });
  });

  it('scans durable WAITING_HUMAN drafts across restart scopes for the recovery worker', async () => {
    const now = new Date('2026-08-29T00:05:00.000Z');
    const tx = {
      replyDraft: {
        findMany: jest.fn().mockResolvedValue([{ replyJobId: 'reply-a' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new ReplyDraftService(prisma as never);

    await expect(service.expireDueAll(now)).resolves.toBe(1);
    expect(tx.replyDraft.findMany).toHaveBeenCalledWith({
      where: { status: 'WAITING_HUMAN', expiresAt: { lte: now } },
      select: { replyJobId: true },
    });
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['reply-a'] }, status: 'WAITING_HUMAN' },
      data: { status: 'EXPIRED' },
    });
  });
});
