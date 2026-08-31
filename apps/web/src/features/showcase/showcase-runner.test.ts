import { describe, expect, it, vi } from 'vitest';
import type { ShowcaseCatalog, ShowcaseScenario } from '../../api';
import { runShowcaseScenario, type ShowcaseRunnerPort } from './showcase-runner';

const scenario: ShowcaseScenario = {
  id: 'SC-01-PRODUCT-CARE', order: 1, title: '商品知识有据回答', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_002',
  aiMode: 'AUTO_ALLOWED', objective: '真实商品知识',
  steps: [
    { actor: 'SYSTEM', action: 'RESET_SHOWCASE' },
    { actor: 'BUYER', action: 'SEND_GOODS_CARD', productKey: 'fashion_hoodie' },
    { actor: 'BUYER', action: 'SEND_TEXT', text: '这个可以放烘干机吗？' },
    { actor: 'SYSTEM', action: 'WAIT_FOR_BUYER_VISIBLE_REPLY', timeoutMs: 1000 },
  ], expected: {},
};

const catalog: ShowcaseCatalog = {
  version: '1.0', providerMode: 'OFFLINE', multimodalMode: 'FIXTURE', scenarios: [scenario],
  resources: {
    shops: [{ key: 'shop_mia_fashion', name: 'MIA Fashion' }],
    buyers: [{ key: 'buyer_002', externalBuyerId: 'dy_buyer_002' }],
    products: [{ key: 'fashion_hoodie', externalProductId: 'P-F-001' }],
    orders: [],
  },
};

function port(): ShowcaseRunnerPort {
  return {
    reset: vi.fn().mockResolvedValue({ shops: [{ id: 'shop-a', name: 'MIA Fashion' }] }),
    setShopMode: vi.fn().mockResolvedValue(undefined),
    buyers: vi.fn().mockResolvedValue([{ id: 'buyer-a', externalBuyerId: 'dy_buyer_002' }]),
    products: vi.fn().mockResolvedValue([{ id: 'product-a', externalProductId: 'P-F-001' }]),
    orders: vi.fn().mockResolvedValue([]),
    conversations: vi.fn().mockResolvedValue([{ id: 'conversation-a', buyerId: 'buyer-a' }]),
    conversation: vi.fn().mockResolvedValue({
      id: 'conversation-a', buyerId: 'buyer-a', messages: [
        { id: 'buyer-message', role: 'BUYER', status: 'ACTIVE', sequence: 1 },
        { id: 'reply-message', role: 'ASSISTANT', status: 'ACTIVE', sequence: 2 },
      ],
    }),
    productCard: vi.fn().mockResolvedValue({ conversationId: 'conversation-a' }),
    orderCard: vi.fn().mockResolvedValue({ conversationId: 'conversation-a' }),
    text: vi.fn().mockResolvedValue({ conversationId: 'conversation-a' }),
    image: vi.fn().mockResolvedValue({ conversationId: 'conversation-a' }),
    runStaleScenario: vi.fn().mockResolvedValue(undefined),
    scenarioSnapshot: vi.fn().mockResolvedValue(undefined),
    trace: vi.fn().mockResolvedValue({ traceId: 'trace-a', events: [] }),
    sleep: vi.fn().mockResolvedValue(undefined),
  } as unknown as ShowcaseRunnerPort;
}

