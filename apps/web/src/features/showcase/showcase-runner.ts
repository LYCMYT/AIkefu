import type {
  BootstrapPayload,
  Buyer,
  Conversation,
  DeveloperTrace,
  MutationResult,
  Order,
  Product,
  Scenario,
  ShowcaseCatalog,
  ShowcaseRunStatus,
  ShowcaseScenario,
} from '../../api';
import {
  getBootstrap,
  getBuyers,
  getConversation,
  getConversationTrace,
  getConversations,
  getOrders,
  getProducts,
  getScenarios,
  resetCurrentWorkspace,
  runScenario,
  sendBuyerMessage,
  sendBuyerOrderCard,
  sendBuyerProductCard,
  sendShowcaseDamageImage,
  updateShopAiMode,
} from '../../api';

export interface ShowcaseRunUpdate {
  status: ShowcaseRunStatus;
  message: string;
  conversationId?: string;
}

export interface ShowcaseRunResult {
  status: 'COMPLETED';
  conversationId?: string;
  trace?: DeveloperTrace;
}

export interface ShowcaseRunnerPort {
  reset(): Promise<BootstrapPayload>;
  setShopMode(shopId: string, mode: ShowcaseScenario['aiMode']): Promise<void>;
  buyers(shopId: string): Promise<Buyer[]>;
  products(shopId: string): Promise<Product[]>;
  orders(shopId: string, buyerId: string): Promise<Order[]>;
  conversations(shopId: string): Promise<Conversation[]>;
  conversation(conversationId: string): Promise<Conversation>;
  productCard(input: { shopId: string; buyerId: string; productId: string; conversationId?: string }): Promise<MutationResult>;
  orderCard(input: { shopId: string; buyerId: string; orderId: string; conversationId?: string }): Promise<MutationResult>;
  text(input: { shopId: string; buyerId: string; text: string; conversationId?: string }): Promise<MutationResult>;
  image(input: { shopId: string; buyerId: string; conversationId?: string }): Promise<MutationResult>;
  runStaleScenario(): Promise<void>;
  scenarioSnapshot(): Promise<Scenario | undefined>;
  trace(conversationId: string): Promise<DeveloperTrace>;
  sleep(ms: number): Promise<void>;
}

export function createShowcaseRunnerPort(token: string): ShowcaseRunnerPort {
  return {
    async reset() {
      await resetCurrentWorkspace(token, { profile: 'SEEDED' });
      return getBootstrap(token);
    },
    async setShopMode(shopId, mode) { await updateShopAiMode(token, shopId, mode); },
    buyers: (shopId) => getBuyers(token, shopId),
    products: (shopId) => getProducts(token, shopId),
    orders: (shopId, buyerId) => getOrders(token, shopId, buyerId),
    conversations: (shopId) => getConversations(token, shopId),
    conversation: (conversationId) => getConversation(token, conversationId),
    productCard: (input) => sendBuyerProductCard(token, input),
    orderCard: (input) => sendBuyerOrderCard(token, input),
    text: (input) => sendBuyerMessage(token, input),
    image: (input) => sendShowcaseDamageImage(token, input),
    async runStaleScenario() { await runScenario(token, 'message_during_generation'); },
    async scenarioSnapshot() { return (await getScenarios(token)).find((entry) => entry.key === 'message_during_generation'); },
    trace: (conversationId) => getConversationTrace(token, conversationId),
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
  };
}

