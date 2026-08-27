import { SendOutboxService } from '../src/replies/send-outbox.service';
import { ReplyIncidentPublisher } from '../src/incidents/reply-incident.publisher';

describe('SendOutboxService', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };
  const input = {
    replyJobId: 'reply-a', conversationId: 'conversation-a', idempotencyKey: 'send:reply-a', text: '现货商品通常 48 小时内发货。',
    expectedLastMessageId: 'message-8', expectedSequence: 8, expectedContextVersion: 5,
  };

  it('persists a scoped PENDING send intent and returns the same record for a duplicate idempotency key', async () => {
    const tx = {
      replyJob: { findFirst: jest.fn().mockResolvedValue({ id: 'reply-a', conversationId: 'conversation-a' }) },
      sendOutbox: {
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'send-a', status: 'PENDING' }),
        create: jest.fn().mockResolvedValue({ id: 'send-a', status: 'PENDING' }),
      },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new SendOutboxService(prisma as never);

    await expect(service.enqueue(scope, input)).resolves.toMatchObject({ id: 'send-a', status: 'PENDING' });
    expect(tx.replyJob.findFirst).toHaveBeenCalledWith({
      where: { id: 'reply-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' },
      select: { id: true, conversationId: true },
    });
    expect(tx.sendOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', replyJobId: 'reply-a', conversationId: 'conversation-a',
        idempotencyKey: 'send:reply-a', status: 'PENDING',
        expectedLastMessageId: 'message-8', expectedSequence: 8, expectedContextVersion: 5,
        payloadJson: { text: '现货商品通常 48 小时内发货。', senderRole: 'AI' },
      }),
    });
    await expect(service.enqueue(scope, input)).resolves.toMatchObject({ id: 'send-a', status: 'PENDING' });
    expect(tx.sendOutbox.create).toHaveBeenCalledTimes(1);
  });

  it('records a receipt atomically and recovers stale SENDING rows as UNCERTAIN instead of retrying them', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      sendOutbox: {
        findFirst: jest.fn().mockResolvedValue({ id: 'send-a', replyJobId: 'reply-a' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
      sendOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const service = new SendOutboxService(prisma as never);

    await expect(service.recordReceipt(scope, 'send-a', { externalMessageId: 'platform-message-a' })).resolves.toBe(true);
    expect(tx.sendOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'send-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: 'SENDING' },
      data: { status: 'SENT', receiptJson: { externalMessageId: 'platform-message-a' }, failureCode: null, failureReason: null },
    });
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SENT' } }));

    const staleBefore = new Date('2026-08-29T00:00:00.000Z');
    await expect(service.recoverUncertain(staleBefore)).resolves.toBe(2);
    expect(prisma.sendOutbox.updateMany).toHaveBeenCalledWith({
      where: { status: 'SENDING', updatedAt: { lt: staleBefore } },
      data: { status: 'UNCERTAIN', failureCode: 'SEND_UNCERTAIN' },
    });
  });

  it('moves an incident correction to CORRECTED only when its HUMAN outbox receipt is durable', async () => {
    const tx = {
      sendOutbox: { findFirst: jest.fn().mockResolvedValue({ id: 'correction-send', replyJobId: null }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new SendOutboxService({ $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) } as never);
    await expect(service.recordReceipt(scope, 'correction-send', { externalMessageId: 'platform-correction-a' })).resolves.toBe(true);
    expect(tx.replyIncident.updateMany).toHaveBeenCalledWith({
      where: { ...scope, correctionSendOutboxId: 'correction-send', status: 'CORRECTION_DRAFTED' }, data: { status: 'CORRECTED' },
    });
  });

  it('publishes canonical REPLY_INCIDENT_UPDATED only after correction receipt CAS succeeds', async () => {
    const tx = {
      sendOutbox: { findFirst: jest.fn().mockResolvedValue({ id: 'correction-send', replyJobId: null }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), replyIncident: { findFirst: jest.fn().mockResolvedValue({ id: 'incident-a', replyMessageId: 'reply-a', originalAnswerSnapshot: '旧答案', status: 'CORRECTED' }) } };
    const gateway = { publish: jest.fn() };
    const service = new SendOutboxService(prisma as never, undefined, undefined, new ReplyIncidentPublisher(gateway as never));
    await service.recordReceipt(scope, 'correction-send', { externalMessageId: 'platform-correction-a' });
    expect(gateway.publish).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'REPLY_INCIDENT_UPDATED', payload: { incident: expect.objectContaining({ status: 'CORRECTED', replyId: 'reply-a' }) } }));
  });

  it('claims only a SendGuard-valid PENDING row, and records context mismatch as a non-send failure', async () => {
    const pending = {
      id: 'send-a', status: 'PENDING', conversationId: 'conversation-a', idempotencyKey: 'send:reply-a',
      expectedLastMessageId: 'message-8', expectedSequence: 8, expectedContextVersion: 5,
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      sendOutbox: {
        findFirst: jest.fn().mockResolvedValue(pending),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', state: 'ACTIVE', humanActive: false, lastCommittedSequence: 8, contextVersion: 5 }),
      },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-8' }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new SendOutboxService(prisma as never);

    await expect(service.claim(scope, 'send-a')).resolves.toMatchObject({ claimed: true, sendOutbox: { id: 'send-a' } });
    expect(tx.sendOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'send-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: 'PENDING' },
      data: { status: 'SENDING' },
    });

    tx.conversation.findFirst.mockResolvedValue({ id: 'conversation-a', state: 'ACTIVE', humanActive: false, lastCommittedSequence: 8, contextVersion: 6 });
    await expect(service.claim(scope, 'send-a')).resolves.toMatchObject({ claimed: false, failureCode: 'CONTEXT_STALE' });
    expect(tx.sendOutbox.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'send-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: 'PENDING' },
      data: { status: 'FAILED', failureCode: 'CONTEXT_STALE', failureReason: 'SEND_GUARD_REJECTED' },
    });
  });

  it('requires an AI outbox linked ReplyJob to remain FAST_PATH_READY at both claim and transport fence', async () => {
    const sending = {
      id: 'send-old', status: 'SENDING', replyJobId: 'reply-old', conversationId: 'conversation-a', idempotencyKey: 'send:reply-old',
      expectedLastMessageId: 'message-8', expectedSequence: 8, expectedContextVersion: 5, payloadJson: { text: '旧答案', senderRole: 'AI' },
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      sendOutbox: { findFirst: jest.fn().mockResolvedValueOnce({ ...sending, status: 'PENDING' }).mockResolvedValueOnce(sending), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ state: 'ACTIVE', humanActive: false, lastCommittedSequence: 8, contextVersion: 5 }) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-8' }) },
      replyJob: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new SendOutboxService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(service.claim(scope, 'send-old')).resolves.toMatchObject({ claimed: false, failureCode: 'CONTEXT_STALE' });
    expect(tx.sendOutbox.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'send-old', ...scope, status: 'PENDING' },
      data: { status: 'FAILED', failureCode: 'CONTEXT_STALE', failureReason: 'SEND_GUARD_REJECTED' },
    });
    await expect(service.fenceBeforeTransport(scope, 'send-old')).resolves.toBe(false);
    expect(tx.sendOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'send-old', ...scope, status: 'SENDING' },
      data: { status: 'CANCELLED', failureCode: 'CONTEXT_STALE', failureReason: 'SEND_TRANSPORT_FENCED' },
    });
  });

  it('rejects an already-queued AI send after the live conversation switches to ASSIST, even if its old job was AUTO-ready', async () => {
    const pending = {
      id: 'send-mode', status: 'PENDING', replyJobId: 'reply-mode', conversationId: 'conversation-a', idempotencyKey: 'send:mode',
      payloadJson: { text: '旧自动答案', senderRole: 'AI' }, expectedLastMessageId: 'message-8', expectedSequence: 8, expectedContextVersion: 5,
    };
    const tx = {
      $queryRaw: jest.fn(), sendOutbox: { findFirst: jest.fn().mockResolvedValue(pending), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', state: 'ACTIVE', humanActive: false, overrideMode: 'ASSIST', lastCommittedSequence: 8, contextVersion: 5 }) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-8' }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED' }) },
      replyJob: { findFirst: jest.fn().mockResolvedValue({ id: 'reply-mode' }) },
    };
    const service = new SendOutboxService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(service.claim(scope, 'send-mode')).resolves.toMatchObject({ claimed: false, failureCode: 'CONTEXT_STALE' });
    expect(tx.sendOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'send-mode', ...scope, status: 'PENDING' },
      data: { status: 'FAILED', failureCode: 'CONTEXT_STALE', failureReason: 'SEND_GUARD_REJECTED' },
    });
  });
});
