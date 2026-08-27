import { ScenarioLabService } from '../src/scenarios/scenario-lab.service';
import type { MessageApplication } from '../src/messages/message.application';
import { TraceService } from '../src/trace/trace.service';

type Row = Record<string, any>;
type Table = Map<string, Row>;
type Tables = {
  [name: string]: Table;
  shop: Table;
  buyer: Table;
  product: Table;
  productSku: Table;
  order: Table;
  conversation: Table;
  message: Table;
  reorderBufferEntry: Table;
  conversationTurnBuffer: Table;
  userTurn: Table;
  task: Table;
  replyJob: Table;
  replyEvidence: Table;
  replyDraft: Table;
  knowledgeItem: Table;
  knowledgeVersion: Table;
  sendOutbox: Table;
  aiInvocation: Table;
  aiUsage: Table;
  processingOutbox: Table;
  traceEvent: Table;
};

const scope = { workspaceId: 'workspace-harness', tenantId: 'tenant-harness' };
const keys = [
  'continuous_messages',
  'message_during_generation',
  'two_buyers',
  'two_shops',
  'duplicate_and_reorder',
  'ai_timeout_fallback',
  'service_restart_recovery',
  'realtime_state_change',
] as const;

/** A deterministic repository harness exercising ScenarioLabService itself.
 * It stores every projected state in maps and implements the small Prisma
 * repository surface consumed by the production scenario seam. No branch is
 * replaced with a spy: Message/Turn/Task/Reply/AI/Send/inventory/order rows
 * are asserted after each real executeScenario path. */
class ScenarioProductionHarness {
  readonly rows: Tables = {} as Tables;
  readonly fixtureScope: { workspaceId: string; tenantId: string };
  readonly calls = { messages: 0, invalidationInventory: 0, invalidationOrder: 0, recovery: 0, uncertain: 0 };
  readonly prisma: any;
  readonly gateway = { publish: jest.fn() };
  readonly messages: MessageApplication;
  readonly invalidation: any;
  readonly recovery: any;
  readonly sendOutboxes: any;
  readonly traces: TraceService;

  constructor(fixtureScope = scope) {
    this.fixtureScope = fixtureScope;
    for (const name of ['shop', 'buyer', 'product', 'productSku', 'order', 'conversation', 'message', 'reorderBufferEntry', 'conversationTurnBuffer', 'userTurn', 'task', 'replyJob', 'replyEvidence', 'replyDraft', 'knowledgeItem', 'knowledgeVersion', 'sendOutbox', 'aiInvocation', 'aiUsage', 'processingOutbox', 'traceEvent']) {
      this.rows[name] = new Map();
    }
    this.seedRows();
    this.prisma = { $transaction: async (work: (tx: any) => unknown) => work(this.prisma) };
    for (const name of Object.keys(this.rows)) this.prisma[name] = this.repository(name);
    this.traces = new TraceService(this.prisma as never);
    this.messages = this.createMessageApplication();
    this.invalidation = {
      updateSkuInventory: async (changeScope: Row, productId: string, skuId: string, inventory: number) => this.updateInventory(changeScope, productId, skuId, inventory),
      updateOrderStatus: async (changeScope: Row, orderId: string, status: string) => this.updateOrder(changeScope, orderId, status),
    };
    this.recovery = {
      recoverOnce: async () => {
        this.calls.recovery += 1;
        return { recoveryPending: 1, stale: 0, uncertain: 0, expiredDrafts: 0 };
      },
    };
    this.sendOutboxes = {
      recoverUncertain: async () => {
        this.calls.uncertain += 1;
        let count = 0;
        for (const row of this.rows.sendOutbox.values()) {
          if (row.status === 'SENDING') { row.status = 'UNCERTAIN'; count += 1; }
        }
        return count;
      },
    };
  }

  service(): ScenarioLabService {
    const service = new ScenarioLabService(
      this.prisma,
      this.messages,
      this.invalidation,
      this.gateway as never,
      undefined,
      this.recovery,
      this.sendOutboxes,
    );
    // The dedicated Case07 service harness executes the actual
    // ReplyRuntimeService + KnowledgeService. This broader eight-scenario
    // harness keeps its deterministic message pipeline and supplies only the
    // narrow runtime boundary needed to persist its Case07 artifacts.
    Object.assign(service as object, { replyRuntime: this.case07Runtime, traces: this.traces });
    return service;
  }