export async function runShowcaseScenario(
  port: ShowcaseRunnerPort,
  catalog: ShowcaseCatalog,
  scenario: ShowcaseScenario,
  onUpdate: (update: ShowcaseRunUpdate) => void,
  signal?: AbortSignal,
): Promise<ShowcaseRunResult> {
  assertVerifiableExpectations(scenario);
  onUpdate({ status: 'PREPARING', message: '正在恢复独立 Showcase 数据。' });
  const bootstrap = await port.reset();
  assertActive(signal);
  const shopResource = catalog.resources.shops.find((entry) => entry.key === scenario.shopKey);
  const shop = bootstrap.shops.find((entry) => entry.name === shopResource?.name);
  if (!shop) throw new Error('SHOWCASE_SHOP_NOT_FOUND');
  await port.setShopMode(shop.id, scenario.aiMode);
  const buyerResource = catalog.resources.buyers.find((entry) => entry.key === scenario.buyerKey);
  const buyer = (await port.buyers(shop.id)).find((entry) => entry.externalBuyerId === buyerResource?.externalBuyerId);
  if (!buyer) throw new Error('SHOWCASE_BUYER_NOT_FOUND');
  const bindings: ScenarioResourceBindings = { productIds: new Map(), orderIds: new Map() };
  onUpdate({ status: 'RUNNING', message: '独立数据已恢复，正在执行真实业务动作。' });

  if (scenario.id === 'SC-03-STALE-REPLAN') {
    await port.runStaleScenario();
    await waitUntil(port, async () => {
      const snapshot = await port.scenarioSnapshot();
      if (snapshot?.status === 'FAILED') throw new Error(snapshot.steps?.find((step) => step.status === 'FAILED')?.actual ?? 'STALE_REPLAN_FAILED');
      return snapshot?.status === 'SUCCEEDED';
    }, 60_000, signal);
    const conversationId = (await port.conversations(shop.id)).find((entry) => entry.buyerId === buyer.id)?.id;
    if (!conversationId) throw new Error('SHOWCASE_CONVERSATION_NOT_FOUND');
    const finalConversation = await port.conversation(conversationId);
    const trace = await safeTrace(port, conversationId, requiredTraceStages(scenario));
    assertScenarioLabSteps(await port.scenarioSnapshot());
    await assertScenarioEvidence({
      scenario,
      conversation: finalConversation,
      taskIntents: taskIntentsFromConversation(finalConversation),
      texts: customerFacingTextFromConversation(finalConversation),
      trace,
      bindings,
    });
    onUpdate({ status: 'COMPLETED', message: '旧回复已失效，新回复通过发送守卫。', conversationId });
    return { status: 'COMPLETED', conversationId, trace };
  }

  let conversationId = '';
  const observedTaskIntents = new Set<string>();
  const observedCustomerFacingText: string[] = [];
  let firstReplyBuyerTextCount: number | undefined;
  let offPeriodBuyerSequence: number | undefined;
  for (const step of scenario.steps) {
    assertActive(signal);
    if (step.action === 'RESET_SHOWCASE') continue;
    const delayMs = typeof step.delayMs === 'number' ? step.delayMs : 0;
    if (delayMs > 0) await port.sleep(delayMs);
    if (step.action === 'SET_SHOP_AI_MODE') {
      const mode = shopAiMode(step.mode);
      if (!mode) throw new Error('SHOWCASE_SHOP_AI_MODE_INVALID');
      await port.setShopMode(shop.id, mode);
      onUpdate({
        status: 'RUNNING',
        message: mode === 'MANUAL_ONLY' ? '店铺 AI 已关闭，当前入站消息仅由人工处理。' : '店铺 AI 已重新开启，后续新消息可进入真实回复链路。',
        conversationId: conversationId || undefined,
      });
    } else if (step.action === 'SEND_GOODS_CARD') {
      const resource = catalog.resources.products.find((entry) => entry.key === step.productKey);
      const product = (await port.products(shop.id)).find((entry) => entry.externalProductId === resource?.externalProductId);
      if (!product) throw new Error('SHOWCASE_PRODUCT_NOT_FOUND');
      if (typeof step.productKey === 'string') bindings.productIds.set(step.productKey, product.id);
      conversationId = mutationConversationId(await port.productCard({ shopId: shop.id, buyerId: buyer.id, productId: product.id, ...(conversationId ? { conversationId } : {}) })) || conversationId;
    } else if (step.action === 'SEND_ORDER_CARD') {
      const resource = catalog.resources.orders.find((entry) => entry.key === step.orderKey);
      const order = (await port.orders(shop.id, buyer.id)).find((entry) => entry.externalOrderId === resource?.externalOrderId);
      if (!order) throw new Error('SHOWCASE_ORDER_NOT_FOUND');
      if (typeof step.orderKey === 'string') bindings.orderIds.set(step.orderKey, order.id);
      conversationId = mutationConversationId(await port.orderCard({ shopId: shop.id, buyerId: buyer.id, orderId: order.id, ...(conversationId ? { conversationId } : {}) })) || conversationId;
    } else if (step.action === 'UPLOAD_IMAGE') {
      onUpdate({ status: 'RUNNING', message: '正在上传明确标识的多模态 Fixture。', conversationId });
      conversationId = mutationConversationId(await port.image({ shopId: shop.id, buyerId: buyer.id, ...(conversationId ? { conversationId } : {}) })) || conversationId;
    } else if (step.action === 'SEND_TEXT') {
      const text = typeof step.text === 'string' ? step.text : '';
      conversationId = mutationConversationId(await port.text({ shopId: shop.id, buyerId: buyer.id, text, ...(conversationId ? { conversationId } : {}) })) || conversationId;
    } else if (step.action === 'WAIT_FOR_BUYER_VISIBLE_REPLY') {
      onUpdate({ status: 'WAITING_AI', message: 'AI 正在检索证据并等待真实发送回执。', conversationId });
      conversationId ||= await resolveConversationId(port, shop.id, buyer.id, signal);
      const expectedSemantic = stringList(scenario.expected.mustContainSemantic);
      await waitUntil(
        port,
        async () => hasBuyerVisibleReply(await port.conversation(conversationId), expectedSemantic),
        timeout(step),
        signal,
      );
      observeConversation(await port.conversation(conversationId), observedTaskIntents, observedCustomerFacingText);
    } else if (step.action === 'WAIT_FOR_REPLY_DRAFT') {
      onUpdate({ status: 'WAITING_HUMAN', message: '正在等待可审核的真实回复草稿。', conversationId });
      conversationId ||= await resolveConversationId(port, shop.id, buyer.id, signal);
      await waitUntil(port, async () => hasReplyDraft(await port.conversation(conversationId)), timeout(step), signal);
      const snapshot = await port.conversation(conversationId);
      if (firstReplyBuyerTextCount === undefined) {
        firstReplyBuyerTextCount = (snapshot.messages ?? []).filter((message) => message.role === 'BUYER' && message.kind === 'TEXT' && !['RECALLED', 'DELETED'].includes(message.status ?? '')).length;
      }
      observeConversation(snapshot, observedTaskIntents, observedCustomerFacingText);
    } else if (step.action === 'WAIT_FOR_CONVERSATION_MODE') {
      onUpdate({ status: 'WAITING_HUMAN', message: '高风险请求正在进入人工处理。', conversationId });
      conversationId ||= await resolveConversationId(port, shop.id, buyer.id, signal);
      await waitUntil(port, async () => isHumanConversation(await port.conversation(conversationId)), timeout(step), signal);
      observeConversation(await port.conversation(conversationId), observedTaskIntents, observedCustomerFacingText);
    } else if (step.action === 'WAIT_FOR_REPLY_JOB_STATUS') {
      conversationId ||= await resolveConversationId(port, shop.id, buyer.id, signal);
      await waitUntil(port, async () => (await port.conversation(conversationId)).activeReplyJob?.status === step.status, timeout(step), signal);
    } else if (step.action === 'WAIT_FOR_NO_AI_ARTIFACTS') {
      conversationId ||= await resolveConversationId(port, shop.id, buyer.id, signal);
      let settled: Conversation | undefined;
      await waitUntil(port, async () => {
        const snapshot = await port.conversation(conversationId);
        if (!hasCommittedLatestBuyerTurn(snapshot) || !hasNoAiArtifacts(snapshot)) return false;
        settled = snapshot;
        return true;
      }, timeout(step), signal);
      const settleMs = boundedSettleMs(step.settleMs);
      if (settleMs > 0) await port.sleep(settleMs);
      settled = await port.conversation(conversationId);
      if (!hasNoAiArtifacts(settled)) throw new Error('SHOWCASE_AI_ARTIFACT_CREATED_WHILE_OFF');
      offPeriodBuyerSequence = latestBuyerSequence(settled);
      if (offPeriodBuyerSequence === undefined) throw new Error('SHOWCASE_OFF_PERIOD_BUYER_MISSING');
      onUpdate({ status: 'RUNNING', message: '已确认关闭期间未创建 AI Job、Draft 或 Outbox。', conversationId });
    }
  }
  conversationId ||= await resolveConversationId(port, shop.id, buyer.id, signal);
  const finalConversation = await port.conversation(conversationId);
  observeConversation(finalConversation, observedTaskIntents, observedCustomerFacingText);
  const trace = await safeTrace(port, conversationId, requiredTraceStages(scenario));
  await assertScenarioEvidence({
    scenario,
    conversation: finalConversation,
    taskIntents: observedTaskIntents,
    texts: observedCustomerFacingText,
    firstReplyBuyerTextCount,
    trace,
    bindings,
  });
  if (scenario.expected.noAiArtifactsBeforeFutureMessage === true) {
    assertFutureOnlyReply(finalConversation, offPeriodBuyerSequence);
  }
  onUpdate({
    status: 'COMPLETED',
    message: scenario.id === 'SC-04-IMAGE-HUMAN'
      ? '高风险售后已进入人工，未执行退款动作。'
      : scenario.id === 'SC-06-SHOP-AI-OFF'
        ? '关闭期间未产生 AI Job、Draft 或 Outbox；重新开启后仅处理新的买家消息。'
        : '场景已通过真实消息链路完成。',
    conversationId,
  });
  return { status: 'COMPLETED', conversationId, trace };
}