describe('showcase runner', () => {
  it('executes the catalog actions through the injected real API boundary and observes a visible reply', async () => {
    const api = port();
    const updates: string[] = [];
    await expect(runShowcaseScenario(api, catalog, scenario, (update) => updates.push(update.status))).resolves.toMatchObject({
      status: 'COMPLETED', conversationId: 'conversation-a', trace: { traceId: 'trace-a' },
    });
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(api.setShopMode).toHaveBeenCalledWith('shop-a', 'AUTO_ALLOWED');
    expect(api.productCard).toHaveBeenCalledWith(expect.objectContaining({ shopId: 'shop-a', buyerId: 'buyer-a', productId: 'product-a' }));
    expect(api.text).toHaveBeenCalledWith(expect.objectContaining({ text: '这个可以放烘干机吗？', conversationId: 'conversation-a' }));
    expect(updates).toEqual(expect.arrayContaining(['PREPARING', 'RUNNING', 'WAITING_AI', 'COMPLETED']));
  });

  it('fails closed when the caller cancels before a business action', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runShowcaseScenario(port(), catalog, scenario, () => undefined, controller.signal)).rejects.toThrow('SHOWCASE_CANCELLED');
  });

  it('does not mistake a scheduled welcome for the scenario reply', async () => {
    const safeScenario: ShowcaseScenario = {
      id: 'SC-05-SAFE-GREETING', order: 5, title: '安全问候', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_002',
      aiMode: 'AUTO_ALLOWED', objective: '无需知识的安全问候',
      steps: [
        { actor: 'SYSTEM', action: 'RESET_SHOWCASE' },
        { actor: 'BUYER', action: 'SEND_TEXT', text: '你好！' },
        { actor: 'SYSTEM', action: 'WAIT_FOR_BUYER_VISIBLE_REPLY', timeoutMs: 1000 },
      ],
      expected: {
        tasks: ['SAFE_SOCIAL_GREETING'],
        mustContainSemantic: ['您好，我在的'],
        noKnowledgeEvidence: true,
        mustIncludeTraceStages: ['BUILT_IN_SAFE_REPLY', 'EVIDENCE', 'SEND_RECEIPT'],
      },
    };
    const api = port();
    const welcomeOnly = {
      id: 'conversation-a', buyerId: 'buyer-a', messages: [
        { id: 'buyer-message', role: 'BUYER', kind: 'TEXT', status: 'ACTIVE', sequence: 1, content: { text: '你好！' } },
        { id: 'welcome-message', role: 'ASSISTANT', kind: 'TEXT', status: 'ACTIVE', sequence: 2, content: { text: '欢迎光临 MIA Fashion，请问想了解哪款商品？' } },
      ],
    };
    const actualReply = {
      ...welcomeOnly,
      taskBundle: { tasks: [{ intent: 'SAFE_SOCIAL_GREETING' }] },
      messages: [
        ...welcomeOnly.messages,
        { id: 'reply-message', role: 'ASSISTANT', kind: 'TEXT', status: 'ACTIVE', sequence: 3, content: { text: '您好，我在的。您可以咨询商品、库存、订单、物流或售后问题。' } },
      ],
    };
    let reads = 0;
    vi.mocked(api.conversation).mockImplementation(async () => (++reads <= 3 ? welcomeOnly : actualReply) as never);
    vi.mocked(api.trace).mockResolvedValue({
      traceId: 'trace-safe',
      events: [
        { id: 'trace-1', stage: 'BUILT_IN_SAFE_REPLY', payload: { intent: 'GREETING' }, createdAt: new Date().toISOString() },
        { id: 'trace-turn', stage: 'USER_TURN', payload: { sourceMessageCount: 1 }, createdAt: new Date().toISOString() },
        { id: 'trace-tasks', stage: 'TASKS', payload: { tasks: [{ intent: 'SAFE_SOCIAL_GREETING', status: 'RESOLVED' }] }, createdAt: new Date().toISOString() },
        { id: 'trace-context', stage: 'CONTEXT', payload: { contexts: [] }, createdAt: new Date().toISOString() },
        { id: 'trace-2', stage: 'EVIDENCE', payload: { evidenceCount: 0 }, createdAt: new Date().toISOString() },
        { id: 'trace-policy', stage: 'REPLY_POLICY', payload: { mode: 'AUTO' }, createdAt: new Date().toISOString() },
        { id: 'trace-3', stage: 'SEND_RECEIPT', payload: { status: 'SENT' }, createdAt: new Date().toISOString() },
      ],
    } as never);

    await expect(runShowcaseScenario(api, { ...catalog, scenarios: [safeScenario] }, safeScenario, () => undefined)).resolves.toMatchObject({
      status: 'COMPLETED', conversationId: 'conversation-a', trace: { traceId: 'trace-safe' },
    });
    expect(reads).toBeGreaterThan(3);
  });

  it('rejects a product-care run when the final durable policy is not the catalog terminal mode', async () => {
    const api = port();
    const automaticConversation = {
      id: 'conversation-a', buyerId: 'buyer-a', currentProductId: 'product-a', messages: [
        { id: 'buyer-message', role: 'BUYER', kind: 'TEXT', status: 'ACTIVE', sequence: 1, content: { text: '这个可以放烘干机吗？' } },
        { id: 'reply-message', role: 'ASSISTANT', kind: 'TEXT', status: 'ACTIVE', sequence: 2, content: { text: '不建议使用烘干机。' } },
      ], taskBundle: { tasks: [{ intent: 'PRODUCT_QUERY' }] },
    };
    vi.mocked(api.conversation).mockResolvedValue(automaticConversation as never);
    vi.mocked(api.trace).mockResolvedValue(traceWith({ policyMode: 'MANUAL' }) as never);
    const policyScenario = {
      ...scenario,
      expected: {
        tasks: ['PRODUCT_QUERY'],
        terminalMode: 'AUTO',
        mustIncludeTraceStages: canonicalAutoStages,
      },
    };

    await expect(runShowcaseScenario(api, { ...catalog, scenarios: [policyScenario] }, policyScenario, () => undefined))
      .rejects.toThrow('SHOWCASE_TERMINAL_MODE_MISMATCH:MANUAL/AUTO');
  });

  it('rejects a product-care run when the resolved product context differs from the catalog product', async () => {
    const api = port();
    vi.mocked(api.conversation).mockResolvedValue({
      id: 'conversation-a', buyerId: 'buyer-a', currentProductId: 'another-product', messages: [
        { id: 'buyer-message', role: 'BUYER', kind: 'TEXT', status: 'ACTIVE', sequence: 1, content: { text: '这个可以放烘干机吗？' } },
        { id: 'reply-message', role: 'ASSISTANT', kind: 'TEXT', status: 'ACTIVE', sequence: 2, content: { text: '不建议使用烘干机。' } },
      ], taskBundle: { tasks: [{ intent: 'PRODUCT_QUERY' }] },
    } as never);
    vi.mocked(api.trace).mockResolvedValue(traceWith() as never);
    const contextScenario = {
      ...scenario,
      expected: {
        tasks: ['PRODUCT_QUERY'],
        context: { productKey: 'fashion_hoodie' },
        terminalMode: 'AUTO',
        mustIncludeTraceStages: canonicalAutoStages,
      },
    };

    await expect(runShowcaseScenario(api, { ...catalog, scenarios: [contextScenario] }, contextScenario, () => undefined))
      .rejects.toThrow('SHOWCASE_CONTEXT_PRODUCT_MISMATCH');
  });

  it('validates product evidence from immutable trace refs when the current knowledge projection is empty', async () => {
    const api = port() as ShowcaseRunnerPort & { knowledge: ReturnType<typeof vi.fn> };
    api.knowledge = vi.fn().mockResolvedValue([]);
    vi.mocked(api.conversation).mockResolvedValue({
      id: 'conversation-a', buyerId: 'buyer-a', currentProductId: 'product-a', messages: [
        { id: 'buyer-message', role: 'BUYER', kind: 'TEXT', status: 'ACTIVE', sequence: 1, content: { text: '这个可以放烘干机吗？' } },
        { id: 'reply-message', role: 'ASSISTANT', kind: 'TEXT', status: 'ACTIVE', sequence: 2, content: { text: '不建议使用烘干机。' } },
      ], taskBundle: { tasks: [{ intent: 'PRODUCT_QUERY' }] },
    } as never);
    vi.mocked(api.trace).mockResolvedValue(traceWith() as never);
    const evidenceScenario = {
      ...scenario,
      expected: {
        tasks: ['PRODUCT_QUERY'],
        context: { productKey: 'fashion_hoodie' },
        terminalMode: 'AUTO',
        evidence: { minimumCount: 1, mustIncludeScopes: ['PRODUCT'], productKey: 'fashion_hoodie' },
        mustIncludeTraceStages: canonicalAutoStages,
      },
    };

    await expect(runShowcaseScenario(api, { ...catalog, scenarios: [evidenceScenario] }, evidenceScenario, () => undefined))
      .resolves.toMatchObject({ status: 'COMPLETED', conversationId: 'conversation-a' });
    expect(api.knowledge).not.toHaveBeenCalled();
  });

  it('rejects a product-care run when frozen evidence does not come from the required product scope', async () => {
    const api = port() as ShowcaseRunnerPort & { knowledge: ReturnType<typeof vi.fn> };
    api.knowledge = vi.fn().mockResolvedValue([]);
    vi.mocked(api.conversation).mockResolvedValue({
      id: 'conversation-a', buyerId: 'buyer-a', currentProductId: 'product-a', messages: [
        { id: 'buyer-message', role: 'BUYER', kind: 'TEXT', status: 'ACTIVE', sequence: 1, content: { text: '这个可以放烘干机吗？' } },
        { id: 'reply-message', role: 'ASSISTANT', kind: 'TEXT', status: 'ACTIVE', sequence: 2, content: { text: '不建议使用烘干机。' } },
      ], taskBundle: { tasks: [{ intent: 'PRODUCT_QUERY' }] },
    } as never);
    vi.mocked(api.trace).mockResolvedValue(traceWith({
      evidenceVersionIds: ['version-store'],
      evidenceRefs: [{ itemId: 'knowledge-store', versionId: 'version-store', scope: 'STORE', productId: null }],
    }) as never);
    const evidenceScenario = {
      ...scenario,
      expected: {
        tasks: ['PRODUCT_QUERY'],
        terminalMode: 'AUTO',
        evidence: { minimumCount: 1, mustIncludeScopes: ['PRODUCT'], productKey: 'fashion_hoodie' },
        mustIncludeTraceStages: canonicalAutoStages,
      },
    };

    await expect(runShowcaseScenario(api, { ...catalog, scenarios: [evidenceScenario] }, evidenceScenario, () => undefined))
      .rejects.toThrow('SHOWCASE_EVIDENCE_SCOPE_MISSING:PRODUCT');
  });

  it('rejects a manual handoff scenario when no waiting-human artifact is observable', async () => {
    const api = port();
    vi.mocked(api.conversation).mockResolvedValue({
      id: 'conversation-a', buyerId: 'buyer-a', effectiveMode: 'AUTO', humanActive: false, messages: [],
    } as never);
    const handoffScenario: ShowcaseScenario = {
      ...scenario,
      id: 'SC-04-IMAGE-HUMAN',
      steps: [{ actor: 'SYSTEM', action: 'RESET_SHOWCASE' }],
      expected: { requiresHuman: true },
    };

    await expect(runShowcaseScenario(api, { ...catalog, scenarios: [handoffScenario] }, handoffScenario, () => undefined))
      .rejects.toThrow('SHOWCASE_HUMAN_HANDOFF_MISSING');
  });

  it('rejects the stale-replan scenario when an old reply was sent before the latest buyer message', async () => {
    const api = port();
    vi.mocked(api.scenarioSnapshot).mockResolvedValue({
      key: 'message_during_generation', status: 'SUCCEEDED', synthetic: true,
      steps: [{ key: 'invalidate', label: '旧任务失效', status: 'SUCCEEDED' }],
    } as never);
    vi.mocked(api.conversation).mockResolvedValue({
      id: 'conversation-a', buyerId: 'buyer-a', messages: [
        { id: 'first-buyer', role: 'BUYER', kind: 'TEXT', status: 'ACTIVE', sequence: 1, content: { text: '什么时候发货？' } },
        { id: 'stale-reply', role: 'ASSISTANT', kind: 'TEXT', status: 'ACTIVE', sequence: 2, content: { text: '今天发货。' } },
        { id: 'second-buyer', role: 'BUYER', kind: 'TEXT', status: 'ACTIVE', sequence: 3, content: { text: '我是新疆的。' } },
        { id: 'fresh-reply', role: 'ASSISTANT', kind: 'TEXT', status: 'ACTIVE', sequence: 4, content: { text: '偏远地区以实际物流信息为准。' } },
      ],
    } as never);
    const staleScenario: ShowcaseScenario = {
      ...scenario,
      id: 'SC-03-STALE-REPLAN',
      expected: { oldReplyMustNotBeSent: true, mustContainSemantic: ['偏远地区'] },
    };

    await expect(runShowcaseScenario(api, { ...catalog, scenarios: [staleScenario] }, staleScenario, () => undefined))
      .rejects.toThrow('SHOWCASE_OLD_REPLY_WAS_SENT');
  });

  it('rejects legacy trace expectations before performing any runtime action', async () => {
    const api = port();
    const unobservableScenario: ShowcaseScenario = {
      ...scenario,
      expected: { trace: ['CONTEXT_VERSION_CHANGED'] },
    };

    await expect(runShowcaseScenario(api, { ...catalog, scenarios: [unobservableScenario] }, unobservableScenario, () => undefined))
      .rejects.toThrow('SHOWCASE_UNVERIFIABLE_EXPECTATION:trace');
    expect(api.reset).not.toHaveBeenCalled();
  });
});

