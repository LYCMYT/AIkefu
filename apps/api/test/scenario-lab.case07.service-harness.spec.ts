import { KnowledgeService } from '../src/knowledge/knowledge.service';
import type { MessageApplication } from '../src/messages/message.application';
import { ReplyDraftService } from '../src/replies/reply-draft.service';
import { ReplyRuntimeService } from '../src/replies/reply-runtime.service';
import { ConversationTransportMutex } from '../src/replies/conversation-transport-mutex.service';
import { ScenarioLabService } from '../src/scenarios/scenario-lab.service';
import { TraceService } from '../src/trace/trace.service';

type Row = Record<string, any>;
type Table = Map<string, Row>;

const scope = { workspaceId: 'workspace-case07', tenantId: 'tenant-case07' };

/**
 * This is deliberately a production-service harness, not a ScenarioLab mock:
 * Case07 calls the real KnowledgeService.search and ReplyRuntimeService.process
 * against a deterministic persistence port. The only model port is a local
 * structured-output fixture, so the test can never call an external provider.
 */
class Case07ProductionServiceHarness {
  readonly rows: Record<string, Table> = {};
  readonly prisma: any;
  readonly gateway = { publish: jest.fn() };
  readonly messages: MessageApplication;
  readonly traces: TraceService;
  readonly knowledge: KnowledgeService;
  readonly replyRuntime: ReplyRuntimeService;
  readonly runtime = { runStructured: jest.fn(async (_scope: unknown, input: Row) => this.structuredOutput(input)) };

  constructor() {
    for (const name of [
      'shop', 'shopSettings', 'buyer', 'conversation', 'conversationTurnBuffer', 'message', 'userTurn',
      'replyJob', 'replyEvidence', 'replyDraft', 'knowledgeItem', 'knowledgeVersion', 'knowledgeConflict',
      'task', 'processingOutbox', 'traceEvent',
    ]) this.rows[name] = new Map();
    this.prisma = {
      $transaction: async (work: (tx: any) => unknown) => work(this.prisma),
      $executeRaw: async () => 1,
    };
    for (const name of Object.keys(this.rows)) this.prisma[name] = this.repository(name);
    this.prisma.replyJob = this.replyJobRepository();
    this.prisma.knowledgeItem = this.knowledgeItemRepository();
    this.seed();
    this.messages = this.createMessageApplication();
    this.traces = new TraceService(this.prisma as never);
    this.knowledge = new KnowledgeService(this.prisma as never, {} as never);
    this.replyRuntime = new ReplyRuntimeService(
      this.prisma as never,
      this.knowledge,
      this.runtime as never,
      new ReplyDraftService(this.prisma as never),
      {} as never,
      this.gateway as never,
      new ConversationTransportMutex(),
      this.traces,
    );
  }

