import { PrismaMessageApplication } from '../src/messages/prisma-message.application';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };

describe('durable UserTurn → ReplyJob pipeline', () => {
  it('persists a deterministic USER_TURN_READY ProcessingOutbox beside the flushed UserTurn', async () => {
    const now = new Date('2020-08-29T00:00:00.000Z');
    const buffer = {
      id: 'buffer-a', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-a', conversationId: 'conversation-a',
      status: 'BUFFERING', generation: 3, firstSequence: 7, latestSequence: 8,
      idleDeadline: new Date(now.getTime() - 1), hardDeadline: new Date(now.getTime() + 1_000),
    };
    const turn = {
      id: 'turn-a', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-a', conversationId: 'conversation-a',
      sourceMessageIdsJson: ['message-7', 'message-8'], firstSequence: 7, lastSequence: 8, normalizedText: 'first\nsecond',
      status: 'OPEN', createdAt: now, updatedAt: now,
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      conversationTurnBuffer: {
        findUnique: jest.fn().mockResolvedValue(buffer),
        update: jest.fn().mockResolvedValue(buffer),
      },
      conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'conversation-a', buyerId: 'buyer-a', contextVersion: 5 }) },
      message: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'message-7', kind: 'TEXT', contentJson: { text: 'first' } },
          { id: 'message-8', kind: 'TEXT', contentJson: { text: 'second' } },
        ]),
      },
      userTurn: { upsert: jest.fn().mockResolvedValue(turn) },
      processingOutbox: { upsert: jest.fn().mockResolvedValue({ id: 'outbox-plan-a' }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const app = new PrismaMessageApplication(prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never);
    jest.spyOn(app as any, 'publishTurnBuffer').mockResolvedValue(undefined);

    await (app as any).flushTurn('conversation-a', 3);

    expect(tx.processingOutbox.upsert).toHaveBeenCalledWith({
      where: { eventId: 'reply-plan:turn-a' },
      update: {},
      create: expect.objectContaining({
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        shopId: 'shop-a',
        eventId: 'reply-plan:turn-a',
        aggregateType: 'USER_TURN',
        aggregateId: 'turn-a',
        eventType: 'USER_TURN_READY',
        payloadJson: {
          conversationId: 'conversation-a',
          userTurnId: 'turn-a',
          sourceLastMessageId: 'message-8',
          sourceSequence: 8,
          sourceContextVersion: 5,
        },
      }),
    });
  });

  it('plans exactly one scoped ReplyJob from USER_TURN_READY and does not duplicate after its receipt', async () => {
    const outbox = {
      id: 'outbox-plan-a', eventId: 'reply-plan:turn-a', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-a',
      eventType: 'USER_TURN_READY',
      payloadJson: {
        conversationId: 'conversation-a', userTurnId: 'turn-a', sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5,
      },
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      processingReceipt: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'receipt-a' }) },
      processingOutbox: { findUnique: jest.fn().mockResolvedValue(outbox) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ lastCommittedSequence: 8, contextVersion: 5 }) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-8', sequence: 8 }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED' }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const replyJobs = { createInTransaction: jest.fn().mockResolvedValue({ id: 'reply-a', status: 'PENDING' }) };
    const app = new PrismaMessageApplication(
      prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never, replyJobs as never,
    );

    await (app as any).consumeOutbox('reply-plan:turn-a');

    expect(replyJobs.createInTransaction).toHaveBeenCalledWith(tx, {
      workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-a',
    }, {
      conversationId: 'conversation-a', userTurnId: 'turn-a', mode: 'AUTO',
      sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5,
      idempotencyKey: 'reply-plan:turn-a', evidence: [],
    }, { lockHeld: true });
    expect(tx.processingReceipt.create).toHaveBeenCalledWith({
      data: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-a', eventId: 'reply-plan:turn-a' },
    });

    tx.processingReceipt.findUnique.mockResolvedValue({ id: 'receipt-a' });
    await (app as any).consumeOutbox('reply-plan:turn-a');
    expect(replyJobs.createInTransaction).toHaveBeenCalledTimes(1);
  });

  it('runs the ReplyJob only after the USER_TURN_READY transaction and receipt are durable', async () => {
    const outbox = {
      id: 'outbox-plan-a', eventId: 'reply-plan:turn-a', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-a',
      eventType: 'USER_TURN_READY',
      payloadJson: { conversationId: 'conversation-a', userTurnId: 'turn-a', sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5 },
    };
    let committed = false;
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      processingReceipt: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'receipt-a' }) },
      processingOutbox: { findUnique: jest.fn().mockResolvedValue(outbox) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ lastCommittedSequence: 8, contextVersion: 5 }) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-8', sequence: 8 }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED' }) },
    };
    const prisma = { $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
      const result = await work(tx); committed = true; return result;
    }) };
    const replyJobs = { createInTransaction: jest.fn().mockResolvedValue({ id: 'reply-a', status: 'PENDING' }) };
    const runtime = { process: jest.fn(async () => expect(committed).toBe(true)) };
    const app = new PrismaMessageApplication(
      prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never,
      replyJobs as never, undefined, runtime as never,
    );

    await (app as any).consumeOutbox('reply-plan:turn-a');
    expect(runtime.process).toHaveBeenCalledWith({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }, 'reply-a');
  });

  it('discards a delayed old turn when a later buyer message advanced context, while still allowing a welcome-only tail advance', async () => {
    const outbox = {
      id: 'outbox-plan-old', eventId: 'reply-plan:turn-old', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-a',
      eventType: 'USER_TURN_READY',
      payloadJson: { conversationId: 'conversation-a', userTurnId: 'turn-old', sourceLastMessageId: 'buyer-1', sourceSequence: 1, sourceContextVersion: 5 },
    };
    const tx = {
      $executeRaw: jest.fn(),
      processingReceipt: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'receipt-old' }) },
      processingOutbox: { findUnique: jest.fn().mockResolvedValue(outbox) },
      // Tail may be 2 due to welcome, but version 6 proves a newer buyer turn.
      conversation: { findFirst: jest.fn().mockResolvedValue({ lastCommittedSequence: 2, contextVersion: 6 }) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'buyer-2', sequence: 2 }) },
    };
    const replyJobs = { createInTransaction: jest.fn() };
    const app = new PrismaMessageApplication({ $transaction: jest.fn((work: Function) => work(tx)) } as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never, replyJobs as never);

    await expect((app as any).consumeOutbox('reply-plan:turn-old')).resolves.toBeUndefined();
    expect(replyJobs.createInTransaction).not.toHaveBeenCalled();
    expect(tx.processingReceipt.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventId: 'reply-plan:turn-old' }) });
  });
});