function observeConversation(conversation: Conversation, taskIntents: Set<string>, texts: string[]): void {
  for (const task of conversation.taskBundle?.tasks ?? []) taskIntents.add(task.intent);
  for (const message of conversation.messages ?? []) {
    if (!['AI', 'ASSISTANT', 'HUMAN'].includes(message.role ?? '')) continue;
    const content = message.content as Record<string, unknown> | undefined;
    const text = typeof content?.text === 'string' ? content.text.trim() : '';
    if (text) texts.push(text);
  }
  const draft = conversation.currentDraft ?? conversation.activeReplyJob?.currentDraft ?? conversation.activeReplyJob?.draft;
  if (draft?.aiDraft.trim()) texts.push(draft.aiDraft.trim());
}

function taskIntentsFromConversation(conversation: Conversation): Set<string> {
  const intents = new Set<string>();
  observeConversation(conversation, intents, []);
  return intents;
}

function customerFacingTextFromConversation(conversation: Conversation): string[] {
  const texts: string[] = [];
  observeConversation(conversation, new Set<string>(), texts);
  return texts;
}

interface ScenarioResourceBindings {
  productIds: Map<string, string>;
  orderIds: Map<string, string>;
}

interface ScenarioEvidenceInput {
  scenario: ShowcaseScenario;
  conversation: Conversation;
  taskIntents: Set<string>;
  texts: string[];
  firstReplyBuyerTextCount?: number;
  trace?: DeveloperTrace;
  bindings: ScenarioResourceBindings;
}