  service(): ScenarioLabService {
    const service = new ScenarioLabService(
      this.prisma as never,
      this.messages,
      {} as never,
      this.gateway as never,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    // Written before the production constructor receives these dependencies:
    // old Case07 ignores both and therefore leaves this test red.
    Object.assign(service as object, { replyRuntime: this.replyRuntime, traces: this.traces });
    return service;
  }

  rowsFor(name: string, where: Row): Row[] {
    return [...this.rows[name]!.values()].filter((row) => matches(row, where));
  }

  private repository(name: string) {
    const table = this.rows[name]!;
    return {
      findFirst: async (input: Row = {}) => this.project(this.rowsFor(name, input.where ?? {}).sort(orderBy(input.orderBy))[0], input.select),
      findMany: async (input: Row = {}) => this.rowsFor(name, input.where ?? {}).sort(orderBy(input.orderBy)).map((row) => this.project(row, input.select)),
      findUnique: async (input: Row = {}) => this.project(this.rowsFor(name, input.where ?? {})[0], input.select),
      count: async (input: Row = {}) => this.rowsFor(name, input.where ?? {}).length,
      create: async (input: Row) => {
        const data = input.data ?? {};
        const value = { id: data.id ?? `${name}-${table.size + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        if (name === 'conversation') Object.assign(value, {
          syncState: value.syncState ?? 'CONNECTED', humanActive: value.humanActive ?? false,
          overrideMode: value.overrideMode ?? null, needsReplan: value.needsReplan ?? false,
          currentProductId: value.currentProductId ?? null, currentOrderId: value.currentOrderId ?? null,
        });
        table.set(value.id, value);
        return value;
      },
      createMany: async (input: Row) => {
        const data = Array.isArray(input.data) ? input.data : [];
        for (const value of data) {
          const id = value.id ?? `${name}-${table.size + 1}`;
          if (input.skipDuplicates && table.has(id)) continue;
          table.set(id, { id, createdAt: new Date(), updatedAt: new Date(), ...value });
        }
        return { count: data.length };
      },
      updateMany: async (input: Row) => {
        const found = this.rowsFor(name, input.where ?? {});
        found.forEach((row) => apply(row, input.data ?? {}));
        return { count: found.length };
      },
      upsert: async (input: Row) => {
        const existing = this.rowsFor(name, input.where ?? {})[0];
        if (existing) {
          apply(existing, input.update ?? {});
          return existing;
        }
        return this.repository(name).create({ data: input.create });
      },
      deleteMany: async (input: Row = {}) => {
        const found = this.rowsFor(name, input.where ?? {});
        found.forEach((row) => table.delete(row.id));
        return { count: found.length };
      },
    };
  }

  private replyJobRepository() {
    const base = this.repository('replyJob');
    return {
      ...base,
      findFirst: async (input: Row = {}) => {
        const row = this.rowsFor('replyJob', input.where ?? {}).sort(orderBy(input.orderBy))[0];
        if (!row) return null;
        const materialized: Row = { ...row };
        if (input.include?.evidences) materialized.evidences = this.rowsFor('replyEvidence', { replyJobId: row.id });
        if (input.include?.conversation) materialized.conversation = this.rowsFor('conversation', { id: row.conversationId })[0];
        if (input.include?.userTurn) materialized.userTurn = this.rowsFor('userTurn', { id: row.userTurnId })[0];
        return this.project(materialized, input.select);
      },
    };
  }

  private knowledgeItemRepository() {
    const base = this.repository('knowledgeItem');
    return {
      ...base,
      findMany: async (input: Row = {}) => this.rowsFor('knowledgeItem', input.where ?? {}).map((item) => {
        const materialized: Row = { ...item };
        if (input.include?.versions) {
          materialized.versions = this.rowsFor('knowledgeVersion', {
            ...(input.include.versions.where ?? {}),
            knowledgeItemId: item.id,
          }).sort(orderBy(input.include.versions.orderBy));
        }
        return this.project(materialized, input.select);
      }),
    };
  }

  private project(row: Row | undefined, select?: Row): Row | null {
    if (!row) return null;
    if (!select) return row;
    return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]));
  }

  private seed(): void {
    const put = (name: string, id: string, row: Row) => this.rows[name]!.set(id, { id, ...scope, createdAt: new Date(), updatedAt: new Date(), ...row });
    put('shop', 'shop-mia', { seedKey: 'shop_mia_fashion', aiMode: 'ASSIST_ONLY' });
    put('shop', 'shop-pixel', { seedKey: 'shop_pixel_tech', aiMode: 'ASSIST_ONLY' });
    put('shopSettings', 'settings-mia', { shopId: 'shop-mia', forbiddenTermsJson: [], transferKeywordsJson: [] });
    put('shopSettings', 'settings-pixel', { shopId: 'shop-pixel', forbiddenTermsJson: [], transferKeywordsJson: [] });
    put('buyer', 'buyer-001', { seedKey: 'buyer_001', externalBuyerId: 'synthetic-buyer-001' });
    this.seedKnowledge('mia-shipping', 'mia-shipping-v1', 'shop-mia', 'MIA Fashion：普通现货商品通常在24小时内发出。');
    this.seedKnowledge('pixel-shipping', 'pixel-shipping-v1', 'shop-pixel', 'Pixel Tech：数码商品通常在48小时内发出。');
  }

  private seedKnowledge(itemId: string, versionId: string, shopId: string, answer: string): void {
    this.rows.knowledgeItem!.set(itemId, {
      id: itemId, ...scope, shopId, scope: 'STORE', productId: null, sourceType: 'MANUAL',
      businessStatus: 'ENABLED', activeVersionId: versionId, deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    this.rows.knowledgeVersion!.set(versionId, {
      id: versionId, ...scope, shopId, knowledgeItemId: itemId, version: 1, question: '多久发货？', answer,
      indexStatus: 'READY', effectiveFrom: new Date(Date.now() - 60_000), effectiveTo: null, createdAt: new Date(), updatedAt: new Date(),
    });
  }

  private createMessageApplication(): MessageApplication {
    return {
      sendMessage: async (_scope: unknown, input: any) => {
        const conversation = this.rowsFor('conversation', { id: input.conversationId, ...scope })[0];
        if (!conversation) throw new Error('conversation missing');
        const id = `message-${this.rows.message!.size + 1}`;
        this.rows.message!.set(id, {
          id, ...scope, shopId: conversation.shopId, buyerId: conversation.buyerId, conversationId: conversation.id,
          externalMessageId: input.duplicateExternalMessageId, sequence: input.forcedSequence, role: 'BUYER', kind: 'TEXT',
          status: 'ACTIVE', contentJson: { text: input.text }, createdAt: new Date(), updatedAt: new Date(),
        });
        conversation.lastCommittedSequence = input.forcedSequence;
        this.rows.conversationTurnBuffer!.set(conversation.id, {
          id: `buffer-${conversation.id}`, ...scope, shopId: conversation.shopId, conversationId: conversation.id,
          generation: 1, status: 'BUFFERING', createdAt: new Date(), updatedAt: new Date(),
        });
        return { operationId: id, status: 'ACCEPTED' };
      },
      flushTurn: async (conversationId: string) => {
        const conversation = this.rowsFor('conversation', { id: conversationId, ...scope })[0];
        const messages = this.rowsFor('message', { conversationId, ...scope, role: 'BUYER' }).sort((a, b) => a.sequence - b.sequence);
        if (!conversation || !messages.length) return;
        const turnId = `turn-${conversation.id}`;
        const last = messages.at(-1)!;
        this.rows.userTurn!.set(turnId, {
          id: turnId, ...scope, shopId: conversation.shopId, conversationId, sourceMessageIdsJson: messages.map((message) => message.id),
          normalizedText: messages.map((message) => message.contentJson.text).join('\n'), firstSequence: messages[0]!.sequence,
          lastSequence: last.sequence, turnKey: `turn:${conversation.id}`, status: 'PLANNED', createdAt: new Date(), updatedAt: new Date(),
        });
        const jobId = `reply-${conversation.id}`;
        this.rows.replyJob!.set(jobId, {
          id: jobId, ...scope, shopId: conversation.shopId, conversationId, userTurnId: turnId, status: 'PENDING', mode: 'ASSIST',
          sourceLastMessageId: last.id, sourceSequence: last.sequence, sourceContextVersion: conversation.contextVersion,
          idempotencyKey: `scenario-case07:${conversation.id}`, createdAt: new Date(), updatedAt: new Date(),
        });
        const buffer = this.rowsFor('conversationTurnBuffer', { conversationId })[0];
        if (buffer) buffer.status = 'FLUSHED';
      },
      dispatchPending: async () => undefined,
    } as unknown as MessageApplication;
  }

  private structuredOutput(input: Row) {
    if (input.purpose === 'INTENT_PLANNER') {
      return { output: { tasks: [{ intent: 'SHIPPING_POLICY', riskLevel: 'LOW', requiredContext: [], requiredTools: [] }] }, invocationId: 'planner', provider: 'offline', model: 'offline', fallbackUsed: false };
    }
    if (input.purpose === 'RISK_CLASSIFIER') {
      return { output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' }, invocationId: 'risk', provider: 'offline', model: 'offline', fallbackUsed: false };
    }
    const knowledge = Array.isArray(input.context?.knowledge) ? input.context.knowledge : [];
    return { output: { text: knowledge[0]?.answer ?? '无证据', requiresHuman: false }, invocationId: 'composer', provider: 'offline', model: 'offline', fallbackUsed: false };
  }
}

describe('Scenario Lab Case07 production-service evidence chain', () => {
  it('runs two shops concurrently through real ReplyRuntime + Hybrid RAG and persists only own-store evidence and trace', async () => {
    const harness = new Case07ProductionServiceHarness();
    const search = jest.spyOn(harness.knowledge, 'search');
    const service = harness.service();

    await expect(service.run(scope, 'two_shops')).resolves.toMatchObject({ status: 'ACCEPTED' });
    await Promise.resolve();

    expect(search).toHaveBeenCalledWith(
      { ...scope, shopId: 'shop-mia' },
      { shopId: 'shop-mia', query: '多久发货？', scope: 'STORE', topK: 3 },
    );
    expect(search).toHaveBeenCalledWith(
      { ...scope, shopId: 'shop-pixel' },
      { shopId: 'shop-pixel', query: '多久发货？', scope: 'STORE', topK: 3 },
    );

    const miaJob = harness.rowsFor('replyJob', { ...scope, shopId: 'shop-mia' })[0]!;
    const pixelJob = harness.rowsFor('replyJob', { ...scope, shopId: 'shop-pixel' })[0]!;
    const miaDraft = harness.rowsFor('replyDraft', { ...scope, replyJobId: miaJob.id })[0];
    const pixelDraft = harness.rowsFor('replyDraft', { ...scope, replyJobId: pixelJob.id })[0];
    expect(miaDraft?.aiDraft).toContain('MIA Fashion');
    expect(pixelDraft?.aiDraft).toContain('Pixel Tech');

    const miaEvidence = harness.rowsFor('replyEvidence', { ...scope, replyJobId: miaJob.id });
    const pixelEvidence = harness.rowsFor('replyEvidence', { ...scope, replyJobId: pixelJob.id });
    expect(miaEvidence).toEqual([expect.objectContaining({ shopId: 'shop-mia', knowledgeItemId: 'mia-shipping', knowledgeVersionId: 'mia-shipping-v1', scope: 'STORE' })]);
    expect(pixelEvidence).toEqual([expect.objectContaining({ shopId: 'shop-pixel', knowledgeItemId: 'pixel-shipping', knowledgeVersionId: 'pixel-shipping-v1', scope: 'STORE' })]);
    expect(new Set([...miaEvidence, ...pixelEvidence].map((entry) => entry.knowledgeItemId))).toEqual(new Set(['mia-shipping', 'pixel-shipping']));

    const traces = harness.rowsFor('traceEvent', { ...scope, stage: 'SCENARIO_CASE07_EVIDENCE' });
    expect(traces).toHaveLength(2);
    expect(traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ shopId: 'shop-mia', replyJobId: miaJob.id, payloadJson: expect.objectContaining({ knowledgeItemIds: ['mia-shipping'], knowledgeVersionIds: ['mia-shipping-v1'] }) }),
      expect.objectContaining({ shopId: 'shop-pixel', replyJobId: pixelJob.id, payloadJson: expect.objectContaining({ knowledgeItemIds: ['pixel-shipping'], knowledgeVersionIds: ['pixel-shipping-v1'] }) }),
    ]));
    expect(traces.every((trace) => !JSON.stringify(trace.payloadJson).includes(trace.shopId === 'shop-mia' ? 'pixel-shipping' : 'mia-shipping'))).toBe(true);
  });
});

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Row[]).some((part) => matches(row, part));
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('in' in condition) return (condition.in as unknown[]).includes(row[key]);
      if ('not' in condition) return row[key] !== condition.not;
      if ('lte' in condition) return row[key] <= condition.lte;
      if ('gt' in condition) return row[key] > condition.gt;
      return true;
    }
    return row[key] === condition;
  });
}

function orderBy(input: unknown): (left: Row, right: Row) => number {
  const entries = Array.isArray(input) ? input : input ? [input] : [];
  return (left, right) => {
    for (const entry of entries) {
      const [key, direction] = Object.entries(entry as Row)[0] ?? [];
      if (!key || left[key] === right[key]) continue;
      const result = left[key] > right[key] ? 1 : -1;
      return direction === 'desc' ? -result : result;
    }
    return 0;
  };
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) row[key] = Number(row[key] ?? 0) + Number(value.increment);
    else row[key] = value;
  }
  row.updatedAt = new Date();
}
