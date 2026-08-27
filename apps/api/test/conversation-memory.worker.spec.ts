import { ConversationMemoryRebuildWorker } from '../src/ai/conversation-memory.worker';
import { CoalescingConversationMemoryRebuildScheduler } from '../src/ai/conversation-memory.scheduler';

const request = {
  workspaceId: 'workspace-1',
  tenantId: 'tenant-1',
  shopId: 'shop-1',
  conversationId: 'conversation-1',
  reason: 'LATE_MESSAGE' as const,
};

describe('ConversationMemoryRebuildWorker', () => {
  it('drains a coalesced request, runs a scoped sanitized summary, and persists it', async () => {
    const scheduler = { drainPending: jest.fn().mockReturnValue([request]), schedule: jest.fn() };
    const prisma = {
      conversationMemory: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation-1',
          shopId: 'shop-1',
          contextVersion: 7,
          memory: { summaryVersion: 3, updatedAt: new Date('2026-08-27T00:00:00.000Z') },
          messages: [
            { id: 'message-1', sequence: 1, kind: 'TEXT', contentJson: { text: '联系电话 13800138000' } },
          ],
        }),
      },
    };
    const summary = {
      narrativeSummary: '用户咨询联系方式。',
      activeTopic: 'FAQ_QUERY',
      activeProductId: null,
      activeOrderId: null,
      resolvedFacts: [],
      openQuestions: [],
      deprecatedFacts: [],
    };
    const runtime = { runStructured: jest.fn().mockResolvedValue({ output: summary }) };
    const memories = { rebuild: jest.fn().mockResolvedValue({ id: 'memory-1', applied: true, retry: false }) };
    const worker = new ConversationMemoryRebuildWorker(
      scheduler as never,
      prisma as never,
      runtime as never,
      memories as never,
    );

    await expect(worker.drainOnce()).resolves.toBe(1);

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'conversation-1', workspaceId: 'workspace-1', tenantId: 'tenant-1', shopId: 'shop-1' },
    }));
    expect(runtime.runStructured).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', tenantId: 'tenant-1', shopId: 'shop-1', conversationId: 'conversation-1' },
      expect.objectContaining({ purpose: 'SUMMARY', schema: 'ConversationSummary', allowedDataClasses: ['messages'] }),
    );
    expect(memories.rebuild).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', tenantId: 'tenant-1' },
      'conversation-1',
      summary,
      {
        contextVersion: 7,
        summaryVersion: 3,
        memoryUpdatedAt: new Date('2026-08-27T00:00:00.000Z'),
      },
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('requeues a request after a transient runtime failure', async () => {
    const scheduler = {
      drainPending: jest.fn().mockReturnValue([request]),
      schedule: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      conversationMemory: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation-1',
          shopId: 'shop-1',
          contextVersion: 7,
          memory: { summaryVersion: 3, updatedAt: new Date('2026-08-27T00:00:00.000Z') },
          messages: [],
        }),
      },
    };
    const runtime = { runStructured: jest.fn().mockRejectedValue(new Error('provider unavailable')) };
    const worker = new ConversationMemoryRebuildWorker(
      scheduler as never,
      prisma as never,
      runtime as never,
      { rebuild: jest.fn() } as never,
    );

    await expect(worker.drainOnce()).resolves.toBe(0);
    expect(scheduler.schedule).toHaveBeenCalledWith(request);
  });

  it('recovers a committed late-message DIRTY summary when the post-commit scheduler was never reached', async () => {
    const scheduler = new CoalescingConversationMemoryRebuildScheduler();
    // Simulate the process stopping immediately after the message transaction
    // commits: its in-memory scheduler has no request at restart time.
    expect(scheduler.drainPending()).toEqual([]);
    const prisma = {
      conversationMemory: {
        findMany: jest.fn().mockResolvedValue([{
          workspaceId: 'workspace-1',
          tenantId: 'tenant-1',
          shopId: 'shop-1',
          conversationId: 'conversation-1',
        }]),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation-1',
          shopId: 'shop-1',
          contextVersion: 7,
          memory: { summaryVersion: 3, updatedAt: new Date('2026-08-27T00:00:00.000Z') },
          messages: [],
        }),
      },
    };
    const runtime = {
      runStructured: jest.fn().mockResolvedValue({
        output: {
          narrativeSummary: '', activeTopic: 'UNKNOWN', activeProductId: null, activeOrderId: null,
          resolvedFacts: [], openQuestions: [], deprecatedFacts: [],
        },
      }),
    };
    const memories = { rebuild: jest.fn().mockResolvedValue({ id: 'memory-1', applied: true, retry: false }) };
    const worker = new ConversationMemoryRebuildWorker(
      scheduler,
      prisma as never,
      runtime as never,
      memories as never,
    );

    await expect(worker.drainOnce()).resolves.toBe(1);
    expect(prisma.conversationMemory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'DIRTY' }),
    }));
    expect(runtime.runStructured).toHaveBeenCalledTimes(1);
    expect(memories.rebuild).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', tenantId: 'tenant-1' },
      'conversation-1',
      expect.any(Object),
      expect.objectContaining({ contextVersion: 7, summaryVersion: 3 }),
    );
  });

  it('coalesces repeated dirty-memory requests for the same conversation', async () => {
    const scheduler = new CoalescingConversationMemoryRebuildScheduler();

    await scheduler.schedule(request);
    await scheduler.schedule({ ...request, reason: 'MESSAGE_MUTATED' });

    expect(scheduler.drainPending()).toEqual([
      expect.objectContaining({
        workspaceId: 'workspace-1',
        tenantId: 'tenant-1',
        shopId: 'shop-1',
        conversationId: 'conversation-1',
      }),
    ]);
  });

  it.each(['edit', 'recall'] as const)('requeues %s invalidation when the context changes while the model is running', async (mutation) => {
    let releaseModel: ((value: { output: Record<string, unknown> }) => void) | undefined;
    let modelStarted: (() => void) | undefined;
    const modelStartedPromise = new Promise<void>((resolve) => { modelStarted = resolve; });
    const snapshot = {
      id: 'conversation-1',
      shopId: 'shop-1',
      contextVersion: 7,
      memory: { summaryVersion: 3, updatedAt: new Date('2026-08-27T00:00:00.000Z') },
      messages: [{ id: 'message-1', sequence: 1, kind: 'TEXT', contentJson: { text: '原始内容' }, status: 'ACTIVE' }],
    };
    const current = { contextVersion: 7 };
    const scheduler = {
      drainPending: jest.fn().mockReturnValue([request]),
      schedule: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      conversationMemory: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: { findFirst: jest.fn().mockResolvedValue(snapshot) },
    };
    const runtime = {
      runStructured: jest.fn(() => new Promise<{ output: Record<string, unknown> }>((resolve) => {
        releaseModel = resolve;
        modelStarted?.();
      })),
    };
    const memories = {
      rebuild: jest.fn(async (_scope, _conversationId, _output, baseline) => ({
        id: 'memory-1',
        applied: baseline.contextVersion === current.contextVersion,
        retry: baseline.contextVersion !== current.contextVersion,
      })),
    };
    const worker = new ConversationMemoryRebuildWorker(
      scheduler as never,
      prisma as never,
      runtime as never,
      memories as never,
    );

    const draining = worker.drainOnce();
    await modelStartedPromise;
    // Mirrors the committed edit/recall transaction: it invalidates the
    // snapshot after the worker has read it but before provider output returns.
    current.contextVersion += 1;
    releaseModel?.({
      output: {
        narrativeSummary: '旧摘要', activeTopic: 'UNKNOWN', activeProductId: null, activeOrderId: null,
        resolvedFacts: [], openQuestions: [], deprecatedFacts: [],
      },
    });

    await expect(draining).resolves.toBe(0);
    expect(memories.rebuild).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1', tenantId: 'tenant-1' },
      'conversation-1',
      expect.any(Object),
      expect.objectContaining({ contextVersion: 7, summaryVersion: 3 }),
    );
    expect(scheduler.schedule).toHaveBeenCalledWith(request);
  });
});