async function assertScenarioEvidence(input: ScenarioEvidenceInput): Promise<void> {
  const { scenario, conversation, taskIntents, texts, firstReplyBuyerTextCount, trace, bindings } = input;
  const expectedTasks = stringList(scenario.expected.tasks);
  for (const task of expectedTasks) {
    if (!taskIntents.has(task)) throw new Error(`SHOWCASE_EXPECTED_TASK_MISSING:${task}`);
  }
  const customerText = texts.join('\n');
  for (const phrase of stringList(scenario.expected.mustContainSemantic)) {
    if (!semanticContains(customerText, phrase)) throw new Error(`SHOWCASE_EXPECTED_SEMANTIC_MISSING:${phrase}`);
  }
  for (const phrase of stringList(scenario.expected.forbiddenSemanticClaims)) {
    if (semanticContains(customerText, phrase)) throw new Error(`SHOWCASE_FORBIDDEN_SEMANTIC:${phrase}`);
  }
  const expectedBuyerTexts = scenario.expected.rawMessageCountBeforeFirstTurn;
  if (typeof expectedBuyerTexts === 'number' && firstReplyBuyerTextCount !== expectedBuyerTexts) {
    throw new Error(`SHOWCASE_RAW_MESSAGE_COUNT:${firstReplyBuyerTextCount ?? 0}/${expectedBuyerTexts}`);
  }
  assertTraceStages(trace, requiredTraceStages(scenario));
  assertExpectedContext(scenario, conversation, trace, bindings);
  assertTerminalMode(scenario, trace);
  assertHumanRequirement(scenario, conversation);
  assertOldReplyWasNotSent(scenario, conversation);
  if (scenario.expected.noKnowledgeEvidence === true) {
    const latestEvidence = latestTracePayload(trace, 'EVIDENCE');
    if (!latestEvidence || latestEvidence.evidenceCount !== 0) throw new Error('SHOWCASE_SAFE_REPLY_USED_KNOWLEDGE');
  }
  assertExpectedEvidence(scenario, trace, bindings);
}

