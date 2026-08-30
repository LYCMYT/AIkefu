import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  BuyerMessageCommand,
  BuyerOrderCardCommand,
  BuyerProductCardCommand,
  ConversationSnapshot,
  ConversationSummary,
  Message,
  MessageKind,
  MessageStatus,
  WorkspaceEventEnvelope,
} from '@ai-customer-service/contracts';
import type {
  BuyerView,
  MessageApplication,
  MessageEventPublisher,
  OperationAccepted,
  OrderView,
  ProductView,
} from '../src/messages/message.application';
import type { WorkspaceScope } from '../src/workspaces/workspace.repository';
import type { InMemoryWorkspaceRepository } from './workspace.repository.fake';

type StoredMessage = Message & { entityVersion: number };

type BufferedMessage = {
  message: StoredMessage;
  firstBufferedAt: number;
};

type StoredTurn = {
  id: string;
  sourceMessageIds: string[];
  normalizedText: string;
  firstSequence: number;
  lastSequence: number;
  generation: number;
  createdAt: string;
};

type StoredBuffer = {
  openedAt: number;
  lastMessageAt: number;
  idleDeadline: number;
  hardDeadline: number;
  firstSequence: number;
  latestSequence: number;
  generation: number;
};

type StoredConversation = {
  id: string;
  workspaceId: string;
  tenantId: string;
  shopId: string;
  buyerId: string;
  externalConversationId: string;
  lastCommittedSequence: number;
  contextVersion: number;
  syncState: 'CONNECTED' | 'DEGRADED';
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
  buffered: Map<number, BufferedMessage>;
  knownExternalMessageIds: Set<string>;
  gapDeadline?: number;
  turnBuffer?: StoredBuffer;
  userTurns: StoredTurn[];
};

type WorkspaceState = {
  buyers: BuyerView[];
  productsByShop: Map<string, ProductView[]>;
  ordersByShop: Map<string, OrderView[]>;
  conversations: Map<string, StoredConversation>;
};

const BUYER_NAMES = ['小林', 'Mia', '张先生', '阿青'];
const PRODUCT_TITLES = ['轻薄连帽卫衣', '防晒夹克', '直筒牛仔裤', '静音三模键盘', '100W GaN 充电器'];

/**
 * Deterministic test double for the HTTP/WS vertical-slice tests. Production
 * durability is implemented by PrismaMessageApplication; this class keeps the
 * integration suite fast and free of external infrastructure.
 */
export class InMemoryMessageApplication implements MessageApplication {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly scheduledTurnConversations = new Set<string>();
  private publisher?: MessageEventPublisher;
  private now = Date.parse('2026-08-26T12:00:00.000Z');
  private outboxCount = 0;

  constructor(private readonly workspaceRepository: InMemoryWorkspaceRepository) {}

  setPublisher(publisher: MessageEventPublisher): void {
    this.publisher = publisher;
  }

  processingOutboxCount(): number {
    return this.outboxCount;
  }

  clearDelayedJobsForRestart(): void {
    this.scheduledTurnConversations.clear();
  }

  async recoverTurnBuffers(): Promise<void> {
    for (const state of this.workspaces.values()) {
      for (const conversation of state.conversations.values()) {
        if (conversation.turnBuffer) this.scheduledTurnConversations.add(conversation.id);
      }
    }
    await this.runDueWork();
  }

  async advanceBy(milliseconds: number): Promise<void> {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('milliseconds must be non-negative');
    this.now += milliseconds;
    await this.runDueWork();
  }

  async listBuyers(scope: WorkspaceScope, shopId?: string): Promise<BuyerView[]> {
    if (shopId) await this.assertShop(scope, shopId);
    const state = this.state(scope);
    const relatedBuyerIds = shopId
      ? new Set([
          ...(state.ordersByShop.get(shopId) ?? []).map((order) => order.buyerId),
          ...[...state.conversations.values()].filter((conversation) => conversation.shopId === shopId).map((conversation) => conversation.buyerId),
        ])
      : undefined;
    return state.buyers
      .filter((buyer) => !relatedBuyerIds || relatedBuyerIds.has(buyer.id))
      .map((buyer) => ({ ...buyer, tags: [...buyer.tags] }));
  }

