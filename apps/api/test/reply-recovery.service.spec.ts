import { ReplyRecoveryService } from '../src/replies/reply-recovery.service';

describe('ReplyRecoveryService', () => {
  it('claims only context-valid GENERATING jobs, then runs their durable recovery outside the scan transaction', async () => {
    const jobs = [
      { id: 'reply-valid', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', conversationId: 'conversation-valid', sourceContextVersion: 5, status: 'GENERATING' },
      { id: 'reply-stale', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', conversationId: 'conversation-stale', sourceContextVersion: 4, status: 'GENERATING' },
      { id: 'reply-human', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', conversationId: 'conversation-human', sourceContextVersion: 5, status: 'GENERATING' },
    ];
    const prisma = {
      replyJob: {
        findMany: jest.fn().mockResolvedValue(jobs),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({ id: 'conversation-valid', contextVersion: 5, humanActive: false, state: 'ACTIVE' })
          .mockResolvedValueOnce({ id: 'conversation-stale', contextVersion: 5, humanActive: false, state: 'ACTIVE' })
          .mockResolvedValueOnce({ id: 'conversation-human', contextVersion: 5, humanActive: true, state: 'ACTIVE' }),
      },
    };
    const sendOutboxes = { recoverUncertain: jest.fn().mockResolvedValue(2) };
    const drafts = { expireDueAll: jest.fn().mockResolvedValue(1) };
    const runtime = { process: jest.fn().mockResolvedValue({ status: 'WAITING_HUMAN' }) };
    const service = new ReplyRecoveryService(prisma as never, sendOutboxes as never, drafts as never, runtime as never);
    const now = new Date('2026-08-29T00:01:00.000Z');

    await expect(service.recoverOnce(now)).resolves.toEqual({ recoveryPending: 1, stale: 2, uncertain: 2, expiredDrafts: 1 });
    expect(prisma.replyJob.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ OR: expect.arrayContaining([
        { status: 'RECOVERY_PENDING' },
        expect.objectContaining({ status: 'GENERATING', updatedAt: { lt: expect.any(Date) } }),
      ]) }),
      select: expect.objectContaining({ id: true, workspaceId: true, tenantId: true, shopId: true, conversationId: true, sourceContextVersion: true, status: true }),
      take: 100,
    });
    expect(prisma.replyJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'reply-valid', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
        status: 'GENERATING', sourceContextVersion: 5,
      },
      data: { status: 'RECOVERY_PENDING', staleReason: null },
    });
    expect(prisma.replyJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'reply-human', status: 'GENERATING' }),
      data: { status: 'STALE', staleReason: 'HUMAN_ACTIVE' },
    }));
    expect(sendOutboxes.recoverUncertain).toHaveBeenCalledWith(new Date('2026-08-29T00:00:30.000Z'));
    expect(drafts.expireDueAll).toHaveBeenCalledWith(now);
    expect(runtime.process).toHaveBeenCalledWith(
      { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' },
      'reply-valid',
    );
    expect(runtime.process).not.toHaveBeenCalledWith(expect.anything(), 'reply-stale');
  });

  it('does not leave a recovered job parked when the runtime fails after the claim', async () => {
    const prisma = {
      replyJob: {
        findMany: jest.fn().mockResolvedValue([{ id: 'reply-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', conversationId: 'conversation-a', sourceContextVersion: 5, status: 'GENERATING' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE' }) },
    };
    const runtime = { process: jest.fn().mockRejectedValue(new Error('model failure')) };
    const service = new ReplyRecoveryService(prisma as never, { recoverUncertain: jest.fn().mockResolvedValue(0) } as never, { expireDueAll: jest.fn().mockResolvedValue(0) } as never, runtime as never);

    await expect(service.recoverOnce()).resolves.toMatchObject({ recoveryPending: 1 });
    expect(runtime.process).toHaveBeenCalledTimes(1);
  });

  it('retries a crash-left RECOVERY_PENDING job on the next restart instead of scanning only GENERATING', async () => {
    const prisma = {
      replyJob: {
        findMany: jest.fn().mockResolvedValue([{ id: 'reply-pending', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', conversationId: 'conversation-a', sourceContextVersion: 5, status: 'RECOVERY_PENDING' }]),
        updateMany: jest.fn(),
      },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE' }) },
    };
    const runtime = { process: jest.fn().mockResolvedValue({ status: 'READY_TO_SEND' }) };
    const service = new ReplyRecoveryService(prisma as never, { recoverUncertain: jest.fn().mockResolvedValue(0) } as never, { expireDueAll: jest.fn().mockResolvedValue(0) } as never, runtime as never);

    await expect(service.recoverOnce()).resolves.toMatchObject({ recoveryPending: 1, stale: 0 });
    expect(prisma.replyJob.updateMany).not.toHaveBeenCalled();
    expect(runtime.process).toHaveBeenCalledWith({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }, 'reply-pending');
  });

  it('does not claim a fresh slow GENERATING invocation during the periodic recovery scan', async () => {
    const prisma = {
      replyJob: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: { findFirst: jest.fn() },
    };
    const runtime = { process: jest.fn() };
    const now = new Date('2026-08-29T00:03:01.000Z');
    const service = new ReplyRecoveryService(prisma as never, { recoverUncertain: jest.fn().mockResolvedValue(0) } as never, { expireDueAll: jest.fn().mockResolvedValue(0) } as never, runtime as never);

    await service.recoverOnce(now);

    expect(prisma.replyJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ status: 'RECOVERY_PENDING' }, { status: 'GENERATING', updatedAt: { lt: new Date('2026-08-29T00:00:01.000Z') } }] },
    }));
    expect(runtime.process).not.toHaveBeenCalled();
  });
});
