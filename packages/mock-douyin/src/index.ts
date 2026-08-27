/**
 * Phase 02's platform boundary is intentionally an in-memory synthetic
 * adapter. It has no network client, no login method, and rejects any
 * credential-shaped input at runtime.
 */
export const MOCK_DOUYIN_DESCRIPTOR = Object.freeze({
  platform: 'DOUYIN_DEMO',
  displayName: '抖音 Demo（Mock）',
  authentication: 'SYNTHETIC_WORKSPACE_ONLY',
  realPlatformAccess: false,
} as const);

export type MockDouyinMessageKind = 'TEXT' | 'IMAGE' | 'PRODUCT_CARD' | 'ORDER_CARD';
export type MockDouyinMessageStatus = 'ACTIVE' | 'EDITED' | 'RECALLED';
export type MockDouyinEventType =
  | 'MESSAGE_CREATED'
  | 'MESSAGE_EDITED'
  | 'MESSAGE_RECALLED'
  | 'PRODUCT_CHANGED'
  | 'INVENTORY_CHANGED'
  | 'ORDER_CHANGED'
  | 'CONNECTION_CHANGED';

export interface SyntheticAdapterScope {
  workspaceId: string;
  tenantId: string;
  shopId: string;
}

export interface SyntheticConversationScope extends SyntheticAdapterScope {
  externalConversationId: string;
}

export interface MockDouyinProductCard {
  externalProductId: string;
  title?: string;
  externalSkuId?: string;
  price?: number;
  inventory?: number;
}

export interface MockDouyinOrderCard {
  externalOrderId: string;
  status?: string;
  amount?: number;
}

export interface MockDouyinMessage {
  externalMessageId: string;
  externalConversationId: string;
  externalBuyerId: string;
  sequence: number;
  kind: MockDouyinMessageKind;
  status: MockDouyinMessageStatus;
  text?: string;
  product?: MockDouyinProductCard;
  order?: MockDouyinOrderCard;
  sentAt: string;
  editedAt?: string;
  recalledAt?: string;
  entityVersion: number;
}

export interface MockDouyinAdapterEvent {
  eventId: string;
  platform: typeof MOCK_DOUYIN_DESCRIPTOR.platform;
  eventType: MockDouyinEventType;
  workspaceId: string;
  tenantId: string;
  shopId: string;
  externalConversationId?: string;
  externalBuyerId?: string;
  externalMessageId?: string;
  sequence?: number;
  occurredAt: string;
  payload: {
    kind?: MockDouyinMessageKind;
    message?: MockDouyinMessage;
    product?: MockDouyinProductCard;
    order?: MockDouyinOrderCard;
    reason?: string;
  };
}

export interface MockDouyinMessageCommand extends SyntheticAdapterScope {
  externalBuyerId: string;
  externalConversationId: string;
  text: string;
  externalMessageId?: string;
  sequence?: number;
  sentAt?: string | Date;
}

export interface MockDouyinProductCardCommand extends SyntheticAdapterScope {
  externalBuyerId: string;
  externalConversationId: string;
  product: MockDouyinProductCard;
  externalMessageId?: string;
  sequence?: number;
  sentAt?: string | Date;
}

export interface MockDouyinOrderCardCommand extends SyntheticAdapterScope {
  externalBuyerId: string;
  externalConversationId: string;
  order: MockDouyinOrderCard;
  externalMessageId?: string;
  sequence?: number;
  sentAt?: string | Date;
}

export interface MockDouyinEditCommand extends SyntheticAdapterScope {
  externalMessageId: string;
  text: string;
  editedAt?: string | Date;
}

export interface MockDouyinRecallCommand extends SyntheticAdapterScope {
  externalMessageId: string;
  recalledAt?: string | Date;
}

export interface MockDouyinHistoryQuery extends SyntheticConversationScope {
  afterSequence?: number;
  throughSequence?: number;
}

export interface MockDouyinReconcileQuery extends MockDouyinHistoryQuery {
  expectedSequence: number;
}

export interface MockDouyinHistoryResult {
  messages: MockDouyinMessage[];
}

export interface MockDouyinReconcileResult extends MockDouyinHistoryResult {
  expectedSequence: number;
  throughSequence?: number;
  gapResolved: boolean;
}

export interface MockDouyinAdapterOptions {
  now?: () => Date;
  idFactory?: (prefix: string, sequence: number) => string;
}

export class MockDouyinCredentialError extends Error {
  constructor() {
    super('MockDouyinAdapter only accepts synthetic workspace identifiers; real credentials are forbidden');
    this.name = 'MockDouyinCredentialError';
  }
}

export class MockDouyinNotFoundError extends Error {
  constructor(entity: string) {
    super(`Synthetic ${entity} not found in the requested workspace, tenant and shop scope`);
    this.name = 'MockDouyinNotFoundError';
  }
}

type Subscriber = {
  scope: SyntheticAdapterScope;
  listener: (event: MockDouyinAdapterEvent) => void;
};

type StoredConversation = {
  nextSequence: number;
  messages: MockDouyinMessage[];
};