  async listProducts(scope: WorkspaceScope, shopId: string): Promise<ProductView[]> {
    await this.assertShop(scope, shopId);
    return (this.state(scope).productsByShop.get(shopId) ?? []).map((product) => structuredClone(product));
  }

  async listOrders(scope: WorkspaceScope, shopId: string, buyerId?: string): Promise<OrderView[]> {
    await this.assertShop(scope, shopId);
    if (buyerId) this.assertBuyer(scope, buyerId);
    return (this.state(scope).ordersByShop.get(shopId) ?? [])
      .filter((order) => !buyerId || order.buyerId === buyerId)
      .map((order) => structuredClone(order));
  }

  async listConversations(scope: WorkspaceScope, shopId: string): Promise<ConversationSummary[]> {
    await this.assertShop(scope, shopId);
    return [...this.state(scope).conversations.values()]
      .filter((conversation) => conversation.shopId === shopId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((conversation) => this.summary(scope, conversation));
  }

  async getConversation(scope: WorkspaceScope, conversationId: string): Promise<ConversationSnapshot> {
    const conversation = this.scopedConversation(scope, conversationId);
    const state = this.state(scope);
    const summary = this.summary(scope, conversation);
    const currentProductId = this.currentReference(conversation, 'GOODS_CARD');
    const currentOrderId = this.currentReference(conversation, 'ORDER_CARD');
    return {
      ...summary,
      messages: conversation.messages.map((message) => structuredClone(message)),
      turnBuffer: conversation.turnBuffer
        ? ({
            key: conversation.id,
            workspaceId: scope.workspaceId,
            tenantId: scope.tenantId,
            shopId: conversation.shopId,
            conversationId: conversation.id,
            buyerId: conversation.buyerId,
            firstSequence: conversation.turnBuffer.firstSequence,
            latestSequence: conversation.turnBuffer.latestSequence,
            openedAt: new Date(conversation.turnBuffer.openedAt).toISOString(),
            lastMessageAt: new Date(conversation.turnBuffer.lastMessageAt).toISOString(),
            idleDeadline: new Date(conversation.turnBuffer.idleDeadline).toISOString(),
            hardDeadline: new Date(conversation.turnBuffer.hardDeadline).toISOString(),
            generation: conversation.turnBuffer.generation,
            status: 'BUFFERING',
          } as ConversationSnapshot['turnBuffer'])
        : null,
      currentProduct: currentProductId
        ? structuredClone(
            [...state.productsByShop.values()].flat().find((product) => product.id === currentProductId) ?? null,
          )
        : null,
      currentOrder: currentOrderId
        ? structuredClone(
            [...state.ordersByShop.values()].flat().find((order) => order.id === currentOrderId) ?? null,
          )
        : null,
      summary: null,
      userTurns: conversation.userTurns.map((turn) => ({ ...turn, sourceMessageIds: [...turn.sourceMessageIds] })),
    } as ConversationSnapshot;
  }

  async sendMessage(scope: WorkspaceScope, input: BuyerMessageCommand): Promise<OperationAccepted> {
    const kind = input.kind;
    const content = kind === 'TEXT' ? { text: input.text!.trim() } : { attachmentId: input.attachmentId ?? 'pending' };
    return this.ingest(scope, {
      shopId: input.shopId,
      buyerId: input.buyerId,
      conversationId: input.conversationId,
      kind,
      content,
      sentAt: input.sentAt,
      forcedSequence: input.forcedSequence,
      externalMessageId: input.duplicateExternalMessageId,
    });
  }

  async sendProductCard(scope: WorkspaceScope, input: BuyerProductCardCommand): Promise<OperationAccepted> {
    const product = (await this.listProducts(scope, input.shopId)).find((item) => item.id === input.productId);
    if (!product) throw missing('PRODUCT_NOT_FOUND', 'Product not found in this shop');
    return this.ingest(scope, {
      ...input,
      kind: 'GOODS_CARD',
      content: { productId: product.id, externalProductId: product.id, title: product.title },
    });
  }

  async sendOrderCard(scope: WorkspaceScope, input: BuyerOrderCardCommand): Promise<OperationAccepted> {
    const order = (await this.listOrders(scope, input.shopId, input.buyerId)).find((item) => item.id === input.orderId);
    if (!order) throw missing('ORDER_NOT_FOUND', 'Order not found for this buyer and shop');
    return this.ingest(scope, {
      ...input,
      kind: 'ORDER_CARD',
      content: { orderId: order.id, externalOrderId: order.externalOrderId, status: order.status },
    });
  }

  async editMessage(scope: WorkspaceScope, messageId: string, text: string): Promise<OperationAccepted> {
    const { conversation, message } = this.scopedMessage(scope, messageId);
    if (message.kind !== 'TEXT' || message.status === 'RECALLED') {
      throw bad('MESSAGE_NOT_EDITABLE', 'Only active text messages can be edited');
    }
    message.content = { text: text.trim() };
    message.status = 'EDITED';
    message.entityVersion += 1;
    conversation.contextVersion += 1;
    conversation.updatedAt = this.isoNow();
    this.emit(scope, conversation, message, 'MESSAGE_EDITED');
    return accepted();
  }

  async recallMessage(scope: WorkspaceScope, messageId: string): Promise<OperationAccepted> {
    const { conversation, message } = this.scopedMessage(scope, messageId);
    if (message.status === 'RECALLED') return accepted();
    message.status = 'RECALLED';
    message.entityVersion += 1;
    conversation.contextVersion += 1;
    conversation.updatedAt = this.isoNow();
    this.emit(scope, conversation, message, 'MESSAGE_RECALLED');
    return accepted();
  }

  private async ingest(
    scope: WorkspaceScope,
    input: {
      shopId: string;
      buyerId: string;
      conversationId?: string;
      kind: MessageKind;
      content: Record<string, unknown>;
      sentAt?: string;
      forcedSequence?: number;
      externalMessageId?: string;
    },
  ): Promise<OperationAccepted> {
    await this.assertShop(scope, input.shopId);
    this.assertBuyer(scope, input.buyerId);
    const state = this.state(scope);
    let conversation = input.conversationId
      ? this.scopedConversation(scope, input.conversationId)
      : [...state.conversations.values()].find(
          (item) => item.shopId === input.shopId && item.buyerId === input.buyerId,
        );
    const sequence =
      input.forcedSequence ??
      (conversation
        ? Math.max(conversation.lastCommittedSequence, ...conversation.buffered.keys(), 0) + 1
        : 1);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw bad('SEQUENCE_INVALID', 'sequence must be positive');
    if (!conversation) {
      conversation = this.createConversation(scope, input.shopId, input.buyerId, sequence - 1);
      state.conversations.set(conversation.id, conversation);
    }
    if (conversation.shopId !== input.shopId || conversation.buyerId !== input.buyerId) {
      throw bad('CONVERSATION_SCOPE_MISMATCH', 'Conversation does not belong to the selected buyer and shop');
    }
    const externalMessageId = input.externalMessageId ?? `mock_msg_${randomUUID()}`;
    if (conversation.knownExternalMessageIds.has(externalMessageId)) return accepted();
    conversation.knownExternalMessageIds.add(externalMessageId);
    const message: StoredMessage = {
      id: `msg_${randomUUID()}`,
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      platform: 'DOUYIN_DEMO',
      shopId: input.shopId,
      conversationId: conversation.id,
      buyerId: input.buyerId,
      externalMessageId,
      sequence,
      role: 'BUYER',
      kind: input.kind,
      status: 'ACTIVE',
      content: structuredClone(input.content),
      sentAt: input.sentAt ?? this.isoNow(),
      receivedAt: this.isoNow(),
      createdAt: this.isoNow(),
      entityVersion: 1,
    };

    if (sequence <= conversation.lastCommittedSequence) {
      conversation.contextVersion += 1;
      this.commitLate(conversation, scope, message);
    } else if (sequence > conversation.lastCommittedSequence + 1) {
      conversation.buffered.set(sequence, { message, firstBufferedAt: this.now });
      conversation.gapDeadline ??= this.now + 1_000;
    } else {
      const wasDegraded = conversation.syncState === 'DEGRADED';
      this.commit(conversation, scope, message);
      while (conversation.buffered.has(conversation.lastCommittedSequence + 1)) {
        const next = conversation.buffered.get(conversation.lastCommittedSequence + 1)!;
        conversation.buffered.delete(next.message.sequence);
        this.commit(conversation, scope, next.message);
      }
      if (conversation.buffered.size === 0) {
        conversation.gapDeadline = undefined;
        conversation.syncState = 'CONNECTED';
        if (wasDegraded) conversation.contextVersion += 1;
      } else {
        conversation.gapDeadline = this.now + 1_000;
      }
    }
    return accepted();
  }

  private commit(conversation: StoredConversation, scope: WorkspaceScope, message: StoredMessage): void {
    conversation.messages.push(message);
    conversation.messages.sort((left, right) => left.sequence - right.sequence || left.createdAt!.localeCompare(right.createdAt!));
    conversation.lastCommittedSequence = Math.max(conversation.lastCommittedSequence, message.sequence);
    conversation.updatedAt = this.isoNow();
    this.outboxCount += 1;
    this.appendTurn(conversation, message);
    this.emit(scope, conversation, message, 'MESSAGE_RECEIVED');
  }

  private commitLate(conversation: StoredConversation, scope: WorkspaceScope, message: StoredMessage): void {
    conversation.messages.push(message);
    conversation.messages.sort((left, right) => left.sequence - right.sequence || left.createdAt!.localeCompare(right.createdAt!));
    conversation.updatedAt = this.isoNow();
    this.outboxCount += 1;
    conversation.userTurns.push({
      id: `turn_${randomUUID()}`,
      sourceMessageIds: [message.id],
      normalizedText: this.normalizedMessageText(message),
      firstSequence: message.sequence,
      lastSequence: message.sequence,
      generation: 1,
      createdAt: this.isoNow(),
    });
    this.emit(scope, conversation, message, 'MESSAGE_RECEIVED');
  }

  private normalizedMessageText(message: StoredMessage): string {
    if (message.kind === 'TEXT') return String((message.content as { text?: string }).text ?? '');
    if (message.kind === 'GOODS_CARD') return '[商品卡]';
    if (message.kind === 'ORDER_CARD') return '[订单卡]';
    return '[图片]';
  }

  private appendTurn(conversation: StoredConversation, message: StoredMessage): void {
    if (!conversation.turnBuffer) {
      conversation.turnBuffer = {
        openedAt: this.now,
        lastMessageAt: this.now,
        idleDeadline: this.now + 2_000,
        hardDeadline: this.now + 5_000,
        firstSequence: message.sequence,
        latestSequence: message.sequence,
        generation: 1,
      };
    } else {
      conversation.turnBuffer.lastMessageAt = this.now;
      conversation.turnBuffer.idleDeadline = this.now + 2_000;
      conversation.turnBuffer.latestSequence = Math.max(conversation.turnBuffer.latestSequence, message.sequence);
      conversation.turnBuffer.generation += 1;
    }
    this.scheduledTurnConversations.add(conversation.id);
  }

  private async runDueWork(): Promise<void> {
    for (const state of this.workspaces.values()) {
      for (const conversation of state.conversations.values()) {
        if (conversation.gapDeadline !== undefined && conversation.gapDeadline <= this.now && conversation.buffered.size) {
          conversation.syncState = 'DEGRADED';
          conversation.updatedAt = this.isoNow();
          conversation.gapDeadline = undefined;
        }
        const buffer = conversation.turnBuffer;
        if (
          buffer &&
          this.scheduledTurnConversations.has(conversation.id) &&
          Math.min(buffer.idleDeadline, buffer.hardDeadline) <= this.now
        ) {
          this.flushTurn(conversation);
        }
      }
    }
  }

  private flushTurn(conversation: StoredConversation): void {
    const buffer = conversation.turnBuffer;
    if (!buffer) return;
    const source = conversation.messages.filter(
      (message) =>
        message.sequence >= buffer.firstSequence &&
        message.sequence <= buffer.latestSequence &&
        message.status !== 'RECALLED',
    );
    if (!source.length) {
      conversation.turnBuffer = undefined;
      this.scheduledTurnConversations.delete(conversation.id);
      return;
    }
    const normalizedText = source
      .map((message) => this.normalizedMessageText(message))
      .filter(Boolean)
      .join('\n');
    conversation.userTurns.push({
      id: `turn_${randomUUID()}`,
      sourceMessageIds: source.map((message) => message.id),
      normalizedText,
      firstSequence: buffer.firstSequence,
      lastSequence: buffer.latestSequence,
      generation: buffer.generation,
      createdAt: this.isoNow(),
    });
    conversation.turnBuffer = undefined;
    this.scheduledTurnConversations.delete(conversation.id);
    conversation.updatedAt = this.isoNow();
  }

  private createConversation(
    scope: WorkspaceScope,
    shopId: string,
    buyerId: string,
    baselineSequence: number,
  ): StoredConversation {
    const id = `conv_${randomUUID()}`;
    return {
      id,
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId,
      buyerId,
      externalConversationId: `mock_conv_${shopId}_${buyerId}_${Math.floor(this.now / 1_800_000)}`,
      lastCommittedSequence: baselineSequence,
      contextVersion: 1,
      syncState: 'CONNECTED',
      createdAt: this.isoNow(),
      updatedAt: this.isoNow(),
      messages: [],
      buffered: new Map(),
      knownExternalMessageIds: new Set(),
      userTurns: [],
    };
  }

  private summary(scope: WorkspaceScope, conversation: StoredConversation): ConversationSummary {
    const buyer = this.state(scope).buyers.find((item) => item.id === conversation.buyerId)!;
    const lastMessage = conversation.messages.at(-1);
    return {
      id: conversation.id,
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: conversation.shopId,
      buyerId: conversation.buyerId,
      externalConversationId: conversation.externalConversationId,
      state: 'ACTIVE',
      mode: 'ASSIST',
      overrideMode: null,
      effectiveMode: 'ASSIST',
      syncState: conversation.syncState,
      contextVersion: conversation.contextVersion,
      lastCommittedSequence: conversation.lastCommittedSequence,
      activeTopic: null,
      currentProductId: this.currentReference(conversation, 'GOODS_CARD'),
      currentOrderId: this.currentReference(conversation, 'ORDER_CARD'),
      humanActive: false,
      needsReplan: false,
      idleExpiresAt: new Date(new Date(conversation.updatedAt).getTime() + 30 * 60_000).toISOString(),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      unreadCount: conversation.messages.length,
      ...(lastMessage ? { lastMessage: structuredClone(lastMessage) } : {}),
      buyer: { ...buyer, tags: [...buyer.tags] },
    } as ConversationSummary;
  }

  private currentReference(conversation: StoredConversation, kind: 'GOODS_CARD' | 'ORDER_CARD'): string | null {
    const message = [...conversation.messages].reverse().find((item) => item.kind === kind && item.status !== 'RECALLED');
    if (!message) return null;
    return String(
      kind === 'GOODS_CARD'
        ? (message.content as { productId?: string }).productId ?? ''
        : (message.content as { orderId?: string }).orderId ?? '',
    ) || null;
  }

  private state(scope: WorkspaceScope): WorkspaceState {
    let state = this.workspaces.get(scope.workspaceId);
    if (!state) {
      const buyers = BUYER_NAMES.map((displayName, index) => ({
        id: `buyer_${scope.workspaceId}_${index + 1}`,
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        externalBuyerId: `dy_buyer_${String(index + 1).padStart(3, '0')}`,
        displayName,
        avatar: null,
        tags: index === 0 ? ['新客'] : index === 1 ? ['尺码咨询'] : index === 2 ? ['多订单'] : ['图片咨询'],
      }));
      state = { buyers, productsByShop: new Map(), ordersByShop: new Map(), conversations: new Map() };
      this.workspaces.set(scope.workspaceId, state);
    }
    if (state.buyers.some((buyer) => buyer.tenantId !== scope.tenantId)) {
      throw missing('WORKSPACE_NOT_FOUND', 'Workspace not found');
    }
    return state;
  }

  private async assertShop(scope: WorkspaceScope, shopId: string): Promise<void> {
    const shop = await this.workspaceRepository.getShop(scope, shopId);
    if (!shop) throw missing('SHOP_NOT_FOUND', 'Shop not found in this Workspace');
    const state = this.state(scope);
    if (!state.productsByShop.has(shopId)) {
      const products = PRODUCT_TITLES.map((title, index) => ({
        id: `product_${shopId}_${index + 1}`,
        shopId,
        externalProductId: `P-DEMO-${String(index + 1).padStart(3, '0')}`,
        title,
        description: `Synthetic product context for ${title}`,
        status: index === 4 ? 'OFF_SHELF' : 'ON_SHELF',
        recommendable: index !== 4,
        skus: [
          {
            id: `sku_${shopId}_${index + 1}`,
            externalSkuId: `SKU-${index + 1}`,
            attributes: { color: index % 2 ? '白色' : '黑色' },
            price: 99 + index * 50,
            inventory: 12 - index,
          },
        ],
      }));
      const orders = state.buyers.map((buyer, index) => ({
        id: `order_${shopId}_${index + 1}`,
        shopId,
        buyerId: buyer.id,
        productId: products[index % products.length]!.id,
        externalOrderId: `DEMO-${index + 1}`,
        status: index % 2 ? 'SHIPPED' : 'PAID',
        amount: 99 + index * 50,
        orderedAt: new Date(this.now - (index + 1) * 86_400_000).toISOString(),
        shippedAt: index % 2 ? new Date(this.now - index * 3_600_000).toISOString() : null,
        logistics: index % 2 ? { carrier: 'DEMO_EXPRESS', trackingNo: `SYNTH-${index + 1}` } : null,
      }));
      state.productsByShop.set(shopId, products);
      state.ordersByShop.set(shopId, orders);
    }
  }

  private assertBuyer(scope: WorkspaceScope, buyerId: string): void {
    if (!this.state(scope).buyers.some((buyer) => buyer.id === buyerId)) {
      throw missing('BUYER_NOT_FOUND', 'Buyer not found in this Workspace');
    }
  }

  private scopedConversation(scope: WorkspaceScope, conversationId: string): StoredConversation {
    const conversation = this.state(scope).conversations.get(conversationId);
    if (!conversation || conversation.tenantId !== scope.tenantId) {
      throw missing('CONVERSATION_NOT_FOUND', 'Conversation not found in this Workspace');
    }
    return conversation;
  }

  private scopedMessage(scope: WorkspaceScope, messageId: string): { conversation: StoredConversation; message: StoredMessage } {
    for (const conversation of this.state(scope).conversations.values()) {
      const message = conversation.messages.find((item) => item.id === messageId);
      if (message) return { conversation, message };
    }
    throw missing('MESSAGE_NOT_FOUND', 'Message not found in this Workspace');
  }

  private emit(
    scope: WorkspaceScope,
    conversation: StoredConversation,
    message: StoredMessage,
    eventType: 'MESSAGE_RECEIVED' | 'MESSAGE_EDITED' | 'MESSAGE_RECALLED',
  ): void {
    const event: WorkspaceEventEnvelope<{ conversationId: string; message: StoredMessage }> = {
      eventId: `evt_${randomUUID()}`,
      eventType,
      workspaceId: scope.workspaceId,
      entityType: 'MESSAGE',
      entityId: message.id,
      entityVersion: message.entityVersion,
      occurredAt: this.isoNow(),
      payload: { conversationId: conversation.id, message: structuredClone(message) },
    };
    this.publisher?.publish(event);
  }

  private isoNow(): string {
    return new Date(this.now).toISOString();
  }
}

function accepted(): OperationAccepted {
  return { operationId: `op_${randomUUID()}`, status: 'ACCEPTED' };
}

function missing(code: string, message: string): NotFoundException {
  return new NotFoundException({ code, message });
}

function bad(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}