function assertVerifiableExpectations(scenario: ShowcaseScenario): void {
  const unsupported = [
    'knowledgeKeys',
    'supportingKnowledgeKeys',
    'knowledgeScope',
    'trace',
    'dynamicContext',
    'customerMemoryKey',
    'mustNotRepeatSupersededBlackQuestion',
    'staleReason',
  ];
  for (const key of unsupported) {
    if (scenario.expected[key] !== undefined) throw new Error(`SHOWCASE_UNVERIFIABLE_EXPECTATION:${key}`);
  }
}

function requiredTraceStages(scenario: ShowcaseScenario): string[] {
  const required = new Set(stringList(scenario.expected.mustIncludeTraceStages));
  if (stringList(scenario.expected.tasks).length > 0) required.add('TASKS');
  if (record(scenario.expected.context)) required.add('CONTEXT');
  if (record(scenario.expected.evidence) || scenario.expected.noKnowledgeEvidence === true) required.add('EVIDENCE');
  if (expectedMode(scenario.expected.terminalMode)) required.add('REPLY_POLICY');
  return [...required];
}

function assertTraceStages(trace: DeveloperTrace | undefined, required: string[]): void {
  for (const stage of required) {
    if (!trace?.events.some((event) => event.stage === stage)) throw new Error(`SHOWCASE_EXPECTED_TRACE_MISSING:${stage}`);
  }
}

function assertExpectedContext(
  scenario: ShowcaseScenario,
  conversation: Conversation,
  trace: DeveloperTrace | undefined,
  bindings: ScenarioResourceBindings,
): void {
  const expected = record(scenario.expected.context);
  if (!expected) return;
  const selectedContext = latestTracePayload(trace, 'CONTEXT');
  const contexts = Array.isArray(selectedContext?.contexts) ? selectedContext.contexts : [];
  if (!contexts.some((entry) => record(entry)?.entitySelected === true)) throw new Error('SHOWCASE_CONTEXT_ENTITY_NOT_SELECTED');
  const productKey = stringValue(expected.productKey);
  if (productKey) {
    const productId = bindings.productIds.get(productKey);
    if (!productId) throw new Error(`SHOWCASE_CONTEXT_PRODUCT_RESOURCE_UNOBSERVED:${productKey}`);
    if (conversation.currentProductId !== productId) throw new Error('SHOWCASE_CONTEXT_PRODUCT_MISMATCH');
  }
  const orderKey = stringValue(expected.orderKey);
  if (orderKey) {
    const orderId = bindings.orderIds.get(orderKey);
    if (!orderId) throw new Error(`SHOWCASE_CONTEXT_ORDER_RESOURCE_UNOBSERVED:${orderKey}`);
    if (conversation.currentOrderId !== orderId) throw new Error('SHOWCASE_CONTEXT_ORDER_MISMATCH');
  }
}

function assertTerminalMode(scenario: ShowcaseScenario, trace: DeveloperTrace | undefined): void {
  const expected = expectedMode(scenario.expected.terminalMode);
  if (!expected) return;
  const observed = expectedMode(latestTracePayload(trace, 'REPLY_POLICY')?.mode);
  if (!observed) throw new Error('SHOWCASE_TERMINAL_POLICY_MISSING');
  if (observed !== expected) throw new Error(`SHOWCASE_TERMINAL_MODE_MISMATCH:${observed}/${expected}`);
}

