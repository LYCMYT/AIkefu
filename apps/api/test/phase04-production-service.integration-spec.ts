import { PrismaMessageApplication } from '../src/messages/prisma-message.application';
import { MockDouyinSendWorker } from '../src/replies/mock-douyin-send.worker';
import { ConversationReplyControlService } from '../src/replies/conversation-reply-control.service';
import { ReplyJobService } from '../src/replies/reply-job.service';
import { ReplyRecoveryService } from '../src/replies/reply-recovery.service';
import { ReplyRuntimeService } from '../src/replies/reply-runtime.service';
import { SendOutboxService } from '../src/replies/send-outbox.service';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

/**
 * Deterministic production-service integration boundary.  This deliberately
 * keeps the persistence/model/platform ports in memory, but it does not stub
 * the MessageApplication, ReplyJob, ReplyRuntime, SendOutbox, or Recovery
 * implementations under test.  PostgreSQL-specific locking/index coverage
 * lives separately in phase04.real-infra.integration-spec.ts.
 */
describe('Phase 04 production-service integration', () => {
  it('Case 04: actual turn flushing turns three BUYER messages into one durable UserTurn and plan, excluding an interleaved welcome', async () => {
    const created: { turn?: Record<string, unknown>; outbox?: Record<string, unknown> } = {};
    const now = new Date('2026-09-01T00:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const buffer = { ...scope, conversationId: 'conversation-a', status: 'BUFFERING', generation: 1, firstSequence: 1, latestSequence: 4, openedAt: new Date(0), lastMessageAt: new Date(0), idleDeadline: new Date(0), hardDeadline: new Date(0) };
    const conversation = { id: 'conversation-a', ...scope, buyerId: 'buyer-a', contextVersion: 4 };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      conversationTurnBuffer: { findUnique: jest.fn().mockResolvedValue(buffer), update: jest.fn().mockResolvedValue(buffer) },
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation) },
      message: {
        findMany: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
          expect(where.role).toBe('BUYER');
          return [
            { id: 'buyer-1', sequence: 1, kind: 'TEXT', contentJson: { text: '黑色' } },
            { id: 'buyer-2', sequence: 3, kind: 'TEXT', contentJson: { text: 'XL' } },
            { id: 'buyer-3', sequence: 4, kind: 'TEXT', contentJson: { text: '还有吗' } },
          ];
        }),
      },
      userTurn: { upsert: jest.fn().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => {
        created.turn = create;
        return { id: 'turn-a', ...create, status: 'OPEN', createdAt: now, updatedAt: now };
      }) },
      processingOutbox: { upsert: jest.fn().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => { created.outbox = create; return create; }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const app = new PrismaMessageApplication(prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never);
    try {
      await (app as unknown as { flushTurn(conversationId: string, generation: number): Promise<void> }).flushTurn(conversation.id, 1);
    } finally {
      jest.useRealTimers();
    }
    expect(created.turn).toMatchObject({ sourceMessageIdsJson: ['buyer-1', 'buyer-2', 'buyer-3'], normalizedText: '黑色\nXL\n还有吗' });
    expect(created.outbox).toMatchObject({ eventType: 'USER_TURN_READY', payloadJson: expect.objectContaining({ sourceLastMessageId: 'buyer-3', sourceSequence: 4, sourceContextVersion: 4 }) });
  });

  it('Case 04: consumes one durable USER_TURN_READY into exactly one scoped ReplyJob', async () => {
    const event = {
      eventId: 'user-turn-ready-a', eventType: 'USER_TURN_READY', ...scope,
      payloadJson: { conversationId: 'conversation-a', userTurnId: 'turn-a', sourceLastMessageId: 'message-a', sourceSequence: 3, sourceContextVersion: 4 },
    };
    const state = { receipt: false, jobs: [] as Array<Record<string, unknown>> };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      processingReceipt: {
        findUnique: jest.fn().mockImplementation(async () => state.receipt ? { eventId: event.eventId } : null),
        create: jest.fn().mockImplementation(async () => { state.receipt = true; return { eventId: event.eventId }; }),
      },
      processingOutbox: { findUnique: jest.fn().mockResolvedValue(event) },
      shop: {
        findFirst: jest.fn().mockResolvedValue({
          aiMode: 'AUTO_ALLOWED',
          seedKey: 'shop_mia_fashion',
          productLearningJobs: [{ status: 'SUCCEEDED' }],
        }),
      },
      conversation: {
        findFirst: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
          where.id === 'conversation-a' && where.shopId === scope.shopId ? { id: 'conversation-a', contextVersion: 4, lastCommittedSequence: 3 } : null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-a', sequence: 3 }) },
      userTurn: { findFirst: jest.fn().mockResolvedValue({ id: 'turn-a' }) },
      replyJob: {
        findFirst: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
          state.jobs.find((job) => job.idempotencyKey === where.idempotencyKey) ?? null),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          const job = { id: 'reply-a', status: 'PENDING', ...data };
          state.jobs.push(job);
          return job;
        }),
      },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      replyEvidence: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const application = new PrismaMessageApplication(prisma as never, {} as never, {} as never, {} as never, {} as never, new ReplyJobService(prisma as never));

    await (application as unknown as { consumeOutbox(id: string): Promise<void> }).consumeOutbox(event.eventId);
    await (application as unknown as { consumeOutbox(id: string): Promise<void> }).consumeOutbox(event.eventId);

    expect(state.jobs).toEqual([expect.objectContaining({ conversationId: 'conversation-a', userTurnId: 'turn-a', idempotencyKey: event.eventId, sourceContextVersion: 4 })]);
    expect(state.receipt).toBe(true);
  });

  it('records an OFF turn without AI work and creates AUTO work only for a future turn after it is enabled', async () => {
    const events = new Map([
      ['turn-off', {
        eventId: 'turn-off', eventType: 'USER_TURN_READY', ...scope,
        payloadJson: { conversationId: 'conversation-a', userTurnId: 'user-turn-off', sourceLastMessageId: 'message-off', sourceSequence: 1, sourceContextVersion: 1 },
      }],
      ['turn-on', {
        eventId: 'turn-on', eventType: 'USER_TURN_READY', ...scope,
        payloadJson: { conversationId: 'conversation-a', userTurnId: 'user-turn-on', sourceLastMessageId: 'message-on', sourceSequence: 2, sourceContextVersion: 2 },
      }],
    ]);
    const receipts = new Set<string>();
    const jobs: Array<Record<string, unknown>> = [];
    let activeEvent = events.get('turn-off')!;
    let shopMode: 'MANUAL_ONLY' | 'AUTO_ALLOWED' = 'MANUAL_ONLY';
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      processingReceipt: {
        findUnique: jest.fn(async ({ where }: { where: { eventId: string } }) => receipts.has(where.eventId) ? { eventId: where.eventId } : null),
        create: jest.fn(async ({ data }: { data: { eventId: string } }) => { receipts.add(data.eventId); return data; }),
      },
      processingOutbox: {
        findUnique: jest.fn(async ({ where }: { where: { eventId: string } }) => {
          activeEvent = events.get(where.eventId)!;
          return activeEvent;
        }),
      },
      conversation: {
        findFirst: jest.fn(async () => ({
          id: 'conversation-a',
          lastCommittedSequence: activeEvent.payloadJson.sourceSequence,
          contextVersion: activeEvent.payloadJson.sourceContextVersion,
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      message: { findFirst: jest.fn(async () => ({ id: activeEvent.payloadJson.sourceLastMessageId, sequence: activeEvent.payloadJson.sourceSequence })) },
      userTurn: { findFirst: jest.fn(async () => ({ id: activeEvent.payloadJson.userTurnId })) },
      shop: { findFirst: jest.fn(async () => ({ aiMode: shopMode })) },
      replyJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const job = { id: `job-${jobs.length + 1}`, status: 'PENDING', ...data };
          jobs.push(job);
          return job;
        }),
      },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      replyEvidence: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const application = new PrismaMessageApplication(
      prisma as never, {} as never, {} as never, {} as never, {} as never, new ReplyJobService(prisma as never),
    );

    await (application as unknown as { consumeOutbox(id: string): Promise<void> }).consumeOutbox('turn-off');
    shopMode = 'AUTO_ALLOWED';
    await (application as unknown as { consumeOutbox(id: string): Promise<void> }).consumeOutbox('turn-on');

    expect(jobs).toEqual([
      expect.objectContaining({ idempotencyKey: 'turn-on', mode: 'AUTO', userTurnId: 'user-turn-on' }),
    ]);
    expect(receipts).toEqual(new Set(['turn-off', 'turn-on']));
  });

  it('Case 05: a post-flush newer USER_TURN_READY stales the old generating job and creates exactly one fresh job without touching transport', async () => {
    let event: Record<string, unknown> | undefined;
    const state = {
      receipt: false, oldStatus: 'GENERATING', fresh: [] as Array<Record<string, unknown>>,
      oldOutbox: { id: 'send-old', ...scope, conversationId: 'conversation-a', replyJobId: 'reply-old', status: 'PENDING', payloadJson: { text: '旧答案', senderRole: 'AI' } },
    };
    const conversation = { id: 'conversation-a', ...scope, buyerId: 'buyer-a', contextVersion: 5, lastCommittedSequence: 4 };
    const buffer = { ...scope, conversationId: conversation.id, status: 'BUFFERING', generation: 2, firstSequence: 3, latestSequence: 4, openedAt: new Date(0), lastMessageAt: new Date(0), idleDeadline: new Date(0), hardDeadline: new Date(0) };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      processingReceipt: { findUnique: jest.fn().mockImplementation(async () => state.receipt && event ? { eventId: event.eventId } : null), create: jest.fn().mockImplementation(async () => { state.receipt = true; return {}; }) },
      processingOutbox: {
        findUnique: jest.fn().mockImplementation(async () => event),
        upsert: jest.fn().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => { event = create; return create; }),
      },
      shop: {
        findFirst: jest.fn().mockResolvedValue({
          aiMode: 'AUTO_ALLOWED',
          seedKey: 'shop_mia_fashion',
          productLearningJobs: [{ status: 'SUCCEEDED' }],
        }),
      },
      conversationTurnBuffer: { findUnique: jest.fn().mockResolvedValue(buffer), update: jest.fn().mockResolvedValue(buffer) },
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), findFirst: jest.fn().mockResolvedValue(conversation), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      message: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'message-question', sequence: 3, kind: 'TEXT', contentJson: { text: '什么时候发货？' } },
          { id: 'message-new', sequence: 4, kind: 'TEXT', contentJson: { text: '我是新疆的' } },
        ]),
        findFirst: jest.fn().mockResolvedValue({ id: 'message-new', sequence: 4 }),
      },
      userTurn: {
        findFirst: jest.fn().mockResolvedValue({ id: 'turn-new' }),
        upsert: jest.fn().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({ id: 'turn-new', ...create, status: 'OPEN', createdAt: new Date(), updatedAt: new Date() })),
      },
      replyJob: {
        findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([{ id: 'reply-old' }]),
        updateMany: jest.fn().mockImplementation(async ({ data }: { data: { status?: string } }) => { if (data.status) state.oldStatus = data.status; return { count: 1 }; }),
        create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { const fresh = { id: 'reply-new', ...data }; state.fresh.push(fresh); return fresh; }),
      },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, replyEvidence: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      sendOutbox: { updateMany: jest.fn().mockImplementation(async ({ where, data }: { where: { status?: string }; data: { status?: string } }) => {
        if (where.status !== state.oldOutbox.status) return { count: 0 };
        if (data.status) state.oldOutbox.status = data.status;
        return { count: 1 };
      }) },
    };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
      sendOutbox: {
        updateMany: tx.sendOutbox.updateMany,
        findMany: jest.fn().mockImplementation(async ({ where }: { where: { status?: string } }) => where.status === 'PENDING' && state.oldOutbox.status === 'PENDING' ? [state.oldOutbox] : []),
      },
      shopSettings: { findFirst: jest.fn() },
    };
    const adapter = { sendMessage: jest.fn() };
    const application = new PrismaMessageApplication(prisma as never, { publish: jest.fn() } as never, adapter as never, {} as never, {} as never, new ReplyJobService(prisma as never));

    await (application as unknown as { flushTurn(id: string, generation: number): Promise<void> }).flushTurn(conversation.id, 2);
    expect(event).toMatchObject({ eventId: 'reply-plan:turn-new', eventType: 'USER_TURN_READY', payloadJson: expect.objectContaining({ userTurnId: 'turn-new', sourceLastMessageId: 'message-new', sourceContextVersion: 5 }) });
    await (application as unknown as { consumeOutbox(id: string): Promise<void> }).consumeOutbox('reply-plan:turn-new');
    await (application as unknown as { consumeOutbox(id: string): Promise<void> }).consumeOutbox('reply-plan:turn-new');
    expect(state).toMatchObject({ receipt: true, oldStatus: 'STALE', oldOutbox: { status: 'CANCELLED' } });
    expect(state.fresh).toEqual([expect.objectContaining({ userTurnId: 'turn-new', sourceLastMessageId: 'message-new', sourceContextVersion: 5 })]);
    const oldWorker = new MockDouyinSendWorker(prisma as never, new SendOutboxService(prisma as never), adapter as never);
    await expect(oldWorker.dispatchOnce()).resolves.toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(adapter.sendMessage).not.toHaveBeenCalled();

    const runtimeJob = {
      id: 'reply-new', ...scope, status: 'PENDING', mode: 'AUTO', conversationId: conversation.id, userTurnId: 'turn-new', sourceLastMessageId: 'message-new', sourceSequence: 4, sourceContextVersion: 5, evidences: [],
      conversation: { ...conversation, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null, clarificationRoundsJson: {} },
      userTurn: { id: 'turn-new', normalizedText: '什么时候发货？\n我是新疆的', sourceMessageIdsJson: ['message-question', 'message-new'] },
    };
    const runtimeTx = {
      $queryRaw: jest.fn(),
      conversation: { findFirst: jest.fn().mockResolvedValue({ contextVersion: 5, humanActive: false, state: 'ACTIVE' }) },
      shop: {
        findFirst: jest.fn().mockResolvedValue({
          aiMode: 'AUTO_ALLOWED',
          seedKey: 'shop_mia_fashion',
          productLearningJobs: [{ status: 'SUCCEEDED' }],
        }),
      },
      replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const runtimePrisma = {
      $transaction: jest.fn((work: (client: typeof runtimeTx) => unknown) => work(runtimeTx)),
      replyJob: { findFirst: jest.fn().mockResolvedValue(runtimeJob), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, replyEvidence: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) }, shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const knowledge = { search: jest.fn().mockResolvedValue({ status: 'EVIDENCE', conflictItemIds: [], evidence: [{ itemId: 'knowledge-remote', versionId: 'version-remote', version: 1, source: 'MANUAL', scope: 'STORE', productId: null, contentSnapshot: { question: '偏远地区发货', answer: '偏远地区通常 72 小时内发货。' }, retrievalScore: 0.99 }] }) };
    const newSends = { enqueueInTransaction: jest.fn().mockResolvedValue({ id: 'send-fresh' }) };
    const runtime = new ReplyRuntimeService(runtimePrisma as never, knowledge as never, { runStructured: jest.fn().mockResolvedValueOnce({ output: { tasks: [{ intent: 'SHIPPING_POLICY', riskLevel: 'LOW', requiredContext: [], requiredTools: [] }] } }).mockResolvedValueOnce({ output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' } }) } as never, {} as never, newSends as never);
    await expect(runtime.process(scope, 'reply-new')).resolves.toEqual({ status: 'READY_TO_SEND' });
    expect(knowledge.search).toHaveBeenCalledWith(scope, expect.objectContaining({ query: '什么时候发货？\n我是新疆的' }));
    expect(newSends.enqueueInTransaction).toHaveBeenCalledWith(runtimeTx, scope, expect.objectContaining({ text: '偏远地区通常 72 小时内发货。', replyJobId: 'reply-new' }));
  });

  it('Case 05: ReplyRuntime fences an already-stale job before any model invocation', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'reply-a', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a', sourceContextVersion: 4,
          sourceSequence: 3, evidences: [], conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE' }, userTurn: { normalizedText: '库存还有吗' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const model = { runStructured: jest.fn() };
    const runtime = new ReplyRuntimeService(prisma as never, {} as never, model as never, {} as never, {} as never);

    await expect(runtime.process(scope, 'reply-a')).resolves.toMatchObject({ status: 'STALE', reason: 'CONTEXT_STALE' });
    expect(model.runStructured).not.toHaveBeenCalled();
  });

  it('Cases 06/07: concurrent buyer jobs retrieve and persist evidence only in their own conversation and shop scope', async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const prisma = { replyEvidence: { createMany: jest.fn().mockImplementation(async ({ data }: { data: Array<Record<string, unknown>> }) => { persisted.push(...data); return { count: data.length }; }) } };
    const knowledge = {
      search: jest.fn().mockImplementation(async (inputScope: typeof scope) => ({
        status: 'EVIDENCE', conflictItemIds: [], evidence: [{
          itemId: `item-${inputScope.shopId}`, versionId: `version-${inputScope.shopId}`, version: 1, source: 'MANUAL', scope: 'STORE', productId: null,
          contentSnapshot: { question: '同一个问题', answer: `answer-${inputScope.shopId}` }, retrievalScore: 0.99,
        }],
      })),
    };
    const runtime = new ReplyRuntimeService(prisma as never, knowledge as never, {} as never, {} as never, {} as never);
    const shopB = { ...scope, shopId: 'shop-b' };
    const retrieve = runtime as unknown as { retrieveAndFreezeTaskEvidence(
      s: typeof scope,
      job: { id: string; userTurn: { normalizedText: string }; evidences: [] },
      tasks: Array<{ id: string; intent: string; requiredKnowledge: Array<'STORE'> }>,
      contexts: Map<string, never>,
    ): Promise<unknown> };
    await Promise.all([
      retrieve.retrieveAndFreezeTaskEvidence(scope, { id: 'reply-buyer-a', userTurn: { normalizedText: '同一个问题' }, evidences: [] }, [{ id: 'task-a', intent: 'FAQ_QUERY', requiredKnowledge: ['STORE'] }], new Map<string, never>()),
      retrieve.retrieveAndFreezeTaskEvidence(shopB, { id: 'reply-buyer-b', userTurn: { normalizedText: '同一个问题' }, evidences: [] }, [{ id: 'task-b', intent: 'FAQ_QUERY', requiredKnowledge: ['STORE'] }], new Map<string, never>()),
    ]);
    expect(knowledge.search).toHaveBeenCalledWith(scope, { shopId: scope.shopId, query: '同一个问题', scope: 'STORE', topK: 3 });
    expect(knowledge.search).toHaveBeenCalledWith(shopB, { shopId: shopB.shopId, query: '同一个问题', scope: 'STORE', topK: 3 });
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ replyJobId: 'reply-buyer-a', shopId: 'shop-a', knowledgeItemId: 'item-shop-a' }),
      expect.objectContaining({ replyJobId: 'reply-buyer-b', shopId: 'shop-b', knowledgeItemId: 'item-shop-b' }),
    ]));
  });

  it('Case 08: ReplyRuntime persists two durable order choices and enqueues a deterministic buyer-visible clarification', async () => {
    const job = {
      id: 'reply-order', ...scope, status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-order',
      sourceContextVersion: 4, sourceSequence: 3, sourceLastMessageId: 'message-a', evidences: [],
      conversation: { id: 'conversation-a', buyerId: 'buyer-a', contextVersion: 4, humanActive: false, state: 'ACTIVE', clarificationRoundsJson: {} },
      userTurn: { id: 'turn-order', normalizedText: '我的订单什么时候到', sourceMessageIdsJson: [] },
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyJob: {
        findFirst: jest.fn().mockResolvedValue(job),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      sendOutbox: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'clarification-send', ...data })),
      },
      shop: { findFirst: jest.fn().mockResolvedValue({
        aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }],
      }) },
      task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
      replyJob: tx.replyJob,
      conversation: tx.conversation,
      replyEvidence: { createMany: jest.fn() },
      message: { findMany: jest.fn().mockResolvedValue([]) },
      order: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'order-a', externalOrderId: 'A100', status: 'SHIPPED', logisticsSnapshotJson: {}, version: 1 },
          { id: 'order-b', externalOrderId: 'B200', status: 'PROCESSING', logisticsSnapshotJson: {}, version: 1 },
        ]),
      },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
    };
    const runtimePort = {
      runStructured: jest.fn()
        .mockResolvedValueOnce({ output: { tasks: [{ intent: 'ORDER_LOGISTICS', riskLevel: 'LOW', requiredContext: ['ORDER'], requiredTools: [] }] } })
        .mockResolvedValueOnce({ output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' } }),
    };
    const runtime = new ReplyRuntimeService(
      prisma as never,
      { search: jest.fn().mockResolvedValue({ status: 'NOT_FOUND', evidence: [], conflictItemIds: [] }) } as never,
      runtimePort as never,
      {} as never,
      new SendOutboxService(prisma as never),
    );

    await expect(runtime.process(scope, job.id)).resolves.toEqual({ status: 'READY_TO_SEND' });
    expect(tx.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ clarificationRoundsJson: expect.objectContaining({ ORDER: expect.objectContaining({ round: 1, choices: expect.any(Array) }) }) }),
    }));
    expect(tx.sendOutbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      replyJobId: job.id, conversationId: job.conversationId, payloadJson: expect.objectContaining({ senderRole: 'AI' }),
    }) }));
  });

  it('Case 08: the next buyer turn resolves a persisted choice by its stable order id, rather than falling back to an older current order', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'order-b', externalOrderId: 'B200', status: 'SHIPPED', logisticsSnapshotJson: {}, version: 2 });
    const runtime = new ReplyRuntimeService({ order: { findFirst, findMany: jest.fn() }, message: { findMany: jest.fn().mockResolvedValue([]) } } as never, {} as never, {} as never, {} as never, {} as never);
    const contexts = await (runtime as unknown as {
      resolveTaskContexts(s: typeof scope, job: unknown, tasks: unknown[]): Promise<Map<string, { status: string; entity?: { id: string } }> >;
    }).resolveTaskContexts(scope, {
      sourceContextVersion: 4,
      conversation: {
        id: 'conversation-a', buyerId: 'buyer-a', contextVersion: 4, currentOrderId: 'order-old',
        clarificationRoundsJson: { ORDER: { round: 1, choices: [{ id: 'order-a', label: 'A100' }, { id: 'order-b', label: 'B200' }] } },
      },
      userTurn: { normalizedText: '我说的是 B200', sourceMessageIdsJson: [] },
    }, [{ id: 'task-order', riskLevel: 'LOW', requiredContext: ['ORDER'] }]);

    expect(contexts.get('task-order')).toMatchObject({ status: 'RESOLVED', entity: { id: 'order-b' } });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'order-b', ...scope, buyerId: 'buyer-a' }) }));
  });

  it('Case 08: round two keeps the same durable candidate ids and issues exactly one second deterministic clarification', async () => {
    const job = {
      id: 'reply-round-two', ...scope, status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-two', sourceContextVersion: 4, sourceSequence: 3, sourceLastMessageId: 'message-a', evidences: [],
      conversation: { id: 'conversation-a', buyerId: 'buyer-a', contextVersion: 4, humanActive: false, state: 'ACTIVE', clarificationRoundsJson: { ORDER: { round: 1, choices: [{ id: 'order-a', label: 'A100' }, { id: 'order-b', label: 'B200' }] } } },
      userTurn: { id: 'turn-two', normalizedText: '哪一笔订单？', sourceMessageIdsJson: [] },
    };
    const tx = {
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, replyJob: { findFirst: jest.fn().mockResolvedValue(job), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      sendOutbox: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'send-round-two' }) }, task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), replyJob: tx.replyJob, conversation: tx.conversation, replyEvidence: { createMany: jest.fn() },
      message: { findMany: jest.fn().mockResolvedValue([]) }, order: { findMany: jest.fn().mockResolvedValue([
        { id: 'order-a', externalOrderId: 'A100', status: 'SHIPPED', logisticsSnapshotJson: {}, version: 1 }, { id: 'order-b', externalOrderId: 'B200', status: 'PROCESSING', logisticsSnapshotJson: {}, version: 1 },
      ]) }, shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
    };
    const model = { runStructured: jest.fn().mockResolvedValueOnce({ output: { tasks: [{ intent: 'ORDER_LOGISTICS', riskLevel: 'LOW', requiredContext: ['ORDER'], requiredTools: [] }] } }).mockResolvedValueOnce({ output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' } }) };
    const runtime = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'NOT_FOUND', evidence: [], conflictItemIds: [] }) } as never, model as never, {} as never, new SendOutboxService(prisma as never));

    await expect(runtime.process(scope, job.id)).resolves.toEqual({ status: 'READY_TO_SEND' });
    expect(tx.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ clarificationRoundsJson: { ORDER: { round: 2, choices: [{ id: 'order-a', label: 'A100' }, { id: 'order-b', label: 'B200' }] } } }) }));
    expect(tx.sendOutbox.create).toHaveBeenCalledTimes(1);
  });

  it('Case 08: a third unresolved clarification turn is WAITING_HUMAN with no automatic SendOutbox or composer call', async () => {
    const job = {
      id: 'reply-round-three', ...scope, status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-three',
      sourceContextVersion: 4, sourceSequence: 3, sourceLastMessageId: 'message-a', evidences: [],
      conversation: {
        id: 'conversation-a', buyerId: 'buyer-a', contextVersion: 4, humanActive: false, state: 'ACTIVE',
        clarificationRoundsJson: { ORDER: { round: 2, choices: [{ id: 'order-a', label: 'A100' }, { id: 'order-b', label: 'B200' }] } },
      },
      userTurn: { id: 'turn-three', normalizedText: '还是那笔订单', sourceMessageIdsJson: [] },
    };
    const prisma = {
      replyJob: { findFirst: jest.fn().mockResolvedValue(job), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyEvidence: { createMany: jest.fn() }, message: { findMany: jest.fn().mockResolvedValue([]) },
      order: { findMany: jest.fn().mockResolvedValue([
        { id: 'order-a', externalOrderId: 'A100', status: 'SHIPPED', logisticsSnapshotJson: {}, version: 1 },
        { id: 'order-b', externalOrderId: 'B200', status: 'PROCESSING', logisticsSnapshotJson: {}, version: 1 },
      ]) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const model = {
      runStructured: jest.fn()
        .mockResolvedValueOnce({ output: { tasks: [{ intent: 'ORDER_LOGISTICS', riskLevel: 'LOW', requiredContext: ['ORDER'], requiredTools: [] }] } })
        .mockResolvedValueOnce({ output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' } }),
    };
    const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-round-three' }) };
    const outboxes = { enqueue: jest.fn(), enqueueInTransaction: jest.fn() };
    const runtime = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'NOT_FOUND', evidence: [], conflictItemIds: [] }) } as never, model as never, drafts as never, outboxes as never);

    await expect(runtime.process(scope, job.id)).resolves.toMatchObject({ status: 'WAITING_HUMAN', draftId: 'draft-round-three', reason: expect.stringContaining('CONTEXT_MANUAL_REQUIRED') });
    expect(model.runStructured).toHaveBeenCalledTimes(2);
    expect(drafts.createWaitingHuman).toHaveBeenCalledWith(scope, expect.objectContaining({ replyJobId: job.id }));
    expect(outboxes.enqueue).not.toHaveBeenCalled();
    expect(outboxes.enqueueInTransaction).not.toHaveBeenCalled();
  });

  it('Cases 06/07/09: a scoped AI send is denied after a same-conversation human takeover and never reaches transport', async () => {
    const pending = {
      id: 'send-a', status: 'PENDING', ...scope, conversationId: 'conversation-a', replyJobId: 'reply-a', idempotencyKey: 'send-a',
      payloadJson: { text: '自动答案', senderRole: 'AI' }, expectedLastMessageId: 'message-a', expectedSequence: 3, expectedContextVersion: 4,
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      sendOutbox: { findFirst: jest.fn().mockResolvedValue(pending), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', state: 'ACTIVE', humanActive: true, overrideMode: 'MANUAL', lastCommittedSequence: 3, contextVersion: 4 }) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-a' }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      replyJob: { findFirst: jest.fn().mockResolvedValue({ id: 'reply-a' }) },
    };
    const outboxes = new SendOutboxService({ $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) } as never);

    await expect(outboxes.claim(scope, pending.id)).resolves.toMatchObject({ claimed: false, failureCode: 'CONTEXT_STALE' });
    expect(tx.sendOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
    expect(tx.sendOutbox.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining(scope) }));
  });

  it('Case 09: Control saves a human factual correction, enqueues (but does not yet send) it, and creates exactly one candidate in the same durable boundary', async () => {
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', buyerId: 'buyer-a', lastCommittedSequence: 3, contextVersion: 4, humanActive: false, overrideMode: 'ASSIST' }) },
      replyDraft: {
        findFirst: jest.fn().mockResolvedValue({ id: 'draft-a', replyJobId: 'reply-a', aiDraft: '48小时内发货', sourceContextVersion: 4, sourceLastMessageId: 'message-a', sourceSequence: 3, status: 'WAITING_HUMAN' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyJob: { findFirst: jest.fn().mockResolvedValue({ id: 'reply-a', conversationId: 'conversation-a' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      sendOutbox: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: 'human-send-a', ...data }; }),
      },
      userTurn: { findFirst: jest.fn().mockResolvedValue({ normalizedText: '什么时候发货？' }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const knowledge = { createHumanCandidateInTransaction: jest.fn().mockResolvedValue({ id: 'candidate-a' }) };
    const control = new ConversationReplyControlService(prisma as never, knowledge as never, {} as never, new SendOutboxService(prisma as never));

    await expect(control.saveHumanFinal(scope, 'conversation-a', { text: '偏远地区通常 72 小时内发货。', sourceDraftId: 'draft-a', editType: 'FACTUAL_CORRECTION' }))
      .resolves.toEqual({ sendOutboxId: 'human-send-a', candidateId: 'candidate-a' });
    expect(created).toEqual([expect.objectContaining({ status: 'PENDING', replyJobId: 'reply-a', payloadJson: { text: '偏远地区通常 72 小时内发货。', senderRole: 'HUMAN' } })]);
    expect(knowledge.createHumanCandidateInTransaction).toHaveBeenCalledWith(tx, scope, expect.objectContaining({ question: '什么时候发货？', answer: '偏远地区通常 72 小时内发货。' }));
  });

  it('Case 09: actual takeover cancels the old AI send; explicit resume creates and runs one fresh latest-turn job without reviving it', async () => {
    const state = { humanActive: false, oldJobStatus: 'FAST_PATH_READY', oldOutboxStatus: 'PENDING' };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation-a', contextVersion: 4, lastCommittedSequence: 3,
          shopId: scope.shopId, shop: { aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] },
        }),
        updateMany: jest.fn().mockImplementation(async ({ where, data }: { where: { humanActive?: boolean }; data: { humanActive?: boolean } }) => {
          if (where.humanActive !== undefined && where.humanActive !== state.humanActive) return { count: 0 };
          if (data.humanActive !== undefined) state.humanActive = data.humanActive;
          return { count: 1 };
        }),
      },
      replyJob: {
        findMany: jest.fn().mockResolvedValue([{ id: 'reply-old' }]),
        updateMany: jest.fn().mockImplementation(async ({ data }: { data: { status?: string } }) => { if (data.status) state.oldJobStatus = data.status; return { count: 1 }; }),
      },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      sendOutbox: { updateMany: jest.fn().mockImplementation(async ({ where, data }: { where: { status?: string }; data: { status?: string } }) => {
        if (where.status === 'PENDING' && data.status) state.oldOutboxStatus = data.status;
        return { count: 1 };
      }) },
      processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      userTurn: { findFirst: jest.fn().mockResolvedValue({ id: 'turn-latest', lastSequence: 3, sourceMessageIdsJson: ['message-a'] }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const replyJobs = { createInTransaction: jest.fn().mockResolvedValue({ id: 'reply-resumed', status: 'PENDING' }) };
    const runtime = { process: jest.fn().mockResolvedValue({ status: 'WAITING_HUMAN' }) };
    const control = new ConversationReplyControlService(prisma as never, {} as never, replyJobs as never, {} as never, runtime as never);

    await expect(control.takeover(scope, 'conversation-a')).resolves.toMatchObject({ humanActive: true });
    await expect(control.resumeAi(scope, 'conversation-a')).resolves.toMatchObject({ resumed: true, replyJobId: 'reply-resumed' });
    expect(state).toMatchObject({ humanActive: false, oldJobStatus: 'STALE', oldOutboxStatus: 'CANCELLED' });
    expect(replyJobs.createInTransaction).toHaveBeenCalledWith(tx, scope, expect.objectContaining({
      conversationId: 'conversation-a', userTurnId: 'turn-latest', sourceLastMessageId: 'message-a', sourceContextVersion: 4, mode: 'AUTO',
    }), { lockHeld: true });
    expect(runtime.process).toHaveBeenCalledWith(scope, 'reply-resumed');
  });

  it('Case 09: the production SendOutbox + Mock worker chain projects only a receipt-confirmed AI reply as ASSISTANT', async () => {
    const state = {
      outbox: {
        id: 'send-chain', ...scope, status: 'PENDING', conversationId: 'conversation-a', replyJobId: 'reply-a', idempotencyKey: 'send-chain',
        payloadJson: { text: '库存还有 2 件。', senderRole: 'AI' }, expectedLastMessageId: 'message-a', expectedSequence: 3, expectedContextVersion: 4,
        transportStartedAt: null as Date | null,
      },
      job: { id: 'reply-a', status: 'FAST_PATH_READY' },
      conversation: { id: 'conversation-a', buyerId: 'buyer-a', externalConversationId: 'external-conversation-a', state: 'ACTIVE', humanActive: false, overrideMode: null, lastCommittedSequence: 3, contextVersion: 4, buyer: { externalBuyerId: 'external-buyer-a' } },
      projected: [] as Array<Record<string, unknown>>,
    };
    const matchingStatus = (where: Record<string, unknown>) => {
      const status = where.status;
      return !status || status === state.outbox.status || (typeof status === 'object' && Array.isArray((status as { in?: unknown[] }).in) && (status as { in: unknown[] }).in.includes(state.outbox.status));
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      sendOutbox: {
        findFirst: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => where.id === state.outbox.id && matchingStatus(where) ? state.outbox : null),
        updateMany: jest.fn().mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (where.id !== state.outbox.id || !matchingStatus(where) || ('transportStartedAt' in where && where.transportStartedAt === null && state.outbox.transportStartedAt !== null)) return { count: 0 };
          Object.assign(state.outbox, data);
          return { count: 1 };
        }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(state.conversation),
        updateMany: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(state.conversation, data); return { count: 1 }; }),
      },
      message: {
        findFirst: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => where.externalMessageId ? null : { id: 'message-a' }),
        create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { state.projected.push(data); return data; }),
      },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      replyJob: {
        findFirst: jest.fn().mockResolvedValue(state.job),
        updateMany: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(state.job, data); return { count: 1 }; }),
      },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
      sendOutbox: {
        findMany: jest.fn().mockImplementation(async ({ where }: { where: { status?: string } }) => where.status === 'PENDING' && state.outbox.status === 'PENDING' ? [state.outbox] : []),
        findFirst: tx.sendOutbox.findFirst,
        updateMany: tx.sendOutbox.updateMany,
      },
      conversation: { findFirst: tx.conversation.findFirst },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [] }) },
    };
    const adapter = { sendMessage: jest.fn().mockResolvedValue({ payload: { message: { externalMessageId: 'platform-chain', sentAt: '2026-09-01T00:00:00.000Z' } } }) };
    const outboxes = new SendOutboxService(prisma as never);
    const worker = new MockDouyinSendWorker(prisma as never, outboxes, adapter as never);

    const dispatch = await worker.dispatchOnce();
    expect(state.outbox).toMatchObject({ status: 'SENT' });
    expect(tx.message.findFirst).toHaveBeenCalled();
    expect(state.projected).toEqual([expect.objectContaining({ role: 'ASSISTANT', sequence: 4 })]);
    expect(dispatch).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(state.outbox).toMatchObject({ status: 'SENT' });
  });

  it('Case 10: recovery hands a stale GENERATING lease to the actual runtime only after a durable RECOVERY_PENDING claim', async () => {
    const runtime = { process: jest.fn().mockResolvedValue({ status: 'WAITING_HUMAN' }) };
    const prisma = {
      replyJob: {
        findMany: jest.fn().mockResolvedValue([{ id: 'reply-a', ...scope, conversationId: 'conversation-a', sourceContextVersion: 4, status: 'GENERATING' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4, humanActive: false, state: 'ACTIVE' }) },
    };
    const recovery = new ReplyRecoveryService(prisma as never, { recoverUncertain: jest.fn().mockResolvedValue(0) } as never, { expireDueAll: jest.fn().mockResolvedValue(0) } as never, runtime as never);
    const now = new Date('2026-09-01T00:04:00.000Z');

    await expect(recovery.recoverOnce(now)).resolves.toEqual({ recoveryPending: 1, stale: 0, uncertain: 0, expiredDrafts: 0 });
    expect(prisma.replyJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'RECOVERY_PENDING', staleReason: null } }));
    expect(runtime.process).toHaveBeenCalledWith(scope, 'reply-a');
  });

  it('Case 10: a started transport is recovered as UNCERTAIN and Mock worker never retries it', async () => {
    const state = { status: 'SENDING', updatedAt: new Date('2026-09-01T00:00:00.000Z') };
    const prisma = {
      sendOutbox: {
        updateMany: jest.fn().mockImplementation(async ({ where, data }: { where: { status?: string; updatedAt?: { lt: Date } }; data: { status: string } }) => {
          if (where.status !== state.status || (where.updatedAt?.lt && state.updatedAt >= where.updatedAt.lt)) return { count: 0 };
          state.status = data.status;
          return { count: 1 };
        }),
        findMany: jest.fn().mockImplementation(async ({ where }: { where: { status?: string } }) => where.status === 'PENDING' && state.status === 'PENDING' ? [{}] : []),
      },
      shopSettings: { findFirst: jest.fn() },
    };
    const outboxes = new SendOutboxService(prisma as never);
    const adapter = { sendMessage: jest.fn() };
    const worker = new MockDouyinSendWorker(prisma as never, outboxes, adapter as never);

    await expect(outboxes.recoverUncertain(new Date('2026-09-01T00:01:00.000Z'))).resolves.toBe(1);
    await expect(worker.dispatchOnce()).resolves.toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(state.status).toBe('UNCERTAIN');
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });
});