  row(name: string, where: Row): Row | undefined {
    return [...this.rows[name]!.values()].find((candidate) => matches(candidate, where));
  }

  rowsFor(name: string, where: Row): Row[] {
    return [...this.rows[name]!.values()].filter((candidate) => matches(candidate, where));
  }

  resetResourceState(): void {
    // Fixed seed facts are intentionally restored between scenario cases; this
    // keeps every case independent while proving Reset is reversible.
    const sku = this.row('productSku', { ...this.fixtureScope, id: 'sku-hoodie-xl' });
    if (sku) sku.inventory = 8;
    const order = this.row('order', { ...this.fixtureScope, id: 'order-001' });
    if (order) { order.status = 'WAITING_SHIPMENT'; order.version = 1; }
  }

  private repository(name: string) {
    const table = this.rows[name]!;
    return {
      findFirst: async (input: Row = {}) => this.project(this.rowsFor(name, input.where ?? {}).sort(orderer(input.orderBy))[0], input.select),
      findMany: async (input: Row = {}) => this.rowsFor(name, input.where ?? {}).sort(orderer(input.orderBy)).map((row) => this.project(row, input.select)),
      findUnique: async (input: Row = {}) => this.project(this.rowsFor(name, input.where ?? {}).at(0), input.select),
      count: async (input: Row = {}) => this.rowsFor(name, input.where ?? {}).length,
      aggregate: async (input: Row = {}) => {
        const values = this.rowsFor(name, input.where ?? {}).map((row) => row.sequence).filter((value) => Number.isSafeInteger(value));
        return { _max: { sequence: values.length ? Math.max(...values) : null } };
      },
      create: async (input: Row) => {
        const value = { ...(input.data ?? {}), id: input.data?.id ?? `${name}-${table.size + 1}`, createdAt: input.data?.createdAt ?? new Date(), updatedAt: input.data?.updatedAt ?? new Date() };
        table.set(value.id, value);
        return value;
      },
      update: async (input: Row) => {
        const row = [...table.values()].find((candidate) => candidate.id === input.where?.id);
        if (!row) throw new Error(`${name} row not found`);
        apply(row, input.data ?? {});
        return row;
      },
      updateMany: async (input: Row) => {
        const found = this.rowsFor(name, input.where ?? {});
        found.forEach((row) => apply(row, input.data ?? {}));
        return { count: found.length };
      },
      upsert: async (input: Row) => {
        const existing = this.rowsFor(name, input.where ?? {}).at(0);
        if (existing) { apply(existing, input.update ?? {}); return existing; }
        return this.repository(name).create({ data: input.create });
      },
      deleteMany: async (input: Row = {}) => {
        const found = this.rowsFor(name, input.where ?? {});
        found.forEach((row) => table.delete(row.id));
        return { count: found.length };
      },
    };
  }

  private project(row: Row | undefined, select?: Row): Row | undefined {
    if (!row || !select) return row;
    return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
  }

  private seedRows(): void {
    const fixture = (name: string, id: string, values: Row) => this.rows[name]!.set(id, { id, ...this.fixtureScope, ...values, createdAt: new Date(), updatedAt: new Date() });
    fixture('shop', 'shop-mia', { seedKey: 'shop_mia_fashion', name: 'MIA Fashion', aiMode: 'ASSIST_ONLY' });
    fixture('shop', 'shop-pixel', { seedKey: 'shop_pixel_tech', name: 'Pixel Tech', aiMode: 'ASSIST_ONLY' });
    fixture('buyer', 'buyer-001', { seedKey: 'buyer_001', externalBuyerId: 'dy_buyer_001' });
    fixture('buyer', 'buyer-002', { seedKey: 'buyer_002', externalBuyerId: 'dy_buyer_002' });
    fixture('buyer', 'buyer-003', { seedKey: 'buyer_003', externalBuyerId: 'dy_buyer_003' });
    fixture('buyer', 'buyer-004', { seedKey: 'buyer_004', externalBuyerId: 'dy_buyer_004' });
    fixture('product', 'product-hoodie', { seedKey: 'fashion_hoodie', shopId: 'shop-mia', title: '轻薄连帽卫衣', status: 'ON_SHELF', recommendable: true });
    fixture('productSku', 'sku-hoodie-xl', { shopId: 'shop-mia', productId: 'product-hoodie', externalSkuId: 'P-F-001-BLACK-XL', inventory: 8 });
    fixture('order', 'order-001', { seedKey: 'order_001', shopId: 'shop-mia', buyerId: 'buyer-001', productId: 'product-hoodie', status: 'WAITING_SHIPMENT', version: 1 });
    fixture('knowledgeItem', 'knowledge-mia-shipping', { shopId: 'shop-mia', scope: 'STORE', deletedAt: null });
    fixture('knowledgeItem', 'knowledge-pixel-shipping', { shopId: 'shop-pixel', scope: 'STORE', deletedAt: null });
    fixture('knowledgeVersion', 'knowledge-mia-shipping-v1', { knowledgeItemId: 'knowledge-mia-shipping' });
    fixture('knowledgeVersion', 'knowledge-pixel-shipping-v1', { knowledgeItemId: 'knowledge-pixel-shipping' });
  }

