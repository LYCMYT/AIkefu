export type ReplyContextInput = {
  maxCharacters?: number;
  currentTurn: unknown;
  tasks?: unknown;
  realtimeFacts?: unknown;
  evidence?: unknown;
  recentMessages?: unknown;
  structuredFacts?: unknown;
  summary?: unknown;
  customerMemory?: unknown;
  shopSettings?: unknown;
  channel?: unknown;
};

export type ReplyContextResult = {
  context: Record<string, unknown>;
  characterCount: number;
  omittedSections: string[];
  truncatedSections: string[];
};

const CONTEXT_ORDER = [
  ['turn', 'currentTurn'],
  ['tasks', 'tasks'],
  ['realtimeFacts', 'realtimeFacts'],
  ['evidence', 'evidence'],
  // Stable shop policy and the channel are operational constraints, not
  // conversational memory. Keep them ahead of lower-trust historical text.
  ['shopSettings', 'shopSettings'],
  ['channel', 'channel'],
  ['recentMessages', 'recentMessages'],
  ['structuredFacts', 'structuredFacts'],
  ['summary', 'summary'],
  ['customerMemory', 'customerMemory'],
] as const;

/**
 * Builds the provider context in source-of-truth order. The budget is a
 * deterministic character ceiling rather than a model-specific tokenizer so
 * every provider receives the same auditable input. Arrays are trimmed from
 * their oldest/lowest-priority edge before an entire section is omitted.
 */
export function buildReplyContext(input: ReplyContextInput): ReplyContextResult {
  const maximum = Number.isSafeInteger(input.maxCharacters) && (input.maxCharacters ?? 0) >= 256
    ? input.maxCharacters!
    : 12_000;
  const context: Record<string, unknown> = {};
  const omittedSections: string[] = [];
  const truncatedSections: string[] = [];

  for (const [outputKey, inputKey] of CONTEXT_ORDER) {
    const value = input[inputKey];
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) continue;
    const candidate = fitSection(context, outputKey, value, maximum);
    if (candidate === undefined) {
      omittedSections.push(outputKey);
      continue;
    }
    if (candidate !== value) truncatedSections.push(outputKey);
    context[outputKey] = candidate;
  }
  return { context, characterCount: serializedLength(context), omittedSections, truncatedSections };
}