const FORBIDDEN_CREDENTIAL_KEY = /(credential|token|cookie|authorization|api[_-]?key|secret|password|session)/i;

/**
 * A small deterministic platform simulator. Each instance owns its own state,
 * so tests and workspaces cannot share conversations accidentally.
 */
export class MockDouyinAdapter {
  readonly descriptor = MOCK_DOUYIN_DESCRIPTOR;

  private readonly conversations = new Map<string, StoredConversation>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly now: () => Date;
  private readonly idFactory: (prefix: string, sequence: number) => string;
  private nextId = 0;

  constructor(options: MockDouyinAdapterOptions = {}) {
    assertNoCredentials(options);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? ((prefix, sequence) => `mock_douyin_${prefix}_${sequence}`);
  }

  subscribe(scope: SyntheticAdapterScope, listener: (event: MockDouyinAdapterEvent) => void): () => void {
    assertNoCredentials(scope);
    assertScope(scope);
    if (typeof listener !== 'function') throw new TypeError('MockDouyin subscription listener must be a function');
    const subscriber: Subscriber = { scope: { ...scope }, listener };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async sendMessage(command: MockDouyinMessageCommand): Promise<MockDouyinAdapterEvent> {
    assertNoCredentials(command);
    assertScope(command);
    assertNonEmpty(command.externalBuyerId, 'externalBuyerId');
    assertNonEmpty(command.externalConversationId, 'externalConversationId');
    assertNonEmpty(command.text, 'text');
    return this.createMessage(command, 'TEXT', { text: command.text });
  }

  async sendProductCard(command: MockDouyinProductCardCommand): Promise<MockDouyinAdapterEvent> {
    assertNoCredentials(command);
    assertScope(command);
    assertNonEmpty(command.externalBuyerId, 'externalBuyerId');
    assertNonEmpty(command.externalConversationId, 'externalConversationId');
    assertNonEmpty(command.product?.externalProductId, 'product.externalProductId');
    return this.createMessage(command, 'PRODUCT_CARD', { product: clone(command.product) });
  }

  async sendOrderCard(command: MockDouyinOrderCardCommand): Promise<MockDouyinAdapterEvent> {
    assertNoCredentials(command);
    assertScope(command);
    assertNonEmpty(command.externalBuyerId, 'externalBuyerId');
    assertNonEmpty(command.externalConversationId, 'externalConversationId');
    assertNonEmpty(command.order?.externalOrderId, 'order.externalOrderId');
    return this.createMessage(command, 'ORDER_CARD', { order: clone(command.order) });
  }

  async editMessage(command: MockDouyinEditCommand): Promise<MockDouyinAdapterEvent> {
    assertNoCredentials(command);
    assertScope(command);
    assertNonEmpty(command.externalMessageId, 'externalMessageId');
    assertNonEmpty(command.text, 'text');
    const message = this.findMessage(command);
    if (message.kind !== 'TEXT') throw new TypeError('Only synthetic text messages can be edited');

    message.text = command.text;
    message.status = 'EDITED';
    message.editedAt = toIsoDate(command.editedAt, this.now);
    message.entityVersion += 1;
    return this.emitMessageEvent('MESSAGE_EDITED', command, message);
  }

  async recallMessage(command: MockDouyinRecallCommand): Promise<MockDouyinAdapterEvent> {
    assertNoCredentials(command);
    assertScope(command);
    assertNonEmpty(command.externalMessageId, 'externalMessageId');
    const message = this.findMessage(command);
    message.status = 'RECALLED';
    message.recalledAt = toIsoDate(command.recalledAt, this.now);
    message.entityVersion += 1;
    return this.emitMessageEvent('MESSAGE_RECALLED', command, message);
  }

  async history(query: MockDouyinHistoryQuery): Promise<MockDouyinHistoryResult> {
    assertNoCredentials(query);
    assertConversationScope(query);
    const conversation = this.conversations.get(conversationKey(query));
    if (!conversation) throw new MockDouyinNotFoundError('conversation');
    const messages = conversation.messages.filter((message) => {
      if (query.afterSequence !== undefined && message.sequence <= query.afterSequence) return false;
      if (query.throughSequence !== undefined && message.sequence > query.throughSequence) return false;
      return true;
    });
    return { messages: messages.map(clone) };
  }

  /** Returns the synthetic history used by the core's one-shot gap recovery. */
  async reconcile(query: MockDouyinReconcileQuery): Promise<MockDouyinReconcileResult> {
    assertNoCredentials(query);
    assertConversationScope(query);
    validatePositiveInteger(query.expectedSequence, 'expectedSequence');
    if (query.throughSequence !== undefined) validatePositiveInteger(query.throughSequence, 'throughSequence');
    const history = await this.history({
      ...query,
      afterSequence: query.expectedSequence - 1,
      ...(query.throughSequence === undefined ? {} : { throughSequence: query.throughSequence }),
    });
    return {
      ...history,
      expectedSequence: query.expectedSequence,
      ...(query.throughSequence === undefined ? {} : { throughSequence: query.throughSequence }),
      gapResolved: history.messages.some((message) => message.sequence === query.expectedSequence),
    };
  }

  private createMessage(
    command: MockDouyinMessageCommand | MockDouyinProductCardCommand | MockDouyinOrderCardCommand,
    kind: MockDouyinMessageKind,
    payload: Pick<MockDouyinMessage, 'text' | 'product' | 'order'>,
  ): MockDouyinAdapterEvent {
    const key = conversationKey(command);
    const conversation = this.conversations.get(key) ?? { nextSequence: 1, messages: [] };
    this.conversations.set(key, conversation);

    const externalMessageId = command.externalMessageId ?? this.createId('message');
    const existing = conversation.messages.find((message) => message.externalMessageId === externalMessageId);
    if (existing) {
      // Simulate an at-least-once platform delivery without creating a second
      // stored message. The message pipeline's durable dedup still receives a
      // replayed event and remains the source of truth.
      return this.emitMessageEvent('MESSAGE_CREATED', command, existing);
    }

    const sequence = command.sequence ?? conversation.nextSequence;
    validatePositiveInteger(sequence, 'sequence');
    conversation.nextSequence = Math.max(conversation.nextSequence, sequence + 1);
    const message: MockDouyinMessage = {
      externalMessageId,
      externalConversationId: command.externalConversationId,
      externalBuyerId: command.externalBuyerId,
      sequence,
      kind,
      status: 'ACTIVE',
      ...payload,
      sentAt: toIsoDate(command.sentAt, this.now),
      entityVersion: 1,
    };
    conversation.messages.push(message);
    conversation.messages.sort((left, right) => left.sequence - right.sequence);
    return this.emitMessageEvent('MESSAGE_CREATED', command, message);
  }

  private emitMessageEvent(
    eventType: Extract<MockDouyinEventType, 'MESSAGE_CREATED' | 'MESSAGE_EDITED' | 'MESSAGE_RECALLED'>,
    scope: SyntheticAdapterScope,
    message: MockDouyinMessage,
  ): MockDouyinAdapterEvent {
    const event: MockDouyinAdapterEvent = {
      eventId: this.createId('event'),
      platform: MOCK_DOUYIN_DESCRIPTOR.platform,
      eventType,
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: scope.shopId,
      externalConversationId: message.externalConversationId,
      externalBuyerId: message.externalBuyerId,
      externalMessageId: message.externalMessageId,
      sequence: message.sequence,
      occurredAt: this.now().toISOString(),
      payload: { kind: message.kind, message: clone(message) },
    };
    this.emit(event);
    return clone(event);
  }

  private emit(event: MockDouyinAdapterEvent): void {
    for (const subscriber of this.subscribers) {
      if (!sameScope(subscriber.scope, event)) continue;
      // One UI subscriber must not stop another subscriber or the command.
      try {
        subscriber.listener(clone(event));
      } catch {
        // Subscriber faults belong to the consuming application, not the mock platform.
      }
    }
  }

  private findMessage(scope: SyntheticAdapterScope & { externalMessageId: string }): MockDouyinMessage {
    const prefix = scopeKey(scope);
    for (const [key, conversation] of this.conversations) {
      if (!key.startsWith(`${prefix}\u0000`)) continue;
      const message = conversation.messages.find((candidate) => candidate.externalMessageId === scope.externalMessageId);
      if (message) return message;
    }
    throw new MockDouyinNotFoundError('message');
  }

  private createId(prefix: string): string {
    this.nextId += 1;
    return this.idFactory(prefix, this.nextId);
  }
}

function assertNoCredentials(value: unknown, visited = new Set<unknown>()): void {
  if (!value || typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CREDENTIAL_KEY.test(key)) throw new MockDouyinCredentialError();
    assertNoCredentials(nested, visited);
  }
}

function assertScope(scope: SyntheticAdapterScope): void {
  assertNonEmpty(scope.workspaceId, 'workspaceId');
  assertNonEmpty(scope.tenantId, 'tenantId');
  assertNonEmpty(scope.shopId, 'shopId');
}

function assertConversationScope(scope: SyntheticConversationScope): void {
  assertScope(scope);
  assertNonEmpty(scope.externalConversationId, 'externalConversationId');
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
}

function scopeKey(scope: SyntheticAdapterScope): string {
  return `${scope.workspaceId}\u0000${scope.tenantId}\u0000${scope.shopId}`;
}

function conversationKey(scope: SyntheticConversationScope): string {
  return `${scopeKey(scope)}\u0000${scope.externalConversationId}`;
}

function sameScope(scope: SyntheticAdapterScope, event: MockDouyinAdapterEvent): boolean {
  return scope.workspaceId === event.workspaceId && scope.tenantId === event.tenantId && scope.shopId === event.shopId;
}

function toIsoDate(value: string | Date | undefined, now: () => Date): string {
  const date = value === undefined ? now() : typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new RangeError('time must be an ISO date or valid Date');
  return date.toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
