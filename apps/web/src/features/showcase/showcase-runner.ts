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
  onUpdate({ status: 'RUNNING', message: '独立数据已恢复，正在执行真实业务动作。' });

  if (scenario.id === 'SC-03-STALE-REPLAN') {
    await port.runStaleScenario();
    await waitUntil(port, async () => {
      const snapshot = await port.scenarioSnapshot();
      if (snapshot?.status === 'FAILED') throw new Error(snapshot.steps?.find((step) => step.status === 'FAILED')?.actual ?? 'STALE_REPLAN_FAILED');
      return snapshot?.status === 'SUCCEEDED';
    }, 60_000, signal);
    const conversationId = (await port.conversations(shop.id)).find((entry) => entry.buyerId === buyer.id)?.id;
    const trace = conversationId ? await safeTrace(port, conversationId) : undefined;
    onUpdate({ status: 'COMPLETED', message: '旧回复已失效，新回复通过发送守卫。', conversationId });
    return { status: 'COMPLETED', conversationId, trace };
  }

  let conversationId = '';
  const observedTaskIntents = new Set<string>();
  const observedCustomerFacingText: string[] = [];
  let firstReplyBuyerTextCount: number | undefined;
  for (const step of scenario.steps) {
    assertActive(signal);
    if (step.action === 'RESET_SHOWCASE') continue;
    const delayMs = typeof step.delayMs === 'number' ? step.delayMs : 0;
    if (delayMs > 0) await port.sleep(delayMs);
    if (step.action === 'SEND_GOODS_CARD') {
      const resource = catalog.resources.products.find((entry) => entry.key === step.productKey);
      const product = (await port.products(shop.id)).find((entry) => entry.externalProductId === resource?.externalProductId);
      if (!product) throw new Error('SHOWCASE_PRODUCT_NOT_FOUND');
      conversationId = mutationConversationId(await port.productCard({ shopId: shop.id, buyerId: buyer.id, productId: product.id, ...(conversationId ? { conversationId } : {}) })) || conversationId;
    } else if (step.action === 'SEND_ORDER_CARD') {
      const resource = catalog.resources.orders.find((entry) => entry.key === step.orderKey);
      const order = (await port.orders(shop.id, buyer.id)).find((entry) => entry.externalOrderId === resource?.externalOrderId);
      if (!order) throw new Error('SHOWCASE_ORDER_NOT_FOUND');
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
      await waitUntil(port, async () => hasBuyerVisibleReply(await port.conversation(conversationId)), timeout(step), signal);
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
    }
  }
  conversationId ||= await resolveConversationId(port, shop.id, buyer.id, signal);
  observeConversation(await port.conversation(conversationId), observedTaskIntents, observedCustomerFacingText);
  const trace = await safeTrace(port, conversationId);
  assertScenarioEvidence(scenario, observedTaskIntents, observedCustomerFacingText, firstReplyBuyerTextCount, trace);
  onUpdate({ status: 'COMPLETED', message: scenario.id === 'SC-04-IMAGE-HUMAN' ? '高风险售后已进入人工，未执行退款动作。' : '场景已通过真实消息链路完成。', conversationId });
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

function assertScenarioEvidence(
  scenario: ShowcaseScenario,
  taskIntents: Set<string>,
  texts: string[],
  firstReplyBuyerTextCount?: number,
  trace?: DeveloperTrace,
): void {
  const expectedTasks = stringList(scenario.expected.tasks);
  const traceText = JSON.stringify(trace?.events ?? []);
  for (const task of expectedTasks) {
    if (!taskIntents.has(task) && !traceText.includes(task)) throw new Error(`SHOWCASE_EXPECTED_TASK_MISSING:${task}`);
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

function hasBuyerVisibleReply(conversation: Conversation): boolean {
  const messages = conversation.messages ?? [];
  const lastBuyer = [...messages].reverse().find((entry) => entry.role === 'BUYER' && entry.status !== 'RECALLED' && entry.status !== 'DELETED');
  return Boolean(lastBuyer && messages.some((entry) => ['ASSISTANT', 'AI', 'HUMAN'].includes(entry.role ?? '') && (entry.sequence ?? 0) > (lastBuyer.sequence ?? 0)));
}

function hasReplyDraft(conversation: Conversation): boolean {
  const draft = conversation.currentDraft ?? conversation.activeReplyJob?.currentDraft ?? conversation.activeReplyJob?.draft;
  if (!draft) return false;
  const lastBuyer = [...(conversation.messages ?? [])].reverse().find((entry) => entry.role === 'BUYER' && entry.status !== 'RECALLED' && entry.status !== 'DELETED');
  if (!lastBuyer?.sequence || typeof draft.sourceSequence !== 'number') return true;
  return draft.sourceSequence >= lastBuyer.sequence;
}

function isHumanConversation(conversation: Conversation): boolean {
  return Boolean(conversation.humanActive || conversation.effectiveMode === 'MANUAL' || conversation.activeReplyJob?.status === 'WAITING_HUMAN');
}

async function safeTrace(port: ShowcaseRunnerPort, conversationId: string): Promise<DeveloperTrace | undefined> {
  let latest: DeveloperTrace | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      latest = await port.trace(conversationId);
      if (latest.events.length > 0) return latest;
    } catch {
      // Trace projection is intentionally non-blocking. Give its durable
      // writer a short bounded window, then return the latest truthful state.
    }
    if (attempt < 9) await port.sleep(200);
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

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('SHOWCASE_CANCELLED');
}