function fitSection(context: Record<string, unknown>, key: string, value: unknown, maximum: number): unknown {
  if (serializedLength({ ...context, [key]: value }) <= maximum) return value;
  if (!Array.isArray(value)) return undefined;
  if (key === 'recentMessages') {
    // Recent messages are ordered oldest -> newest; retain the newest context.
    for (let start = 1; start < value.length; start += 1) {
      const trimmed = value.slice(start);
      if (serializedLength({ ...context, [key]: trimmed }) <= maximum) return trimmed;
    }
    return undefined;
  }
  // Tasks, facts, evidence and memory are already ordered most useful first.
  // Keep a bounded prefix rather than dropping the complete grounded section.
  for (let end = value.length - 1; end > 0; end -= 1) {
    const trimmed = value.slice(0, end);
    if (serializedLength({ ...context, [key]: trimmed }) <= maximum) return trimmed;
  }
  return undefined;
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

const READ_TOOLS = new Set(['GET_PRODUCT', 'GET_INVENTORY', 'GET_ORDER', 'GET_LOGISTICS', 'GET_AFTER_SALES']);

/** A READ tool supplies facts; it is not an action boundary by itself. */
export function isTaskBlocking(requiredTools: readonly string[], _riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'): boolean {
  return requiredTools.some((tool) => !READ_TOOLS.has(tool));
}

export type ReplyOutputTaskResult = {
  intent: string;
  facts?: unknown;
};

export type ReplyOutputGuardResult =
  | { allowed: true }
  | { allowed: false; reason: 'EMPTY_REPLY' | 'REPLY_TOO_LONG' | 'ACTION_WITHOUT_RECEIPT' | 'FACT_MISMATCH' | 'PII_LEAK' | 'INTERNAL_LEAK' | 'DUPLICATE_REPLY' | 'NOT_CUSTOMER_FACING' };

/**
 * Minimal deterministic post-composition guard. It does not decide policy; it
 * prevents a composed string from contradicting the durable TaskResult or
 * exposing data that must never reach a buyer.
 */
export function guardReplyOutput(input: {
  text: string;
  taskResults: readonly ReplyOutputTaskResult[];
  maxLength?: number;
}): ReplyOutputGuardResult {
  const text = input.text.trim();
  if (!text) return { allowed: false, reason: 'EMPTY_REPLY' };
  if (text.length > (input.maxLength ?? 1_000)) return { allowed: false, reason: 'REPLY_TOO_LONG' };
  if (/(?:system\s*prompt|developer\s*(?:message|trace)|chain[-\s]?of[-\s]?thought|内部提示词|系统提示词|开发者追踪|trace[_ -]?id|reply[_ -]?job|send[_ -]?outbox|WAITING_HUMAN|NO_EVIDENCE|MANUAL_REQUIRED|\{\s*"(?:status|code)"\s*:)/iu.test(text)) {
    return { allowed: false, reason: 'INTERNAL_LEAK' };
  }
  if (/(?:^|\D)1[3-9]\d{9}(?:\D|$)|\b\d{17}[\dXx]\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:银行卡|卡号)\D{0,6}\d{13,19}/iu.test(text)) {
    return { allowed: false, reason: 'PII_LEAK' };
  }
  if (text === '请人工处理此会话。' || /(?:请|需)人工处理此会话/u.test(text)) {
    return { allowed: false, reason: 'NOT_CUSTOMER_FACING' };
  }
  if (maximumSentenceRepetition(text) > 1) return { allowed: false, reason: 'DUPLICATE_REPLY' };
  if (claimsCompletedAction(text) && !input.taskResults.some((task) => hasSucceededReceipt(task.facts))) {
    return { allowed: false, reason: 'ACTION_WITHOUT_RECEIPT' };
  }
  const inventoryFacts = input.taskResults.flatMap((task) => numericValues(task.facts, /(?:inventory|stock|库存)/i));
  const claimedInventory = [...text.matchAll(/(?:库存|还(?:有|剩)|现有)\D{0,8}(\d+)\s*(?:件|个|套|台|件)?/gu)]
    .map((match) => Number(match[1]));
  if (inventoryFacts.length > 0 && claimedInventory.some((value) => !inventoryFacts.includes(value))) {
    return { allowed: false, reason: 'FACT_MISMATCH' };
  }
  const priceFacts = input.taskResults.flatMap((task) => numericValues(task.facts, /(?:price|amount|售价|价格|金额)/i));
  const claimedPrices = [...text.matchAll(/(?:售价|价格|到手价|退款金额|补偿金额)\D{0,8}(\d+(?:\.\d+)?)\s*元/gu)].map((match) => Number(match[1]));
  if (priceFacts.length > 0 && claimedPrices.some((value) => !priceFacts.includes(value))) return { allowed: false, reason: 'FACT_MISMATCH' };
  const statusFacts = input.taskResults.flatMap((task) => stringValues(task.facts, /(?:order.?status|status|订单状态)/i));
  if (statusFacts.length > 0 && contradictsOrderStatus(text, statusFacts)) return { allowed: false, reason: 'FACT_MISMATCH' };
  return { allowed: true };
}

function claimsCompletedAction(text: string): boolean {
  return /(?:已|已经|成功)(?:为您|帮您|给您)?(?:完成|办理|提交|发起|操作)?(?:退款|退货|换货|取消订单|修改地址|改地址|补偿|赔付|备注|转接)|(?:退款|退货|换货|订单取消|地址修改|备注)(?:已|已经)(?:成功|完成|提交|处理好)|已处理好/u.test(text);
}

function hasSucceededReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasSucceededReceipt);
  const record = value as Record<string, unknown>;
  if ((record.status === 'SUCCEEDED' || record.status === 'SENT') && /receipt/i.test(String(record.type ?? record.kind ?? 'receipt'))) return true;
  if ('receipt' in record && hasSucceededStatus(record.receipt)) return true;
  return Object.values(record).some(hasSucceededReceipt);
}

function hasSucceededStatus(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && ['SUCCEEDED', 'SENT'].includes(String((value as Record<string, unknown>).status ?? '')));
}

function numericValues(value: unknown, keyPattern: RegExp): number[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => numericValues(entry, keyPattern));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const own = keyPattern.test(key) && typeof entry === 'number' && Number.isFinite(entry) ? [entry] : [];
    return [...own, ...numericValues(entry, keyPattern)];
  });
}