  private readonly case07Runtime = {
    process: async (replyScope: Row, replyJobId: string) => {
      const job = this.row('replyJob', { ...replyScope, id: replyJobId });
      if (!job) throw new Error('reply job missing');
      const isMia = replyScope.shopId === 'shop-mia';
      const knowledgeItemId = isMia ? 'knowledge-mia-shipping' : 'knowledge-pixel-shipping';
      const knowledgeVersionId = isMia ? 'knowledge-mia-shipping-v1' : 'knowledge-pixel-shipping-v1';
      const evidenceId = `evidence-${replyJobId}`;
      this.rows.replyEvidence.set(evidenceId, {
        id: evidenceId, ...replyScope, replyJobId, knowledgeItemId, knowledgeVersionId,
        knowledgeVersionNumber: 1, sourceType: 'MANUAL', scope: 'STORE', productId: null,
        retrievedContentSnapshotJson: { question: '多久发货？', answer: isMia ? 'MIA 24 小时内发货' : 'Pixel 48 小时内发货' },
        createdAt: new Date(), updatedAt: new Date(),
      });
      const draftId = `draft-${replyJobId}`;
      this.rows.replyDraft.set(draftId, {
        id: draftId, ...replyScope, replyJobId, status: 'WAITING_HUMAN', aiDraft: isMia ? 'MIA 24 小时内发货' : 'Pixel 48 小时内发货',
        createdAt: new Date(), updatedAt: new Date(),
      });
      job.status = 'WAITING_HUMAN';
      return { status: 'WAITING_HUMAN' as const, draftId };
    },
  };

  private createMessageApplication(): MessageApplication {
    const harness = this;
    return {
      listBuyers: async () => [], listProducts: async () => [], listOrders: async () => [], listConversations: async () => [], getConversation: async () => ({} as never),
      editMessage: async () => ({ operationId: 'edit', status: 'ACCEPTED' }), recallMessage: async () => ({ operationId: 'recall', status: 'ACCEPTED' }),
      sendProductCard: async () => ({ operationId: 'card', status: 'ACCEPTED' }), sendOrderCard: async () => ({ operationId: 'card', status: 'ACCEPTED' }),
      sendMessage: async (_scope, input) => {
        harness.calls.messages += 1;
        const conversation = harness.row('conversation', { ...harness.fixtureScope, id: input.conversationId });
        if (!conversation) throw new Error('conversation missing');
        const externalMessageId = input.duplicateExternalMessageId ?? `message-${harness.rows.message.size + 1}`;
        if (harness.row('message', { ...harness.fixtureScope, externalMessageId }) || harness.row('reorderBufferEntry', { ...harness.fixtureScope, externalMessageId })) return { operationId: `duplicate:${externalMessageId}`, status: 'ACCEPTED' };
        const sequence = input.forcedSequence ?? conversation.lastCommittedSequence + 1;
        const payload = { text: input.text ?? '' };
        const message = { id: `message-${harness.rows.message.size + 1}`, ...harness.fixtureScope, shopId: conversation.shopId, conversationId: conversation.id, buyerId: conversation.buyerId, externalMessageId, sequence, role: 'BUYER', kind: 'TEXT', status: 'ACTIVE', contentJson: payload, createdAt: new Date(), updatedAt: new Date() };
        if (sequence > conversation.lastCommittedSequence + 1) {
          harness.rows.reorderBufferEntry.set(`reorder-${sequence}`, { id: `reorder-${sequence}`, ...harness.fixtureScope, shopId: conversation.shopId, conversationId: conversation.id, externalMessageId, sequence, status: 'BUFFERED', payloadJson: { ...message, content: payload } });
        } else {
          harness.commitMessage(conversation, message);
          while (true) {
            const next = harness.row('reorderBufferEntry', { ...harness.fixtureScope, conversationId: conversation.id, sequence: conversation.lastCommittedSequence + 1, status: 'BUFFERED' });
            if (!next) break;
            harness.commitMessage(conversation, { ...next.payloadJson, id: `message-${harness.rows.message.size + 1}`, status: 'ACTIVE', contentJson: next.payloadJson.content });
            next.status = 'COMMITTED';
          }
        }
        harness.ensureTurnBuffer(conversation, sequence);
        return { operationId: message.id, status: 'ACCEPTED' };
      },
      // Expose the same durable application seam that ScenarioLabService
      // probes when Redis workers are absent in this deterministic harness.
      flushTurn: harness.flushTurn,
      dispatchPending: harness.dispatchPending,
    } as MessageApplication;
  }

