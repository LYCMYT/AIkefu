import { ScheduledConversationMessageService, ScheduledConversationMessageWorker } from '../src/replies/scheduled-conversation-message.service';

describe('Scheduled conversation messages', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

  it('durably plans exactly one welcome per conversation with a SendGuard cursor', async () => {
    const tx = { processingOutbox: { upsert: jest.fn().mockResolvedValue({ id: 'scheduled-a', status: 'PENDING' }) } };
    const service = new ScheduledConversationMessageService({} as never);
    const now = new Date('2026-08-29T00:00:00.000Z');

    await expect(service.planWelcomeInTransaction(tx as never, scope, {
      id: 'conversation-a', contextVersion: 5, lastCommittedSequence: 8, lastMessageId: 'message-8',
    }, '您好，有什么可以帮您？', now)).resolves.toMatchObject({ id: 'scheduled-a' });

    expect(tx.processingOutbox.upsert).toHaveBeenCalledWith({
      where: { eventId: 'scheduled:welcome:conversation-a' }, update: {}, create: expect.objectContaining({
        ...scope, eventId: 'scheduled:welcome:conversation-a', aggregateType: 'CONVERSATION', aggregateId: 'conversation-a',
        eventType: 'SCHEDULED_WELCOME', status: 'PENDING', availableAt: now,
        payloadJson: {
          conversationId: 'conversation-a', text: '您好，有什么可以帮您？', expectedLastMessageId: 'message-8',
          expectedSequence: 8, expectedContextVersion: 5,
        },
      }),
    });
  });

  it('revalidates scheduled closing context before converting it to a SendOutbox', async () => {
    const row = {
      id: 'scheduled-a', eventId: 'scheduled:closing:conversation-a:5', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId,
      eventType: 'SCHEDULED_CLOSING', aggregateId: 'conversation-a', status: 'PENDING',
      payloadJson: { conversationId: 'conversation-a', text: '还有问题随时联系我。', expectedLastMessageId: 'message-8', expectedSequence: 8, expectedContextVersion: 5 },
    };
    const prisma = {
      processingOutbox: { findMany: jest.fn().mockResolvedValue([row]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', state: 'ACTIVE', humanActive: false, contextVersion: 5, lastCommittedSequence: 8 }) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-8' }) },
    };
    const sendOutboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-a', status: 'PENDING' }) };
    const worker = new ScheduledConversationMessageWorker(prisma as never, sendOutboxes as never);

    await expect(worker.dispatchOnce()).resolves.toEqual({ dispatched: 1, cancelled: 0 });
    expect(sendOutboxes.enqueue).toHaveBeenCalledWith(scope, {
      conversationId: 'conversation-a', text: '还有问题随时联系我。', idempotencyKey: 'scheduled-send:scheduled:closing:conversation-a:5',
      expectedLastMessageId: 'message-8', expectedSequence: 8, expectedContextVersion: 5,
    });
    expect(prisma.processingOutbox.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'scheduled-a', status: 'DISPATCHING' }, data: { status: 'DISPATCHED', dispatchedAt: expect.any(Date) },
    });
  });

  it('cancels rather than sends when a new message, context change, or human takeover invalidates the plan', async () => {
    const row = {
      id: 'scheduled-a', eventId: 'scheduled:welcome:conversation-a', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId,
      eventType: 'SCHEDULED_WELCOME', aggregateId: 'conversation-a', status: 'PENDING',
      payloadJson: { conversationId: 'conversation-a', text: '您好', expectedLastMessageId: 'message-8', expectedSequence: 8, expectedContextVersion: 5 },
    };
    const prisma = {
      processingOutbox: { findMany: jest.fn().mockResolvedValue([row]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', state: 'ACTIVE', humanActive: true, contextVersion: 5, lastCommittedSequence: 8 }) },
      message: { findFirst: jest.fn() },
    };
    const sendOutboxes = { enqueue: jest.fn() };
    const worker = new ScheduledConversationMessageWorker(prisma as never, sendOutboxes as never);

    await expect(worker.dispatchOnce()).resolves.toEqual({ dispatched: 0, cancelled: 1 });
    expect(sendOutboxes.enqueue).not.toHaveBeenCalled();
    expect(prisma.processingOutbox.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'scheduled-a', status: 'DISPATCHING' }, data: { status: 'FAILED' },
    });
  });

  it('plans a safe delayed closing from expired idle state using the configured non-marketing closing text', async () => {
    const schedules = { planClosing: jest.fn().mockResolvedValue({ id: 'closing-a' }) };
    const prisma = {
      conversation: { findMany: jest.fn().mockResolvedValue([{
        id: 'conversation-a', ...scope, contextVersion: 5, lastCommittedSequence: 8,
      }]) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-8' }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ closingMessagesJson: { NO_ORDER: '还有问题随时联系我。' } }) },
      processingOutbox: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const worker = new ScheduledConversationMessageWorker(prisma as never, {} as never, schedules as never);
    const now = new Date('2026-08-29T00:30:00.000Z');

    await expect(worker.dispatchOnce(now)).resolves.toEqual({ dispatched: 0, cancelled: 0 });
    expect(schedules.planClosing).toHaveBeenCalledWith(scope, {
      id: 'conversation-a', contextVersion: 5, lastCommittedSequence: 8, lastMessageId: 'message-8',
    }, '还有问题随时联系我。', now);
  });

  it('selects the current order lifecycle closing and cancels it if that order changes before dispatch', async () => {
    const schedules = { planClosing: jest.fn().mockResolvedValue({ id: 'closing-a' }) };
    const prisma = {
      conversation: { findMany: jest.fn().mockResolvedValue([{ id: 'conversation-a', ...scope, contextVersion: 5, lastCommittedSequence: 8, currentOrderId: 'order-a' }]) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-8' }) },
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', status: 'SHIPPED' }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ closingMessagesJson: { NO_ORDER: '无订单', WAITING_SHIPMENT: '待发货', SHIPPED: '已发货', COMPLETED: '已完成' } }) },
      processingOutbox: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const worker = new ScheduledConversationMessageWorker(prisma as never, {} as never, schedules as never);

    await worker.dispatchOnce(new Date());
    expect(schedules.planClosing).toHaveBeenCalledWith(scope, expect.objectContaining({ currentOrderId: 'order-a', currentOrderStatus: 'SHIPPED' }), '已发货', expect.any(Date));
  });

  it('periodically reclaims only stale scheduled DISPATCHING rows for its own consumer', async () => {
    const prisma = { processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) } };
    const worker = new ScheduledConversationMessageWorker(prisma as never, {} as never);

    await worker.dispatchOnce(new Date('2026-08-27T00:00:02.000Z'));

    expect(prisma.processingOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'DISPATCHING', eventType: { in: ['SCHEDULED_WELCOME', 'SCHEDULED_CLOSING'] }, updatedAt: { lt: expect.any(Date) },
      }),
      data: { status: 'PENDING', availableAt: expect.any(Date) },
    }));
  });
});
