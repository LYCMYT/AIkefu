import { ProductLearningRequestWorker } from '../src/knowledge/product-learning-request.worker';

describe('ProductLearningRequestWorker', () => {
  it('claims a scoped durable request, starts the idempotent learner, and records dispatch', async () => {
    const row = {
      id: 'outbox-a', eventId: 'learn-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
      payloadJson: { shopId: 'shop-a', productIds: ['product-a'] }, attempts: 0,
    };
    const receiptUpsert = jest.fn().mockResolvedValue({});
    const dispatchedUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      processingOutbox: {
        updateMany: jest.fn()
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([row]),
      },
      $transaction: jest.fn((work: Function) => work({
        processingReceipt: { upsert: receiptUpsert },
        processingOutbox: { updateMany: dispatchedUpdate },
      })),
    };
    const knowledge = { startProductLearning: jest.fn().mockResolvedValue({ id: 'job-a', status: 'SUCCEEDED' }) };
    const worker = new ProductLearningRequestWorker(prisma as never, knowledge as never);

    await expect(worker.dispatchOnce(new Date('2026-08-29T12:00:00.000Z'))).resolves.toEqual({ dispatched: 1, failed: 0 });
    expect(knowledge.startProductLearning).toHaveBeenCalledWith(
      { workspaceId: 'workspace-a', tenantId: 'tenant-a' },
      'shop-a',
      ['product-a'],
    );
    expect(receiptUpsert).toHaveBeenCalledWith({
      where: { eventId: 'learn-a' },
      update: {},
      create: {
        workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', eventId: 'learn-a',
      },
    });
    expect(dispatchedUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'outbox-a', status: 'DISPATCHING' },
      data: expect.objectContaining({ status: 'DISPATCHED' }),
    }));
  });

  it('keeps a reclaimed request durable when another worker still owns a fresh RUNNING job', async () => {
    const firstNow = new Date('2026-08-29T12:00:00.000Z');
    const retryNow = new Date('2026-08-29T12:00:02.000Z');
    const row = {
      id: 'outbox-race', eventId: 'learn-race', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
      payloadJson: { shopId: 'shop-a', productIds: ['product-a'] }, attempts: 1,
    };
    const receiptUpsert = jest.fn().mockResolvedValue({});
    const dispatchedUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      processingOutbox: {
        updateMany,
        // First pass models the second worker reclaiming a stale outbox
        // lease while the original learning lease is still fresh. The
        // original worker then crashes; the next durable pass must retry.
        findMany: jest.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([row]),
      },
      $transaction: jest.fn((work: Function) => work({
        processingReceipt: { upsert: receiptUpsert },
        processingOutbox: { updateMany: dispatchedUpdate },
      })),
    };
    const knowledge = {
      startProductLearning: jest.fn()
        .mockResolvedValueOnce({ id: 'job-a', status: 'RUNNING' })
        .mockResolvedValueOnce({ id: 'job-a', status: 'SUCCEEDED' }),
    };
    const worker = new ProductLearningRequestWorker(prisma as never, knowledge as never);

    await expect(worker.dispatchOnce(firstNow)).resolves.toEqual({ dispatched: 0, failed: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: 'outbox-race', status: 'DISPATCHING' },
      data: { status: 'PENDING', availableAt: new Date('2026-08-29T12:00:01.000Z') },
    });

    await expect(worker.dispatchOnce(retryNow)).resolves.toEqual({ dispatched: 1, failed: 0 });
    expect(knowledge.startProductLearning).toHaveBeenCalledTimes(2);
    expect(receiptUpsert).toHaveBeenCalledWith({
      where: { eventId: 'learn-race' },
      update: {},
      create: {
        workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', eventId: 'learn-race',
      },
    });
  });

  it('reclaims stale leases and schedules a durable retry when learning throws', async () => {
    const now = new Date('2026-08-29T12:00:00.000Z');
    const updateMany = jest.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      processingOutbox: {
        updateMany,
        findMany: jest.fn().mockResolvedValue([{
          id: 'outbox-retry', eventId: 'learn-retry', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
          payloadJson: { shopId: 'shop-a', productIds: ['product-a'] }, attempts: 2,
        }]),
      },
      $transaction: jest.fn(),
    };
    const knowledge = { startProductLearning: jest.fn().mockRejectedValue(new Error('process interrupted')) };
    const worker = new ProductLearningRequestWorker(prisma as never, knowledge as never);

    await expect(worker.dispatchOnce(now)).resolves.toEqual({ dispatched: 0, failed: 0 });
    expect(updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ eventType: 'PRODUCT_LEARNING_REQUESTED', status: 'DISPATCHING' }),
      data: { status: 'PENDING', availableAt: now },
    }));
    expect(updateMany).toHaveBeenNthCalledWith(3, {
      where: { id: 'outbox-retry', status: 'DISPATCHING' },
      data: { status: 'PENDING', availableAt: new Date('2026-08-29T12:00:02.000Z') },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails a malformed cross-shop payload without invoking learning', async () => {
    const prisma = {
      processingOutbox: {
        updateMany: jest.fn().mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{
          id: 'outbox-a', eventId: 'learn-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a',
          payloadJson: { shopId: 'shop-b', productIds: [] }, attempts: 0,
        }]),
      },
    };
    const knowledge = { startProductLearning: jest.fn() };
    const worker = new ProductLearningRequestWorker(prisma as never, knowledge as never);

    await expect(worker.dispatchOnce()).resolves.toEqual({ dispatched: 0, failed: 1 });
    expect(knowledge.startProductLearning).not.toHaveBeenCalled();
  });
});