function assertHumanRequirement(scenario: ShowcaseScenario, conversation: Conversation): void {
  if (scenario.expected.requiresHuman !== true) return;
  const waiting = conversation.activeReplyJob?.status === 'WAITING_HUMAN' && Boolean(conversation.currentDraft ?? conversation.activeReplyJob?.currentDraft ?? conversation.activeReplyJob?.draft);
  const manual = conversation.humanActive === true || conversation.effectiveMode === 'MANUAL';
  if (!waiting && !manual) throw new Error('SHOWCASE_HUMAN_HANDOFF_MISSING');
  const latestBuyer = latestBuyerSequence(conversation);
  const autoReply = latestBuyer === undefined ? undefined : (conversation.messages ?? []).find((message) => (
    ['AI', 'ASSISTANT'].includes(message.role ?? '')
    && (message.sequence ?? 0) > latestBuyer
    && !['RECALLED', 'DELETED'].includes(message.status ?? '')
  ));
  if (autoReply) throw new Error('SHOWCASE_HUMAN_SCENARIO_AUTO_SENT');
}

function assertOldReplyWasNotSent(scenario: ShowcaseScenario, conversation: Conversation): void {
  if (scenario.expected.oldReplyMustNotBeSent !== true) return;
  const buyers = (conversation.messages ?? [])
    .filter((message) => message.role === 'BUYER' && !['RECALLED', 'DELETED'].includes(message.status ?? ''))
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  if (buyers.length < 2) throw new Error('SHOWCASE_STALE_REPLAN_BUYER_TURNS_MISSING');
  const latestBuyer = buyers.at(-1)!;
  const oldReply = (conversation.messages ?? []).find((message) => (
    ['AI', 'ASSISTANT'].includes(message.role ?? '')
    && !['RECALLED', 'DELETED'].includes(message.status ?? '')
    && (message.sequence ?? 0) > (buyers[0]?.sequence ?? 0)
    && (message.sequence ?? 0) < (latestBuyer.sequence ?? 0)
  ));
  if (oldReply) throw new Error('SHOWCASE_OLD_REPLY_WAS_SENT');
}

function assertExpectedEvidence(
  scenario: ShowcaseScenario,
  trace: DeveloperTrace | undefined,
  bindings: ScenarioResourceBindings,
): void {
  const expected = record(scenario.expected.evidence);
  if (!expected) return;
  const minimumCount = nonNegativeInteger(expected.minimumCount, 'SHOWCASE_EVIDENCE_MINIMUM_INVALID');
  const payload = [...(trace?.events ?? [])]
    .reverse()
    .filter((event) => event.stage === 'EVIDENCE')
    .map((event) => record(event.payload))
    .find((entry) => {
      const count = typeof entry?.evidenceCount === 'number' ? entry.evidenceCount : -1;
      return count >= minimumCount && stringList(entry?.knowledgeVersionIds).length >= minimumCount;
  });
  if (!payload) throw new Error(`SHOWCASE_EVIDENCE_COUNT_MISMATCH:0/${minimumCount}`);
  const versionIds = stringList(payload.knowledgeVersionIds);
  const rawRefs = Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : [];
  const evidence = rawRefs.map(frozenEvidenceRef).filter((entry): entry is FrozenEvidenceRef => Boolean(entry));
  if (evidence.length !== versionIds.length || evidence.some((entry) => !versionIds.includes(entry.versionId))) {
    throw new Error('SHOWCASE_EVIDENCE_VERSION_UNRESOLVED');
  }
  for (const scope of stringList(expected.mustIncludeScopes)) {
    if (!evidence.some((item) => item.scope === scope)) throw new Error(`SHOWCASE_EVIDENCE_SCOPE_MISSING:${scope}`);
  }
  const productKey = stringValue(expected.productKey);
  if (productKey) {
    const productId = bindings.productIds.get(productKey);
    if (!productId) throw new Error(`SHOWCASE_EVIDENCE_PRODUCT_RESOURCE_UNOBSERVED:${productKey}`);
    if (!evidence.some((item) => item.scope === 'PRODUCT' && item.productId === productId)) {
      throw new Error('SHOWCASE_EVIDENCE_PRODUCT_MISMATCH');
    }
  }
}

