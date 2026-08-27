import { ContextInvalidationService } from '../src/replies/context-invalidation.service';

describe('ContextInvalidationService', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

  it('updates a scoped SKU fact, versions bound conversations, and conservatively stales active jobs only in that shop', async () => {
    const tx = {
      productSku: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findMany: jest.fn().mockResolvedValue([{ id: 'conversation-a' }]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyJob: { findMany: jest.fn().mockResolvedValue([{ id: 'reply-generating' }]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      sendOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new ContextInvalidationService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(service.updateSkuInventory(scope, 'product-a', 'sku-a', 0)).resolves.toEqual({ updated: true, invalidatedConversations: 1 });
    expect(tx.productSku.updateMany).toHaveBeenCalledWith({
      where: { id: 'sku-a', productId: 'product-a', ...scope }, data: { inventory: 0 },
    });
    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['conversation-a'] }, ...scope, currentProductId: 'product-a' },
      data: { contextVersion: { increment: 1 }, needsReplan: true },
    });
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: { in: expect.arrayContaining(['GENERATING', 'WAITING_HUMAN']) } }),
      data: { status: 'STALE', staleReason: 'SKU_INVENTORY_CHANGED' },
    }));
    expect(tx.sendOutbox.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ replyJobId: { in: ['reply-generating'] }, status: 'PENDING', payloadJson: { path: ['senderRole'], equals: 'AI' } }),
      data: { status: 'CANCELLED', failureCode: 'REPLY_JOB_STALE', failureReason: 'SKU_INVENTORY_CHANGED' },
    });
  });

  it('never updates or invalidates a same-id fact outside its exact shop scope', async () => {
    const tx = {
      order: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, conversation: { findMany: jest.fn(), updateMany: jest.fn() },
      replyJob: { updateMany: jest.fn() }, replyDraft: { updateMany: jest.fn() }, $queryRaw: jest.fn(),
    };
    const service = new ContextInvalidationService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(service.updateOrderStatus({ ...scope, shopId: 'shop-b' }, 'order-a', 'SHIPPED')).resolves.toEqual({ updated: false, invalidatedConversations: 0 });
    expect(tx.conversation.findMany).not.toHaveBeenCalled();
  });

  it('stales and replans only the affected active conversation; a completed unrelated conversation receives no new reply plan', async () => {
    const tx = {
      productSku: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: {
        findMany: jest.fn()
          .mockResolvedValueOnce([{ id: 'conversation-a' }])
          .mockResolvedValueOnce([{ id: 'conversation-a', contextVersion: 9 }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyJob: { findMany: jest.fn().mockResolvedValue([{ id: 'reply-a', conversationId: 'conversation-a' }]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      sendOutbox: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      userTurn: { findFirst: jest.fn().mockResolvedValue({ id: 'turn-a', lastSequence: 8, sourceMessageIdsJson: ['message-8'] }) },
      processingOutbox: { upsert: jest.fn().mockResolvedValue({ id: 'replan-a' }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new ContextInvalidationService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await service.updateSkuInventory(scope, 'product-a', 'sku-a', 0);

    expect(tx.replyJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ conversationId: { in: ['conversation-a'] } }),
      data: { status: 'STALE', staleReason: 'SKU_INVENTORY_CHANGED' },
    });
    expect(tx.processingOutbox.upsert).toHaveBeenCalledWith({
      where: { eventId: 'reply-replan:turn-a:v9' }, update: {},
      create: expect.objectContaining({
        eventType: 'USER_TURN_READY', aggregateId: 'turn-a',
        payloadJson: { conversationId: 'conversation-a', userTurnId: 'turn-a', sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 9 },
      }),
    });
    expect(tx.replyJob.updateMany.mock.calls.flatMap((call) => JSON.stringify(call)).join(' ')).not.toContain('conversation-b');
    expect(tx.processingOutbox.upsert.mock.calls.flatMap((call) => JSON.stringify(call)).join(' ')).not.toContain('conversation-b');
  });

  it('does not proactively replan a completed conversation when the dynamic fact changes without an active job or actionable AI send', async () => {
    const tx = {
      productSku: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findMany: jest.fn().mockResolvedValue([{ id: 'conversation-completed' }]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyJob: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      replyDraft: { updateMany: jest.fn() }, sendOutbox: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      userTurn: { findFirst: jest.fn() }, processingOutbox: { upsert: jest.fn() }, $queryRaw: jest.fn(),
    };
    const service = new ContextInvalidationService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await service.updateSkuInventory(scope, 'product-a', 'sku-a', 0);

    expect(tx.conversation.updateMany).toHaveBeenCalled(); // fact selection cursor still becomes stale.
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ conversationId: { in: ['conversation-completed'] } }),
    }));
    expect(tx.processingOutbox.upsert).not.toHaveBeenCalled();
    expect(tx.userTurn.findFirst).not.toHaveBeenCalled();
  });
});