  private commitMessage(conversation: Row, message: Row): void {
    this.rows.message.set(message.id, message);
    conversation.lastCommittedSequence = message.sequence;
    conversation.updatedAt = new Date();
  }

  private ensureTurnBuffer(conversation: Row, sequence: number): void {
    const current = this.row('conversationTurnBuffer', { conversationId: conversation.id });
    if (current?.status === 'BUFFERING') {
      current.latestSequence = Math.max(current.latestSequence, sequence);
      current.lastMessageAt = new Date();
      return;
    }
    if (current?.status === 'FLUSHED') {
      // A committed message after a flushed turn opens the next generation
      // instead of appending to the already closed turn.
      current.firstSequence = sequence;
      current.latestSequence = sequence;
      current.generation += 1;
      current.status = 'BUFFERING';
      current.openedAt = new Date();
      current.lastMessageAt = current.openedAt;
      return;
    }
    this.rows.conversationTurnBuffer.set(conversation.id, { id: `buffer-${conversation.id}`, ...this.fixtureScope, shopId: conversation.shopId, conversationId: conversation.id, firstSequence: sequence, latestSequence: sequence, generation: 1, status: 'BUFFERING', openedAt: new Date(), lastMessageAt: new Date() });
  }

  private readonly flushTurn = async (conversationId: string, _generation: number) => {
    const buffer = this.row('conversationTurnBuffer', { conversationId, status: 'BUFFERING' });
    if (!buffer) return;
    const conversation = this.row('conversation', { ...this.fixtureScope, id: conversationId });
    const messages = this.rowsFor('message', { ...this.fixtureScope, conversationId, role: 'BUYER', status: { not: 'RECALLED' } }).sort((a, b) => a.sequence - b.sequence);
    if (!conversation || !messages.length) return;
    const firstMessage = messages[0]!;
    const lastMessage = messages[messages.length - 1]!;
    const turn = { id: `turn-${conversationId}-${this.rows.userTurn.size + 1}`, ...this.fixtureScope, shopId: conversation.shopId, conversationId, sourceMessageIdsJson: messages.map((message) => message.id), firstSequence: firstMessage.sequence, lastSequence: lastMessage.sequence, normalizedText: messages.map((message) => message.contentJson.text).join('\n'), status: 'PLANNED', turnKey: `turn-${conversationId}-${this.rows.userTurn.size + 1}` };
    this.rows.userTurn.set(turn.id, turn);
    buffer.status = 'FLUSHED';
    const job = { id: `reply-${turn.id}`, ...this.fixtureScope, shopId: conversation.shopId, conversationId, userTurnId: turn.id, status: 'PENDING', mode: 'ASSIST', sourceLastMessageId: lastMessage.id, sourceSequence: lastMessage.sequence, sourceContextVersion: conversation.contextVersion, idempotencyKey: `reply-plan:${turn.id}` };
    this.rows.replyJob.set(job.id, job);
    const intents = /黑色|XL|公斤/.test(turn.normalizedText) ? ['INVENTORY_QUERY', 'SIZE_RECOMMENDATION'] : ['SHIPPING_POLICY'];
    for (const intent of intents) this.rows.task.set(`task-${job.id}-${intent}`, { id: `task-${job.id}-${intent}`, ...this.fixtureScope, shopId: conversation.shopId, conversationId, userTurnId: turn.id, intent, status: 'RESOLVED', blocking: false });
  };