function assertScenarioLabSteps(snapshot: Scenario | undefined): void {
  if (!snapshot || snapshot.status !== 'SUCCEEDED') throw new Error('STALE_REPLAN_FAILED');
  if (!snapshot.steps?.length || snapshot.steps.some((step) => step.status !== 'SUCCEEDED')) {
    throw new Error('SHOWCASE_STALE_REPLAN_STEPS_INCOMPLETE');
  }
}

function latestTracePayload(trace: DeveloperTrace | undefined, stage: string): Record<string, unknown> | undefined {
  return record([...((trace?.events) ?? [])].reverse().find((event) => event.stage === stage)?.payload);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function expectedMode(value: unknown): 'AUTO' | 'ASSIST' | 'MANUAL' | undefined {
  return value === 'AUTO' || value === 'ASSIST' || value === 'MANUAL' ? value : undefined;
}

function nonNegativeInteger(value: unknown, error: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(error);
  return value;
}

interface FrozenEvidenceRef {
  itemId: string;
  versionId: string;
  scope: string;
  productId: string | null;
}

function frozenEvidenceRef(value: unknown): FrozenEvidenceRef | undefined {
  const candidate = record(value);
  const itemId = stringValue(candidate?.itemId);
  const versionId = stringValue(candidate?.versionId);
  const scope = stringValue(candidate?.scope);
  const productId = candidate?.productId === null ? null : stringValue(candidate?.productId);
  if (!itemId || !versionId || !scope || productId === undefined) return undefined;
  return { itemId, versionId, scope, productId };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function semanticContains(text: string, expected: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[\s，。！？、；：,.!?;:的了呢吗呀机使用]/g, '');
  const normalizedText = normalize(text);
  const normalizedExpected = normalize(expected);
  if (!normalizedExpected) return true;
  if (normalizedText.includes(normalizedExpected)) return true;
  const split = Math.max(2, Math.floor(normalizedExpected.length / 2));
  return normalizedText.includes(normalizedExpected.slice(0, split)) && normalizedText.includes(normalizedExpected.slice(split));
}

function mutationConversationId(result: MutationResult): string {
  const value = (result as unknown as { conversationId?: unknown }).conversationId;
  return typeof value === 'string' ? value : '';
}

async function resolveConversationId(port: ShowcaseRunnerPort, shopId: string, buyerId: string, signal?: AbortSignal): Promise<string> {
  let resolved = '';
  await waitUntil(port, async () => {
    resolved = (await port.conversations(shopId)).find((entry) => entry.buyerId === buyerId)?.id ?? '';
    return Boolean(resolved);
  }, 15_000, signal);
  return resolved;
}

function hasBuyerVisibleReply(conversation: Conversation, expectedSemantic: string[] = []): boolean {
  const messages = conversation.messages ?? [];
  const lastBuyer = [...messages].reverse().find((entry) => entry.role === 'BUYER' && entry.status !== 'RECALLED' && entry.status !== 'DELETED');
  if (!lastBuyer) return false;
  const replies = messages
    .filter((entry) => (
      ['ASSISTANT', 'AI', 'HUMAN'].includes(entry.role ?? '')
      && !['RECALLED', 'DELETED'].includes(entry.status ?? '')
      && (entry.sequence ?? 0) > (lastBuyer.sequence ?? 0)
    ));
  if (replies.length === 0) return false;
  if (expectedSemantic.length === 0) return true;
  const replyText = replies
    .map((entry) => {
      const content = entry.content as Record<string, unknown> | undefined;
      return typeof content?.text === 'string' ? content.text.trim() : '';
    })
    .filter(Boolean)
    .join('\n');
  return Boolean(replyText) && expectedSemantic.every((phrase) => semanticContains(replyText, phrase));
}

function hasReplyDraft(conversation: Conversation): boolean {
  const draft = conversation.currentDraft ?? conversation.activeReplyJob?.currentDraft ?? conversation.activeReplyJob?.draft;
  if (!draft) return false;
  const lastBuyer = [...(conversation.messages ?? [])].reverse().find((entry) => entry.role === 'BUYER' && entry.status !== 'RECALLED' && entry.status !== 'DELETED');
  if (!lastBuyer?.sequence || typeof draft.sourceSequence !== 'number') return true;
  return draft.sourceSequence >= lastBuyer.sequence;
}

function hasCommittedLatestBuyerTurn(conversation: Conversation): boolean {
  const sequence = latestBuyerSequence(conversation);
  if (sequence === undefined) return false;
  return (conversation.userTurns ?? []).some((turn) => turn.lastSequence >= sequence);
}

function hasNoAiArtifacts(conversation: Conversation): boolean {
  return !conversation.activeReplyJob && !conversation.currentDraft && !conversation.sendOutbox
    && !(conversation.messages ?? []).some((message) => ['AI', 'ASSISTANT'].includes(message.role ?? ''));
}

function latestBuyerSequence(conversation: Conversation): number | undefined {
  const latest = [...(conversation.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'BUYER' && !['RECALLED', 'DELETED'].includes(message.status ?? ''));
  return typeof latest?.sequence === 'number' ? latest.sequence : undefined;
}

function assertFutureOnlyReply(conversation: Conversation, offPeriodBuyerSequence?: number): void {
  if (offPeriodBuyerSequence === undefined) throw new Error('SHOWCASE_OFF_PERIOD_ASSERTION_MISSING');
  const messages = conversation.messages ?? [];
  const futureBuyer = messages.find((message) => message.role === 'BUYER' && (message.sequence ?? 0) > offPeriodBuyerSequence);
  if (!futureBuyer?.sequence) throw new Error('SHOWCASE_FUTURE_MESSAGE_MISSING');
  const prematureReply = messages.find((message) => ['AI', 'ASSISTANT'].includes(message.role ?? '')
    && (message.sequence ?? 0) > offPeriodBuyerSequence
    && (message.sequence ?? 0) < futureBuyer.sequence!);
  if (prematureReply) throw new Error('SHOWCASE_OFF_PERIOD_MESSAGE_REPLAYED');
  const futureReply = messages.find((message) => ['AI', 'ASSISTANT'].includes(message.role ?? '') && (message.sequence ?? 0) > futureBuyer.sequence!);
  if (!futureReply) throw new Error('SHOWCASE_FUTURE_REPLY_MISSING');
}

function isHumanConversation(conversation: Conversation): boolean {
  return Boolean(conversation.humanActive || conversation.effectiveMode === 'MANUAL' || conversation.activeReplyJob?.status === 'WAITING_HUMAN');
}

async function safeTrace(port: ShowcaseRunnerPort, conversationId: string, requiredStages: string[] = []): Promise<DeveloperTrace | undefined> {
  let latest: DeveloperTrace | undefined;
  const attempts = requiredStages.length ? 25 : 10;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      latest = await port.trace(conversationId);
      if (latest.events.length > 0 && requiredStages.every((stage) => latest!.events.some((event) => event.stage === stage))) return latest;
    } catch {
      // Trace projection is intentionally non-blocking. Give its durable
      // writer a short bounded window, then return the latest truthful state.
    }
    if (attempt < attempts - 1) await port.sleep(200);
  }
  return latest;
}

async function waitUntil(port: ShowcaseRunnerPort, predicate: () => Promise<boolean>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertActive(signal);
    if (await predicate()) return;
    await port.sleep(350);
  }
  throw new Error('SHOWCASE_STEP_TIMEOUT');
}

function timeout(step: Record<string, unknown>): number {
  return typeof step.timeoutMs === 'number' ? Math.min(Math.max(step.timeoutMs, 1_000), 60_000) : 60_000;
}

function boundedSettleMs(value: unknown): number {
  return typeof value === 'number' ? Math.min(Math.max(value, 0), 5_000) : 2_000;
}

function shopAiMode(value: unknown): ShowcaseScenario['aiMode'] | undefined {
  return value === 'AUTO_ALLOWED' || value === 'ASSIST_ONLY' || value === 'MANUAL_ONLY' ? value : undefined;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('SHOWCASE_CANCELLED');
}
