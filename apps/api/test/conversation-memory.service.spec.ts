import { BadRequestException } from '@nestjs/common';
import { ConversationMemoryService } from '../src/ai/conversation-memory.service';

describe('ConversationMemoryService', () => {
  it('persists a versioned scoped summary and excludes recalled/dynamic facts', async () => {
    const writes: unknown[] = [];
    const prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          workspaceId: 'w1',
          tenantId: 't1',
          shopId: 's1',
          messages: [
            { id: 'm1', sequence: 1, status: 'ACTIVE' },
            { id: 'm2', sequence: 2, status: 'RECALLED' },
          ],
          memory: { summaryVersion: 4 },
        }),
      },
      conversationMemory: {
        upsert: jest.fn(async (args: unknown) => {
          writes.push(args);
          return { id: 'memory-1', updatedAt: new Date('2026-08-27T00:00:00.000Z') };
        }),
      },
    };
    const service = new ConversationMemoryService(prisma as never);
    await service.rebuild(
      { workspaceId: 'w1', tenantId: 't1' },
      'c1',
      {
        narrativeSummary: '用户咨询商品洗护。',
        activeTopic: 'PRODUCT_QUERY',
        activeProductId: 'p1',
        activeOrderId: null,
        resolvedFacts: [
          { key: 'care', value: '不建议烘干', sourceMessageId: 'm1' },
          { key: 'inventory', value: 8, sourceMessageId: 'm1' },
          { key: 'bad', value: true, sourceMessageId: 'm2' },
        ],
        openQuestions: [],
        deprecatedFacts: [],
      },
    );

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1', workspaceId: 'w1', tenantId: 't1' } }),
    );
    expect(JSON.stringify(writes)).toContain('"summaryVersion":5');
    expect(JSON.stringify(writes)).toContain('"care"');
    expect(JSON.stringify(writes)).not.toContain('"inventory"');
    expect(JSON.stringify(writes)).not.toContain('"bad"');
  });

  it('fails closed before persistence when structured output is invalid', async () => {
    const prisma = {
      conversation: { findFirst: jest.fn() },
      conversationMemory: { upsert: jest.fn() },
    };
    const service = new ConversationMemoryService(prisma as never);

    await expect(
      service.rebuild(
        { workspaceId: 'w1', tenantId: 't1' },
        'c1',
        { narrativeSummary: 'missing required fields' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(prisma.conversationMemory.upsert).not.toHaveBeenCalled();
  });

  it('marks a summary DIRTY and schedules a rebuild only for a late summarized sequence', async () => {
    const scheduler = { schedule: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'c1', shopId: 's1' }) },
      conversationMemory: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new ConversationMemoryService(prisma as never, scheduler);

    await expect(service.markDirtyForLateMessage({ workspaceId: 'w1', tenantId: 't1' }, 'c1', 4)).resolves.toBe(true);
    expect(prisma.conversationMemory.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'w1', tenantId: 't1', shopId: 's1', conversationId: 'c1',
        basedOnThroughSequence: { gte: 4 },
      },
      data: { status: 'DIRTY' },
    });
    expect(scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1', reason: 'LATE_MESSAGE' }));
  });

  it('does not schedule when the late message is newer than the summary boundary', async () => {
    const scheduler = { schedule: jest.fn() };
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'c1', shopId: 's1' }) },
      conversationMemory: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const service = new ConversationMemoryService(prisma as never, scheduler);
    await expect(service.markDirtyForLateMessage({ workspaceId: 'w1', tenantId: 't1' }, 'c1', 9)).resolves.toBe(false);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('keeps a concurrently invalidated memory DIRTY when its persisted rebuild CAS is stale', async () => {
    const snapshotAt = new Date('2026-08-27T00:00:00.000Z');
    const invalidatedAt = new Date('2026-08-27T00:00:01.000Z');
    const initial = {
      id: 'c1', workspaceId: 'w1', tenantId: 't1', shopId: 's1', contextVersion: 7,
      messages: [{ id: 'm1', sequence: 1, status: 'ACTIVE' }],
      memory: { id: 'memory-1', summaryVersion: 3, status: 'DIRTY', updatedAt: snapshotAt },
    };
    const invalidated = {
      ...initial,
      contextVersion: 8,
      memory: { ...initial.memory, updatedAt: invalidatedAt },
    };
    const prisma = {
      conversation: {
        findFirst: jest.fn()
          .mockResolvedValueOnce(initial)
          .mockResolvedValueOnce(invalidated),
      },
      conversationMemory: {
        updateManyAndReturn: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn(),
      },
    };
    const service = new ConversationMemoryService(prisma as never);

    await expect(service.rebuild(
      { workspaceId: 'w1', tenantId: 't1' },
      'c1',
      {
        narrativeSummary: '旧上下文摘要。', activeTopic: 'UNKNOWN', activeProductId: null, activeOrderId: null,
        resolvedFacts: [], openQuestions: [], deprecatedFacts: [],
      },
      { contextVersion: 7, summaryVersion: 3, memoryUpdatedAt: snapshotAt },
    )).resolves.toMatchObject({ conversationId: 'c1', applied: false, retry: true });

    expect(prisma.conversationMemory.updateManyAndReturn).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        conversationId: 'c1',
        summaryVersion: 3,
        updatedAt: snapshotAt,
        status: 'DIRTY',
        conversation: { is: { contextVersion: 7 } },
      }),
      data: expect.objectContaining({ status: 'CLEAN' }),
    }));
    expect(prisma.conversationMemory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ shopId: 's1', conversationId: 'c1', conversation: { is: { contextVersion: { not: 7 } } } }),
      data: { status: 'DIRTY' },
    }));
    expect(prisma.conversationMemory.upsert).not.toHaveBeenCalled();
  });
});