  private readonly dispatchPending = async () => undefined;

  private updateInventory(changeScope: Row, productId: string, skuId: string, inventory: number) {
    this.calls.invalidationInventory += 1;
    const sku = this.row('productSku', { ...changeScope, id: skuId, productId });
    if (!sku) return { updated: false, invalidatedConversations: 0 };
    sku.inventory = inventory;
    const affected = this.rowsFor('conversation', { ...this.fixtureScope, shopId: changeScope.shopId }).filter((conversation) => conversation.currentProductId === productId);
    affected.forEach((conversation) => this.invalidateConversation(conversation));
    return { updated: true, invalidatedConversations: affected.length };
  }

  private updateOrder(changeScope: Row, orderId: string, status: string) {
    this.calls.invalidationOrder += 1;
    const order = this.row('order', { ...changeScope, id: orderId });
    if (!order) return { updated: false, invalidatedConversations: 0 };
    order.status = status; order.version += 1;
    const affected = this.rowsFor('conversation', { ...this.fixtureScope, shopId: changeScope.shopId }).filter((conversation) => conversation.currentOrderId === orderId);
    affected.forEach((conversation) => this.invalidateConversation(conversation));
    return { updated: true, invalidatedConversations: affected.length };
  }

  private invalidateConversation(conversation: Row): void {
    conversation.contextVersion += 1;
    conversation.needsReplan = true;
    this.rowsFor('replyJob', { ...this.fixtureScope, conversationId: conversation.id, status: { in: ['PENDING', 'GENERATING', 'WAITING_HUMAN', 'RECOVERY_PENDING'] } }).forEach((job) => { job.status = 'STALE'; job.staleReason = 'SCENARIO_STATE_CHANGED'; });
  }
}

