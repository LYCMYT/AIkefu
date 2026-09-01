import { MockDouyinSendWorker } from '../src/replies/mock-douyin-send.worker';

describe('MockDouyinSendWorker', () => {
  it('does not starve a missing receipt projection behind 100 older projected SENT rows', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };
    const projectedAt = new Date('2026-08-29T00:00:00.000Z');
    const oldRows = Array.from({ length: 100 }, (_, index) => ({
      id: `send-old-${index}`, status: 'SENT', projectedAt, ...scope,
      conversationId: 'conversation-a', payloadJson: { text: `old-${index}` },
      receiptJson: { externalMessageId: `platform-old-${index}`, sentAt: projectedAt.toISOString() },
      updatedAt: new Date(index),
    }));
    const missing = {
      id: 'send-missing', status: 'SENT', projectedAt: null, ...scope,
      conversationId: 'conversation-a', replyJobId: 'job-a', payloadJson: { text: 'new missing projection' },
      receiptJson: { externalMessageId: 'platform-missing', sentAt: projectedAt.toISOString() },
      updatedAt: new Date('2026-08-30T00:00:00.000Z'),
    };
    const rows = [...oldRows, missing];
    const tx = {
      $executeRaw: jest.fn(),
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ buyerId: 'buyer-a', lastCommittedSequence: 8 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      message: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      sendOutbox: {
        findFirst: jest.fn().mockResolvedValue({ id: 'send-missing' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      sendOutbox: {
        findMany: jest.fn(async ({ where, take }: { where: { status: string; projectedAt?: null }; take: number }) => rows
          .filter((row) => row.status === where.status && (where.projectedAt !== null || row.projectedAt === null))
          .slice(0, take)),
      },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-projected' }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ buyerId: 'buyer-a' }) },
      $transaction: jest.fn(async (work: Function) => work(tx)),
    };
    const traces = { record: jest.fn().mockResolvedValue(undefined) };
    const worker = new MockDouyinSendWorker(prisma as never, {} as never, {} as never, undefined, traces as never);

    await expect(worker.recoverReceiptProjections()).resolves.toBe(1);
    expect(tx.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ externalMessageId: 'platform-missing', contentJson: { text: 'new missing projection' } }),
    }));
    expect(tx.sendOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'send-missing', ...scope, status: 'SENT', projectedAt: null },
      data: { projectedAt: expect.any(Date), projectionFailureCode: null },
    });
    expect(traces.record).toHaveBeenCalledWith(
      { ...scope, conversationId: 'conversation-a', replyJobId: 'job-a' },
      'reply:message-projected',
      'SEND_RECEIPT',
      { sendOutboxId: 'send-missing', senderRole: 'AI', status: 'SENT' },
    );
  });

  it('claims with SendGuard before the synthetic transport and stores a receipt only after acknowledgement', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };
    const outbox = {
      id: 'send-a', status: 'PENDING', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId,
      conversationId: 'conversation-a', payloadJson: { text: '现货商品通常 48 小时内发货。' },
    };
    const prisma = {
      sendOutbox: { findMany: jest.fn().mockResolvedValue([outbox]) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', externalConversationId: 'mock-conversation-a', buyer: { externalBuyerId: 'mock-buyer-a' } }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [] }) },
    };
    const fencedConversation = { id: 'conversation-a', buyerId: 'buyer-a', externalConversationId: 'mock-conversation-a', buyer: { externalBuyerId: 'mock-buyer-a' } };
    const outboxes = {
      claim: jest.fn().mockResolvedValue({ claimed: true, sendOutbox: outbox }),
      deliverWithConversationFence: jest.fn(async (_scope, _id, _blocked, transport) => ({
        delivered: true, conversationId: 'conversation-a', buyerId: 'buyer-a', text: '现货商品通常 48 小时内发货。', senderRole: 'AI',
        receipt: await transport({ outbox, conversation: fencedConversation, text: '现货商品通常 48 小时内发货。', senderRole: 'AI' }),
      })),
    };
    const adapter = {
      sendMessage: jest.fn().mockResolvedValue({ payload: { message: { externalMessageId: 'mock-message-a', sentAt: '2026-08-29T00:00:00.000Z' } } }),
    };
    const gateway = { publish: jest.fn() };
    const worker = new MockDouyinSendWorker(prisma as never, outboxes as never, adapter as never, gateway as never);

    await expect(worker.dispatchOnce()).resolves.toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(outboxes.claim).toHaveBeenCalledWith(scope, 'send-a', false);
    expect(adapter.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      ...scope, externalBuyerId: 'mock-buyer-a', externalConversationId: 'mock-conversation-a', text: '现货商品通常 48 小时内发货。',
      externalMessageId: 'send-a',
    }));
    expect(outboxes.deliverWithConversationFence).toHaveBeenCalledWith(scope, 'send-a', false, expect.any(Function));
  });

  it('does not invoke the platform when SendGuard rejects a stale or human-taken-over row', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };
    const outbox = { id: 'send-a', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: 'conversation-a', payloadJson: { text: 'x' } };
    const prisma = {
      sendOutbox: { findMany: jest.fn().mockResolvedValue([outbox]) }, conversation: { findFirst: jest.fn() },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [] }) },
    };
    const outboxes = { claim: jest.fn().mockResolvedValue({ claimed: false, failureCode: 'HUMAN_ACTIVE' }), recordReceipt: jest.fn() };
    const adapter = { sendMessage: jest.fn() };
    const updates = { publish: jest.fn().mockResolvedValue(undefined) };
    const worker = new MockDouyinSendWorker(prisma as never, outboxes as never, adapter as never, updates as never);

    await expect(worker.dispatchOnce()).resolves.toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(outboxes.recordReceipt).not.toHaveBeenCalled();
  });

  it('keeps the adapter behind the locked conversation fence when takeover wins after claim', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };
    const outbox = { id: 'send-a', ...scope, conversationId: 'conversation-a', payloadJson: { text: 'AI reply' } };
    let release!: (value: { delivered: false; uncertain: false }) => void;
    const fence = new Promise<{ delivered: false; uncertain: false }>((resolve) => { release = resolve; });
    const prisma = {
      sendOutbox: { findMany: jest.fn().mockResolvedValue([outbox]) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [] }) }, conversation: { findFirst: jest.fn() },
    };
    const outboxes = { claim: jest.fn().mockResolvedValue({ claimed: true, sendOutbox: outbox }), deliverWithConversationFence: jest.fn().mockReturnValue(fence), markUncertain: jest.fn() };
    const adapter = { sendMessage: jest.fn() };
    const worker = new MockDouyinSendWorker(prisma as never, outboxes as never, adapter as never);

    const dispatch = worker.dispatchOnce();
    await Promise.resolve(); // initial PENDING -> SENDING claim happened; takeover wins the conversation lock.
    release({ delivered: false, uncertain: false });
    await expect(dispatch).resolves.toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('passes configured forbidden-term blocks into SendGuard and repairs a receipt whose visible Message projection was interrupted', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };
    const pending = { id: 'send-forbidden', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, conversationId: 'conversation-a', payloadJson: { text: '我给您赔偿。' } };
    const sent = { ...pending, id: 'send-sent', status: 'SENT', receiptJson: { externalMessageId: 'platform-sent-a', sentAt: '2026-08-29T00:00:00.000Z' } };
    const prisma = {
      sendOutbox: { findMany: jest.fn().mockResolvedValueOnce([pending]).mockResolvedValueOnce([sent]) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [{ term: '赔偿', replacement: '' }] }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', externalConversationId: 'mock-conversation-a', buyerId: 'buyer-a', buyer: { externalBuyerId: 'mock-buyer-a' } }) },
      message: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      $transaction: jest.fn(async (work: Function) => work({
        $executeRaw: jest.fn(),
        conversation: { findFirst: jest.fn().mockResolvedValue({ buyerId: 'buyer-a', lastCommittedSequence: 8 }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        message: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
        sendOutbox: { findFirst: jest.fn().mockResolvedValue({ id: 'send-sent' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      })),
    };
    const outboxes = { claim: jest.fn().mockResolvedValue({ claimed: false, failureCode: 'FORBIDDEN_TERM' }), recordReceipt: jest.fn(), markUncertain: jest.fn() };
    const adapter = { sendMessage: jest.fn() };
    const gateway = { publish: jest.fn() };
    const worker = new MockDouyinSendWorker(prisma as never, outboxes as never, adapter as never, gateway as never);

    await worker.dispatchOnce();
    expect(outboxes.claim).toHaveBeenCalledWith(scope, 'send-forbidden', true);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    await expect(worker.recoverReceiptProjections()).resolves.toBe(1);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(gateway.publish).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'CONVERSATION_UPDATED', workspaceId: 'workspace-a', entityId: 'conversation-a', payload: { conversationId: 'conversation-a', refresh: true },
    }));
  });

  it('repairs the same SENT receipt only once, so restart scans cannot consume sequences', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };
    const sent = {
      id: 'send-sent', status: 'SENT', ...scope, conversationId: 'conversation-a',
      payloadJson: { text: '已确认发货。' }, receiptJson: { externalMessageId: 'platform-sent-a', sentAt: '2026-08-29T00:00:00.000Z' },
    };
    let projected = false;
    let projectionPending = true;
    const tx = {
      $executeRaw: jest.fn(),
      conversation: { findFirst: jest.fn().mockResolvedValue({ buyerId: 'buyer-a', lastCommittedSequence: 8 }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      message: {
        findFirst: jest.fn(async () => projected ? { id: 'message-projected' } : null),
        create: jest.fn(async () => { projected = true; }),
      },
      sendOutbox: {
        findFirst: jest.fn(async () => projectionPending ? { id: 'send-sent' } : null),
        updateMany: jest.fn(async () => { projectionPending = false; return { count: 1 }; }),
      },
    };
    const prisma = {
      sendOutbox: { findMany: jest.fn().mockResolvedValue([sent]) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ buyerId: 'buyer-a' }) },
      $transaction: jest.fn(async (work: Function) => work(tx)),
    };
    const worker = new MockDouyinSendWorker(prisma as never, {} as never, {} as never);

    await expect(worker.recoverReceiptProjections()).resolves.toBe(1);
    await expect(worker.recoverReceiptProjections()).resolves.toBe(0);
    expect(tx.message.create).toHaveBeenCalledTimes(1);
    expect(tx.conversation.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('does not advance a conversation when a receipt was already projected by another recovery worker', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };
    const sent = {
      id: 'send-sent', status: 'SENT', ...scope, conversationId: 'conversation-a',
      payloadJson: { text: '已确认发货。' }, receiptJson: { externalMessageId: 'platform-sent-a', sentAt: '2026-08-29T00:00:00.000Z' },
    };
    const tx = {
      $executeRaw: jest.fn(),
      conversation: { findFirst: jest.fn(), updateMany: jest.fn() },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-projected' }), create: jest.fn() },
      sendOutbox: { findFirst: jest.fn().mockResolvedValue({ id: 'send-sent' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      sendOutbox: { findMany: jest.fn().mockResolvedValue([sent]) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ buyerId: 'buyer-a' }) },
      $transaction: jest.fn(async (work: Function) => work(tx)),
    };
    const worker = new MockDouyinSendWorker(prisma as never, {} as never, {} as never);

    await expect(worker.recoverReceiptProjections()).resolves.toBe(0);
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.conversation.findFirst).not.toHaveBeenCalled();
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
  });

  it('projects transport AI/HUMAN sender roles onto Prisma ASSISTANT/HUMAN Message enums', async () => {
    const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };
    const projectedRoles: string[] = [];
    const tx = {
      $executeRaw: jest.fn(),
      conversation: { findFirst: jest.fn().mockResolvedValue({ buyerId: 'buyer-a', lastCommittedSequence: 8 }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      message: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: { data: { role: string } }) => { projectedRoles.push(data.role); }),
      },
      sendOutbox: { findFirst: jest.fn().mockResolvedValue({ id: 'send' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const rows = ['AI', 'HUMAN'].map((senderRole, index) => ({
      id: `send-${senderRole}`, status: 'SENT', ...scope, conversationId: `conversation-${index}`,
      payloadJson: { text: '已确认。', senderRole }, receiptJson: { externalMessageId: `platform-${senderRole}`, sentAt: '2026-08-29T00:00:00.000Z' },
    }));
    const prisma = {
      sendOutbox: { findMany: jest.fn().mockResolvedValue(rows) },
      conversation: { findFirst: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => ({ buyerId: `buyer-${where.id}` })) },
      $transaction: jest.fn(async (work: Function) => work(tx)),
    };
    const worker = new MockDouyinSendWorker(prisma as never, {} as never, {} as never);

    await expect(worker.recoverReceiptProjections()).resolves.toBe(2);
    expect(projectedRoles).toEqual(['ASSISTANT', 'HUMAN']);
  });
});