function stringValues(value: unknown, keyPattern: RegExp): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => stringValues(entry, keyPattern));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const own = keyPattern.test(key) && typeof entry === 'string' ? [entry] : [];
    return [...own, ...stringValues(entry, keyPattern)];
  });
}

function contradictsOrderStatus(text: string, facts: readonly string[]): boolean {
  const labels: Record<string, RegExp> = {
    WAITING_PAYMENT: /待付款/u,
    PAID: /待发货/u,
    WAITING_SHIPMENT: /待发货/u,
    SHIPPED: /(?:已|已经)发货|运输中/u,
    DELIVERED: /(?:已|已经)签收/u,
    COMPLETED: /(?:已|已经)完成/u,
    CANCELLED: /(?:已|已经)取消/u,
    REFUNDING: /退款处理中/u,
    REFUNDED: /(?:已|已经)退款/u,
  };
  const allowed = new Set(facts.flatMap((status) => labels[status] ? [status] : []));
  const claimed = Object.entries(labels).filter(([, pattern]) => pattern.test(text)).map(([status]) => status);
  return claimed.some((status) => !allowed.has(status));
}

function maximumSentenceRepetition(text: string): number {
  const counts = new Map<string, number>();
  for (const sentence of text.split(/[。！？!?\n]+/u).map((entry) => entry.replace(/\s+/gu, '').trim()).filter((entry) => entry.length >= 4)) {
    counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  WAITING_PAYMENT: '待付款',
  PAID: '待发货',
  WAITING_SHIPMENT: '待发货',
  SHIPPED: '已经发货',
  DELIVERED: '已经签收',
  COMPLETED: '已经完成',
  CANCELLED: '已经取消',
  REFUNDING: '退款处理中',
  REFUNDED: '已经退款',
};

/** Customer-safe rendering for live facts. IDs and exact stock stay internal. */
export function renderCustomerFactReply(intent: string, dynamic: Record<string, unknown>): string | undefined {
  if (typeof dynamic.status === 'string' && /ORDER|LOGISTICS|SHIP/i.test(intent)) {
    const status = ORDER_STATUS_LABELS[dynamic.status] ?? '状态已更新';
    if (dynamic.status === 'SHIPPED') {
      const logistics = dynamic.logistics && typeof dynamic.logistics === 'object' && !Array.isArray(dynamic.logistics)
        ? dynamic.logistics as Record<string, unknown>
        : undefined;
      const lastNode = safeCustomerLocation(logistics?.lastNode);
      return lastNode
        ? `这笔订单已经发货，最新物流到达${lastNode}。`
        : '这笔订单已经发货，请留意物流更新。';
    }
    return `这笔订单目前${status}。`;
  }
  if (typeof dynamic.inventory === 'number' && /SKU|INVENTORY|STOCK|PRODUCT/i.test(intent)) {
    if (dynamic.inventory <= 0) return '这个规格目前暂时缺货，您可以看看其他规格。';
    if (dynamic.inventory <= 5) return '这个规格目前库存较少，建议尽快下单。';
    return '这个规格目前有现货，可以正常下单。';
  }
  return undefined;
}

/** Uses only the already-sanitized deterministic image analysis in UserTurn. */
export function renderImageObservationReply(intent: string, normalizedTurn: string): string | undefined {
  if (!/AFTER_SALES/i.test(intent)) return undefined;
  // PRODUCT_DAMAGE is a validated, sanitized scene classification. Provider
  // observations are free text and may say “撕裂痕迹” instead of repeating the
  // canonical phrase, so the deterministic customer reply must key off the
  // scene marker rather than brittle model wording.
  const classifiedDamage = /\[图片\s+PRODUCT_DAMAGE\]/iu.test(normalizedTurn);
  const sanitizedDamageObservation = /\[图片\s+[A-Z_]+\][\s\S]{0,160}疑似.{0,12}(?:破损|损坏|撕裂)/iu.test(normalizedTurn);
  if (!classifiedDamage && !sanitizedDamageObservation) return undefined;
  return '图片中疑似商品破损，建议由人工客服进一步核实处理。';
}

function safeCustomerLocation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!normalized || normalized.length > 80) return undefined;
  return normalized;
}