describe('ScenarioLabService production-service harness', () => {
  it.each(keys)('executes %s through real state transitions', async (key) => {
    const harness = new ScenarioProductionHarness();
    const service = harness.service();

    const accepted = await service.run(scope, key);
    expect(accepted.status).toBe('ACCEPTED');
    // A completed operation is durable/idempotent: a second click must not
    // execute the branch or append another Message/Reply projection.
    await expect(service.run(scope, key)).resolves.toEqual(accepted);
    const snapshot = (await service.list(scope)).find((scenario) => scenario.key === key)!;
    expect(snapshot.status).toBe('SUCCEEDED');
    expect(snapshot.steps?.every((step) => step.status === 'SUCCEEDED')).toBe(true);
    expect(harness.calls.messages).toBeGreaterThan(0);
    expect(harness.gateway.publish).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'SCENARIO_UPDATED', workspaceId: scope.workspaceId }));
    expect(harness.rows.traceEvent.size).toBeGreaterThan(0);

    switch (key) {
      case 'continuous_messages': {
        expect(harness.rows.message.size).toBe(3);
        expect(harness.rows.userTurn.size).toBe(1);
        expect(harness.rows.task.size).toBe(2);
        expect(harness.rows.replyJob.size).toBe(1);
        break;
      }
      case 'message_during_generation': {
        expect(harness.rows.message.size).toBe(2);
        expect([...harness.rows.replyJob.values()].some((job) => job.status === 'STALE')).toBe(true);
        expect([...harness.rows.conversation.values()].some((conversation) => conversation.contextVersion === 2 && conversation.needsReplan)).toBe(true);
        expect([...harness.rows.replyJob.values()].some((job) => job.status === 'PENDING')).toBe(true);
        break;
      }
      case 'two_buyers': {
        const conversations = [...harness.rows.conversation.values()];
        expect(conversations).toHaveLength(2);
        expect(new Set(conversations.map((conversation) => conversation.buyerId)).size).toBe(2);
        expect(harness.rows.message.size).toBe(2);
        break;
      }
      case 'two_shops': {
        const conversations = [...harness.rows.conversation.values()];
        expect(new Set(conversations.map((conversation) => conversation.shopId)).size).toBe(2);
        expect(new Set([...harness.rows.message.values()].map((message) => message.shopId)).size).toBe(2);
        expect(harness.rows.message.size).toBe(2);
        break;
      }
      case 'duplicate_and_reorder': {
        expect(harness.rows.message.size).toBe(3);
        expect([...harness.rows.message.values()].map((message) => message.sequence)).toEqual([101, 102, 103]);
        expect([...harness.rows.reorderBufferEntry.values()].every((entry) => entry.status === 'COMMITTED')).toBe(true);
        expect(harness.calls.messages).toBe(4);
        break;
      }
      case 'ai_timeout_fallback': {
        expect(harness.rows.aiInvocation.size).toBe(1);
        expect([...harness.rows.aiInvocation.values()][0]).toMatchObject({ fallbackUsed: true, provider: 'MOCK_TIMEOUT_THEN_FALLBACK' });
        const result = latestScenarioResult(harness, key);
        expect(result).toMatchObject({ retryCount: 1, fallbackUsed: true, primaryProvider: 'MOCK_TIMEOUT', fallbackProvider: 'MOCK_FALLBACK' });
        break;
      }
      case 'service_restart_recovery': {
        expect(harness.calls.recovery).toBe(1);
        expect(harness.calls.uncertain).toBe(1);
        expect([...harness.rows.sendOutbox.values()]).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'UNCERTAIN' })]));
        break;
      }
      case 'realtime_state_change': {
        expect(harness.calls.invalidationInventory).toBe(1);
        expect(harness.calls.invalidationOrder).toBe(1);
        expect(harness.row('productSku', { id: 'sku-hoodie-xl' })?.inventory).toBe(0);
        expect(harness.row('order', { id: 'order-001' })?.status).toBe('SHIPPED');
        expect([...harness.rows.replyJob.values()].some((job) => job.status === 'STALE')).toBe(true);
        expect([...harness.rows.conversation.values()].some((conversation) => conversation.contextVersion === 3 && conversation.needsReplan)).toBe(true);
        break;
      }
    }

    const reset = await service.reset(scope, key);
    const resetAgain = await service.reset(scope, key);
    expect(resetAgain).toEqual(reset);
    expect((await service.list(scope)).find((scenario) => scenario.key === key)?.status).toBe('READY');
    expect(harness.rows.conversation.size).toBe(0);
    if (key === 'realtime_state_change') {
      expect(harness.row('productSku', { id: 'sku-hoodie-xl' })?.inventory).toBe(8);
      expect(harness.row('order', { id: 'order-001' })?.status).toBe('WAITING_SHIPMENT');
    }
  });

  it('keeps the same buyer isolated across shops and the same shop isolated across workspaces', async () => {
    const first = new ScenarioProductionHarness();
    const otherScope = { workspaceId: 'workspace-other', tenantId: 'tenant-other' };
    const second = new ScenarioProductionHarness(otherScope);
    await first.service().run(scope, 'two_shops');
    await second.service().run(otherScope, 'two_buyers');

    expect([...first.rows.message.values()].every((message) => message.workspaceId === scope.workspaceId)).toBe(true);
    expect([...second.rows.message.values()].every((message) => message.workspaceId === 'workspace-other')).toBe(true);
    expect(first.rows.message.size).toBe(2);
    expect(second.rows.message.size).toBe(2);
  });
});

function latestScenarioResult(harness: ScenarioProductionHarness, key: string): Row | undefined {
  const succeeded = [...harness.rows.traceEvent.values()]
    .filter((row) => row.payloadJson?.scenario?.key === key && row.payloadJson?.scenario?.status === 'SUCCEEDED');
  return succeeded[succeeded.length - 1]?.payloadJson?.result;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Row[]).some((item) => matches(row, item));
    if (key === 'AND') return (condition as Row[]).every((item) => matches(row, item));
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('in' in condition) return (condition.in as unknown[]).includes(row[key]);
      if ('not' in condition) return row[key] !== condition.not;
      if ('startsWith' in condition) return typeof row[key] === 'string' && row[key].startsWith(String(condition.startsWith));
      if ('gte' in condition && !(row[key] >= condition.gte)) return false;
      if ('lte' in condition && !(row[key] <= condition.lte)) return false;
      return true;
    }
    return row[key] === condition;
  });
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) row[key] = Number(row[key] ?? 0) + Number(value.increment);
    else row[key] = value;
  }
  row.updatedAt = new Date();
}

function orderer(orderBy: unknown): (left: Row, right: Row) => number {
  const entries = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return (left, right) => {
    for (const entry of entries) {
      const [key, direction] = Object.entries(entry as Row)[0] ?? [];
      if (!key) continue;
      if (left[key] === right[key]) continue;
      const compared = left[key] > right[key] ? 1 : -1;
      return direction === 'desc' ? -compared : compared;
    }
    return 0;
  };
}