const canonicalAutoStages = ['USER_TURN', 'TASKS', 'CONTEXT', 'EVIDENCE', 'REPLY_POLICY', 'SEND_GUARD', 'SEND_RECEIPT'];

function traceWith(input: {
  policyMode?: string;
  evidenceVersionIds?: string[];
  evidenceRefs?: Array<{ itemId: string; versionId: string; scope: string; productId: string | null }>;
} = {}) {
  const policyMode = input.policyMode ?? 'AUTO';
  const evidenceVersionIds = input.evidenceVersionIds ?? ['version-product'];
  const evidenceRefs = input.evidenceRefs ?? evidenceVersionIds.map((versionId) => ({
    itemId: 'knowledge-product', versionId, scope: 'PRODUCT', productId: 'product-a',
  }));
  return {
    traceId: 'trace-canonical',
    events: [
      { id: 'turn', stage: 'USER_TURN', payload: { sourceMessageCount: 1 }, createdAt: new Date().toISOString() },
      { id: 'tasks', stage: 'TASKS', payload: { tasks: [{ intent: 'PRODUCT_QUERY', status: 'RESOLVED' }] }, createdAt: new Date().toISOString() },
      { id: 'context', stage: 'CONTEXT', payload: { contexts: [{ entitySelected: true, status: 'RESOLVED' }] }, createdAt: new Date().toISOString() },
      { id: 'evidence', stage: 'EVIDENCE', payload: { evidenceCount: evidenceVersionIds.length, knowledgeVersionIds: evidenceVersionIds, evidenceRefs }, createdAt: new Date().toISOString() },
      { id: 'policy', stage: 'REPLY_POLICY', payload: { mode: policyMode }, createdAt: new Date().toISOString() },
      { id: 'guard', stage: 'SEND_GUARD', payload: { allowed: true, phase: 'TRANSPORT_FENCE' }, createdAt: new Date().toISOString() },
      { id: 'receipt', stage: 'SEND_RECEIPT', payload: { status: 'SENT' }, createdAt: new Date().toISOString() },
    ],
  };
}
