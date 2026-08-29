import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  ConversationSyncState,
  MessageKind as PrismaMessageKind,
  MessageRole as PrismaMessageRole,
  MessageStatus as PrismaMessageStatus,
  Prisma,
  ProcessingOutboxStatus,
  ReorderBufferStatus,
  TurnBufferStatus,
} from '@prisma/client';
import type {
  BuyerMessageCommand,
  BuyerOrderCardCommand,
  BuyerProductCardCommand,
  ConversationSnapshot,
  ConversationSummary,
  Message,
  MessageKind,
  WorkspaceEventEnvelope,
} from '@ai-customer-service/contracts';
import {
  MockDouyinAdapter,
  MockDouyinNotFoundError,
  type MockDouyinMessage,
} from '@ai-customer-service/mock-douyin';
import { Queue, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { AttachmentService } from '../attachments/attachments.service';
import { bindImageAttachmentToConversation } from '../attachments/attachment-conversation-binding';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceGateway } from '../websocket/workspace.gateway';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { ConversationMemoryService } from '../ai/conversation-memory.service';
import { effectiveConversationMode } from '../replies/effective-conversation-mode';
import { ReplyJobService } from '../replies/reply-job.service';
import { ReplyDraftService } from '../replies/reply-draft.service';
import { ReplyRuntimeService } from '../replies/reply-runtime.service';
import { ScheduledConversationMessageService } from '../replies/scheduled-conversation-message.service';
import { ConversationTransportMutex, localConversationTransportMutex, transportMutexKey, transportShopMutexKey } from '../replies/conversation-transport-mutex.service';
import { TraceService } from '../trace/trace.service';
import { WorkflowRouterService } from '../workflow/workflow-router.service';
import type { ConversationMemoryRebuildRequest } from '../ai/conversation-memory.scheduler';
import type {
  BuyerView,
  MessageApplication,
  OperationAccepted,
  OrderView,
  ProductView,
} from './message.application';

type RuntimeJob =
  | { kind: 'OUTBOX'; eventId: string }
  | { kind: 'TURN_FLUSH'; conversationId: string; generation: number }
  | { kind: 'GAP_CHECK'; conversationId: string };

type NormalizedIncoming = {
  platform: 'DOUYIN_DEMO';
  externalMessageId: string;
  shopId: string;
  buyerId: string;
  conversationId: string;
  sequence: number;
  kind: MessageKind;
  content: Record<string, unknown>;
  sentAt: string;
  receivedAt: string;
};

type IngestInput = Omit<NormalizedIncoming, 'platform' | 'externalMessageId' | 'conversationId' | 'sequence' | 'receivedAt'> & {
  conversationId?: string;
  externalConversationId?: string;
  externalMessageId?: string;
  forcedSequence?: number;
};

type MessageMutation = {
  message: Record<string, unknown>;
  rebuildRequest?: ConversationMemoryRebuildRequest;
};

function runtimeJobId(kind: string, eventId: string): string {
  return `${kind}-${createHash('sha256').update(eventId).digest('hex')}`;
}

@Injectable()
export class PrismaMessageApplication implements MessageApplication, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaMessageApplication.name);
  private readonly localTimers = new Set<NodeJS.Timeout>();
  private queue?: Queue<RuntimeJob>;
  private worker?: Worker<RuntimeJob>;
  private queueRedis?: Redis;
  private workerRedis?: Redis;
  private dispatcherTimer?: NodeJS.Timeout;
  private dispatchPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: WorkspaceGateway,
    private readonly adapter: MockDouyinAdapter,
    private readonly attachments: AttachmentService,
    private readonly conversationMemory: ConversationMemoryService,
    private readonly replyJobs?: ReplyJobService,
    private readonly replyDrafts?: ReplyDraftService,
    private readonly replyRuntime?: ReplyRuntimeService,
    private readonly scheduledMessages?: ScheduledConversationMessageService,
    private readonly transportMutex: ConversationTransportMutex = localConversationTransportMutex,
    private readonly traces?: TraceService,
    private readonly workflowRouter?: WorkflowRouterService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Repository-backed integration suites replace only the slices they use.
    // Avoid opening a production persistence runtime when no database has been
    // configured; real startup always supplies DATABASE_URL via .env.
    if (!process.env.DATABASE_URL?.trim()) return;
    const redisUrl = process.env.REDIS_URL?.trim();
    if (redisUrl) {
      this.queueRedis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
      this.workerRedis = this.queueRedis.duplicate();
      this.queue = new Queue<RuntimeJob>('processing-outbox', { connection: this.queueRedis });
      this.worker = new Worker<RuntimeJob>(
        'processing-outbox',
        async (job) => this.processRuntimeJob(job),
        { connection: this.workerRedis, concurrency: 8 },
      );
      this.worker.on('failed', (job, error) => {
        this.logger.error(`Runtime job ${job?.id ?? 'unknown'} failed: ${error.message}`);
      });
    }

    await this.recoverDurableWork();
    this.dispatcherTimer = setInterval(() => {
      void this.dispatchPending().catch((error: unknown) => this.logger.error(this.errorMessage(error)));
    }, 500);
    this.dispatcherTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.dispatcherTimer) clearInterval(this.dispatcherTimer);
    for (const timer of this.localTimers) clearTimeout(timer);
    this.localTimers.clear();
    await this.dispatchPromise;
    await this.worker?.close();
    await this.queue?.close();
    await this.workerRedis?.quit();
    await this.queueRedis?.quit();
  }

  async listBuyers(scope: WorkspaceScope, shopId?: string): Promise<BuyerView[]> {
    if (shopId) await this.assertShop(scope, shopId);
    const normalizedScope = this.scope(scope);
    const buyers = await this.prisma.buyer.findMany({
      where: {
        ...normalizedScope,
        ...(shopId ? {
          OR: [
            { orders: { some: { ...normalizedScope, shopId } } },
            { conversations: { some: { ...normalizedScope, shopId } } },
          ],
        } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    return buyers.map((buyer) => ({
      id: buyer.id,
      workspaceId: buyer.workspaceId,
      tenantId: buyer.tenantId,
      displayName: buyer.displayName,
      avatar: buyer.avatar,
      tags: this.stringArray(buyer.tagsJson),
    }));
  }

  async listProducts(scope: WorkspaceScope, shopId: string): Promise<ProductView[]> {
    await this.assertShop(scope, shopId);
    const products = await this.prisma.product.findMany({
      where: { ...this.scope(scope), shopId },
      include: { skus: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return products.map((product) => ({
      id: product.id,
      shopId: product.shopId,
      title: product.title,
      description: product.description,
      status: product.status,
      recommendable: product.recommendable,
      skus: product.skus.map((sku) => ({
        id: sku.id,
        externalSkuId: sku.externalSkuId,
        attributes: this.stringRecord(sku.attributesJson),
        price: Number(sku.price),
        inventory: sku.inventory,
      })),
    }));
  }

  async listOrders(scope: WorkspaceScope, shopId: string, buyerId?: string): Promise<OrderView[]> {
    await this.assertShop(scope, shopId);
    if (buyerId) await this.assertBuyer(scope, buyerId);
    const orders = await this.prisma.order.findMany({
      where: { ...this.scope(scope), shopId, ...(buyerId ? { buyerId } : {}) },
      orderBy: { orderedAt: 'desc' },
    });
    return orders.map((order) => ({
      id: order.id,
      shopId: order.shopId,
      buyerId: order.buyerId,
      productId: order.productId,
      externalOrderId: order.externalOrderId,
      status: order.status,
      amount: Number(order.amount),
      orderedAt: order.orderedAt.toISOString(),
      shippedAt: order.shippedAt?.toISOString() ?? null,
      logistics: this.recordOrNull(order.logisticsSnapshotJson),
    }));
  }

  async listConversations(scope: WorkspaceScope, shopId: string): Promise<ConversationSummary[]> {
    await this.assertShop(scope, shopId);
    const conversations = await this.prisma.conversation.findMany({
      where: { ...this.scope(scope), shopId },
      include: {
        buyer: true,
        shop: { select: { aiMode: true } },
        messages: { orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }], take: 1 },
        replyJobs: {
          where: { status: { in: ['PENDING', 'GENERATING', 'FAST_PATH_READY', 'WAITING_HUMAN', 'CANCELLING', 'RECOVERY_PENDING'] } },
          orderBy: { updatedAt: 'desc' }, take: 1, include: { draft: true, sendOutbox: true },
        },
        sendOutboxes: { orderBy: { updatedAt: 'desc' }, take: 1 },
      },
      orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
    });
    return conversations.map((conversation) => this.toSummary(conversation));
  }

  async getConversation(scope: WorkspaceScope, conversationId: string): Promise<ConversationSnapshot> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, ...this.scope(scope) },
      include: {
        buyer: true,
        shop: { select: { aiMode: true } },
        messages: { orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }], include: { _count: { select: { versions: true } } } },
        turnBuffer: true,
        userTurns: { orderBy: { createdAt: 'asc' } },
        currentProduct: true,
        currentOrder: true,
        memory: true,
        replyJobs: {
          where: { status: { in: ['PENDING', 'GENERATING', 'FAST_PATH_READY', 'WAITING_HUMAN', 'CANCELLING', 'RECOVERY_PENDING'] } },
          orderBy: { updatedAt: 'desc' }, take: 1,
          include: { draft: true, sendOutbox: true, evidences: true },
        },
        tasks: { orderBy: { createdAt: 'asc' } },
        sendOutboxes: { orderBy: { updatedAt: 'desc' }, take: 1 },
      },
    });
    if (!conversation) throw missing('CONVERSATION_NOT_FOUND', 'Conversation not found in this Workspace');
    const lastMessage = conversation.messages.at(-1);
    return {
      ...this.toSummary({ ...conversation, messages: lastMessage ? [lastMessage] : [] }),
      messages: conversation.messages.map((message) => this.toMessage(message, message._count.versions + 1)),
      turnBuffer: conversation.turnBuffer
        ? {
            key: conversation.turnBuffer.id,
            workspaceId: conversation.workspaceId,
            tenantId: conversation.tenantId,
            shopId: conversation.shopId,
            conversationId: conversation.id,
            buyerId: conversation.buyerId,
            firstSequence: conversation.turnBuffer.firstSequence,
            latestSequence: conversation.turnBuffer.latestSequence,
            openedAt: conversation.turnBuffer.openedAt.toISOString(),
            lastMessageAt: conversation.turnBuffer.lastMessageAt.toISOString(),
            idleDeadline: conversation.turnBuffer.idleDeadline.toISOString(),
            hardDeadline: conversation.turnBuffer.hardDeadline.toISOString(),
            generation: conversation.turnBuffer.generation,
            status: conversation.turnBuffer.status,
          }
        : null,
      userTurns: conversation.userTurns.map((turn) => ({
        id: turn.id,
        sourceMessageIds: this.stringArray(turn.sourceMessageIdsJson),
        normalizedText: turn.normalizedText,
        firstSequence: turn.firstSequence,
        lastSequence: turn.lastSequence,
        generation: this.generationFromTurnKey(turn.turnKey),
        status: turn.status,
        createdAt: turn.createdAt.toISOString(),
        updatedAt: turn.updatedAt.toISOString(),
      })),
      currentProduct: conversation.currentProduct
        ? {
            id: conversation.currentProduct.id,
            title: conversation.currentProduct.title,
            status: conversation.currentProduct.status,
            recommendable: conversation.currentProduct.recommendable,
          }
        : null,
      currentOrder: conversation.currentOrder
        ? {
            id: conversation.currentOrder.id,
            externalOrderId: conversation.currentOrder.externalOrderId,
            status: conversation.currentOrder.status,
            amount: Number(conversation.currentOrder.amount),
          }
        : null,
      summary: conversation.memory
        ? {
            conversationId: conversation.id,
            narrativeSummary: conversation.memory.narrative,
            ...this.record(conversation.memory.structuredFactsJson),
            summaryVersion: conversation.memory.summaryVersion,
            basedOnThroughSequence: conversation.memory.basedOnThroughSequence,
            status: conversation.memory.status,
            updatedAt: conversation.memory.updatedAt.toISOString(),
          }
        : null,
      ...(conversation.replyJobs?.[0]
        ? {
            activeReplyJobId: conversation.replyJobs[0].id,
            activeReplyJob: this.toReplyJob(conversation.replyJobs[0]),
            currentDraft: conversation.replyJobs[0].draft ? this.toReplyDraft(conversation.replyJobs[0].draft) : null,
          }
        : { activeReplyJobId: null, activeReplyJob: null, currentDraft: null }),
      sendOutbox: conversation.sendOutboxes?.[0] ? this.toSendOutbox(conversation.sendOutboxes[0]) : null,
      taskBundle: this.toTaskBundle(conversation.tasks ?? [], conversation.replyJobs?.[0]?.userTurnId),
    };
  }

  async sendMessage(scope: WorkspaceScope, input: BuyerMessageCommand): Promise<OperationAccepted> {
    if (input.kind === 'TEXT') {
      const text = input.text?.trim() ?? '';
      if (!text) throw bad('MESSAGE_TEXT_REQUIRED', 'text is required');
      const platform = await this.platformContext(scope, input.shopId, input.buyerId, input.conversationId);
      const event = await this.adapter.sendMessage({
        ...this.scope(scope),
        shopId: input.shopId,
        externalBuyerId: platform.externalBuyerId,
        externalConversationId: platform.externalConversationId,
        text,
        externalMessageId: input.duplicateExternalMessageId,
        sequence: input.forcedSequence ?? platform.nextSequence,
        sentAt: input.sentAt,
      });
      const platformMessage = event.payload.message!;
      return this.ingest(scope, {
        shopId: input.shopId,
        buyerId: input.buyerId,
        conversationId: input.conversationId ?? platform.conversationId,
        externalConversationId: platformMessage.externalConversationId,
        kind: input.kind,
        content: { text },
        sentAt: platformMessage.sentAt,
        forcedSequence: platformMessage.sequence,
        externalMessageId: platformMessage.externalMessageId,
      });
    }

    const attachmentId = input.attachmentId?.trim();
    if (!attachmentId) throw bad('ATTACHMENT_ID_REQUIRED', 'attachmentId is required for image messages');
    const attachment = await this.attachments.get({ ...scope, shopId: input.shopId, buyerId: input.buyerId }, attachmentId);
    if (attachment.shopId !== input.shopId || attachment.buyerId !== input.buyerId) {
      throw bad('ATTACHMENT_SCOPE_MISMATCH', 'Attachment does not belong to the selected shop and buyer');
    }
    if (input.kind === 'IMAGE') {
      const conversationId = input.conversationId ?? await this.activeConversationId(scope, input.shopId, input.buyerId);
      return this.ingest(scope, {
        shopId: input.shopId,
        buyerId: input.buyerId,
        conversationId,
        kind: input.kind,
        content: {
          attachmentId,
          analysisStatus: 'READY',
          containsPII: attachment.containsPII,
          analysis: attachment.analysis ?? null,
        },
        sentAt: input.sentAt ?? new Date().toISOString(),
        forcedSequence: input.forcedSequence,
        externalMessageId: input.duplicateExternalMessageId,
      });
    }
    throw bad('MESSAGE_KIND_UNSUPPORTED', 'Unsupported buyer message kind');
  }

  async sendProductCard(scope: WorkspaceScope, input: BuyerProductCardCommand): Promise<OperationAccepted> {
    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, ...this.scope(scope), shopId: input.shopId },
    });
    if (!product) throw missing('PRODUCT_NOT_FOUND', 'Product not found in this shop');
    const platform = await this.platformContext(scope, input.shopId, input.buyerId, input.conversationId);
    const event = await this.adapter.sendProductCard({
      ...this.scope(scope),
      shopId: input.shopId,
      externalBuyerId: platform.externalBuyerId,
      externalConversationId: platform.externalConversationId,
      product: { externalProductId: product.externalProductId, title: product.title },
      sequence: input.forcedSequence ?? platform.nextSequence,
      sentAt: input.sentAt,
    });
    const platformMessage = event.payload.message!;
    return this.ingest(scope, {
      shopId: input.shopId,
      buyerId: input.buyerId,
      conversationId: input.conversationId ?? platform.conversationId,
      externalConversationId: platformMessage.externalConversationId,
      kind: 'GOODS_CARD',
      content: { productId: product.id, externalProductId: product.externalProductId, title: product.title },
      sentAt: platformMessage.sentAt,
      forcedSequence: platformMessage.sequence,
      externalMessageId: platformMessage.externalMessageId,
    });
  }

  async sendOrderCard(scope: WorkspaceScope, input: BuyerOrderCardCommand): Promise<OperationAccepted> {
    const order = await this.prisma.order.findFirst({
      where: {
        id: input.orderId,
        ...this.scope(scope),
        shopId: input.shopId,
        buyerId: input.buyerId,
      },
    });
    if (!order) throw missing('ORDER_NOT_FOUND', 'Order not found for this buyer and shop');
    const platform = await this.platformContext(scope, input.shopId, input.buyerId, input.conversationId);
    const event = await this.adapter.sendOrderCard({
      ...this.scope(scope),
      shopId: input.shopId,
      externalBuyerId: platform.externalBuyerId,
      externalConversationId: platform.externalConversationId,
      order: { externalOrderId: order.externalOrderId, status: order.status, amount: Number(order.amount) },
      sequence: input.forcedSequence ?? platform.nextSequence,
      sentAt: input.sentAt,
    });
    const platformMessage = event.payload.message!;
    return this.ingest(scope, {
      shopId: input.shopId,
      buyerId: input.buyerId,
      conversationId: input.conversationId ?? platform.conversationId,
      externalConversationId: platformMessage.externalConversationId,
      kind: 'ORDER_CARD',
      content: { orderId: order.id, externalOrderId: order.externalOrderId, status: order.status },
      sentAt: platformMessage.sentAt,
      forcedSequence: platformMessage.sequence,
      externalMessageId: platformMessage.externalMessageId,
    });
  }

  async editMessage(scope: WorkspaceScope, messageId: string, text: string): Promise<OperationAccepted> {
    const current = await this.platformMessageContext(scope, messageId);
    try {
      await this.adapter.editMessage({
        ...this.scope(scope),
        shopId: current.shopId,
        externalMessageId: current.externalMessageId,
        text: text.trim(),
      });
    } catch (error) {
      if (!(error instanceof MockDouyinNotFoundError)) throw error;
      this.logger.warn(`Synthetic adapter state was rebuilt before edit ${messageId}; database projection remains authoritative`);
    }
    const mutation = await this.mutateMessage(scope, messageId, 'EDITED', { text: text.trim() }, current.shopId, current.conversationId);
    if (mutation.rebuildRequest) await this.conversationMemory.scheduleRebuild(mutation.rebuildRequest);
    this.publishMessage(scope, mutation.message, 'MESSAGE_EDITED');
    await this.publishConversation(scope, String(mutation.message.conversationId));
    return accepted();
  }

  async recallMessage(scope: WorkspaceScope, messageId: string): Promise<OperationAccepted> {
    const current = await this.platformMessageContext(scope, messageId);
    try {
      await this.adapter.recallMessage({
        ...this.scope(scope),
        shopId: current.shopId,
        externalMessageId: current.externalMessageId,
      });
    } catch (error) {
      if (!(error instanceof MockDouyinNotFoundError)) throw error;
      this.logger.warn(`Synthetic adapter state was rebuilt before recall ${messageId}; database projection remains authoritative`);
    }
    const mutation = await this.mutateMessage(scope, messageId, 'RECALLED', undefined, current.shopId, current.conversationId);
    if (mutation.rebuildRequest) await this.conversationMemory.scheduleRebuild(mutation.rebuildRequest);
    this.publishMessage(scope, mutation.message, 'MESSAGE_RECALLED');
    await this.publishConversation(scope, String(mutation.message.conversationId));
    return accepted();
  }

  private async ingest(scope: WorkspaceScope, input: IngestInput): Promise<OperationAccepted> {
    await Promise.all([this.assertShop(scope, input.shopId), this.assertBuyer(scope, input.buyerId)]);
    const now = new Date();
    const transportScope = { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: input.shopId };
    const result = await this.transportMutex.runMany([transportShopMutexKey(transportScope), transportMutexKey(transportScope, input.conversationId ?? input.buyerId)], () => this.prisma.$transaction(async (tx) => {
      await this.lock(tx, `${scope.workspaceId}:${scope.tenantId}:${input.shopId}:${input.buyerId}`);
      let conversation = input.conversationId
        ? await tx.conversation.findFirst({ where: { id: input.conversationId, ...this.scope(scope) } })
        : await tx.conversation.findFirst({
            where: {
              ...this.scope(scope),
              shopId: input.shopId,
              buyerId: input.buyerId,
              state: 'ACTIVE',
              OR: [{ idleExpiresAt: null }, { idleExpiresAt: { gt: now } }],
            },
            orderBy: { updatedAt: 'desc' },
          });
      if (input.conversationId && !conversation) {
        throw missing('CONVERSATION_NOT_FOUND', 'Conversation not found in this Workspace');
      }
      const requestedSequence = input.forcedSequence;
      if (requestedSequence !== undefined && (!Number.isSafeInteger(requestedSequence) || requestedSequence < 1)) {
        throw bad('SEQUENCE_INVALID', 'forcedSequence must be a positive safe integer');
      }
      let createdConversation = false;
      if (!conversation) {
        const baseline = requestedSequence ? requestedSequence - 1 : 0;
        conversation = await tx.conversation.create({
          data: {
            ...this.scope(scope),
            shopId: input.shopId,
            buyerId: input.buyerId,
            externalConversationId: input.externalConversationId ?? `mock_conv_${randomUUID()}`,
            lastCommittedSequence: baseline,
            idleExpiresAt: new Date(now.getTime() + 30 * 60_000),
          },
        });
        createdConversation = true;
      }
      if (conversation.shopId !== input.shopId || conversation.buyerId !== input.buyerId) {
        throw bad('CONVERSATION_SCOPE_MISMATCH', 'Conversation does not belong to the selected buyer and shop');
      }
      await this.lock(tx, conversation.id);
      const maxBuffered = await tx.reorderBufferEntry.aggregate({
        where: { ...this.scope(scope), conversationId: conversation.id, status: ReorderBufferStatus.BUFFERED },
        _max: { sequence: true },
      });
      const sequence = requestedSequence ?? Math.max(conversation.lastCommittedSequence, maxBuffered._max.sequence ?? 0) + 1;
      const externalMessageId = input.externalMessageId ?? `mock_msg_${randomUUID()}`;
      const duplicate =
        (await tx.message.findFirst({
          where: {
            ...this.scope(scope),
            platform: 'DOUYIN_DEMO',
            shopId: input.shopId,
            OR: [{ externalMessageId }, { conversationId: conversation.id, sequence }],
          },
          select: { id: true },
        })) ??
        (await tx.reorderBufferEntry.findFirst({
          where: {
            ...this.scope(scope),
            conversationId: conversation.id,
            OR: [{ externalMessageId }, { sequence }],
          },
          select: { id: true },
        }));
      if (duplicate) return {
        committed: [] as Array<Record<string, unknown>>,
        gap: null as null | { conversationId: string; deadline: Date },
        lateRebuildRequest: undefined as ConversationMemoryRebuildRequest | undefined,
      };

      // Claim only a newly accepted image event. This remains in the same
      // transaction as the eventual persisted message/reorder entry, while a
      // duplicate external event cannot accidentally consume an unbound image.
      if (input.kind === 'IMAGE' && typeof input.content.attachmentId === 'string') {
        await bindImageAttachmentToConversation(tx as unknown as Parameters<typeof bindImageAttachmentToConversation>[0], scope, {
          attachmentId: input.content.attachmentId,
          shopId: input.shopId,
          buyerId: input.buyerId,
          conversationId: conversation.id,
        });
      }

      const incoming: NormalizedIncoming = {
        platform: 'DOUYIN_DEMO',
        externalMessageId,
        shopId: input.shopId,
        buyerId: input.buyerId,
        conversationId: conversation.id,
        sequence,
        kind: input.kind,
        content: input.content,
        sentAt: input.sentAt,
        receivedAt: now.toISOString(),
      };
      if (sequence > conversation.lastCommittedSequence + 1) {
        await tx.reorderBufferEntry.create({
          data: {
            ...this.scope(scope),
            shopId: input.shopId,
            conversationId: conversation.id,
            platform: incoming.platform,
            eventId: randomUUID(),
            externalMessageId,
            sequence,
            payloadJson: incoming as unknown as Prisma.InputJsonValue,
            firstBufferedAt: now,
          },
        });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { syncState: ConversationSyncState.RECONCILING },
        });
        return {
          committed: [] as Array<Record<string, unknown>>,
          gap: { conversationId: conversation.id, deadline: new Date(now.getTime() + 1_000) },
          lateRebuildRequest: undefined as ConversationMemoryRebuildRequest | undefined,
        };
      }

      const committed: Array<Record<string, unknown>> = [];
      const wasDegraded = conversation.syncState === ConversationSyncState.DEGRADED;
      let finalCommittedSequence = conversation.lastCommittedSequence;
      let lateRebuildRequest: ConversationMemoryRebuildRequest | undefined;
      if (sequence <= conversation.lastCommittedSequence) {
        committed.push(await this.persistCommitted(tx, scope, incoming, true));
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { contextVersion: { increment: 1 }, needsReplan: true, lastMessageAt: now, updatedAt: now },
        });
        // This is deliberately part of the same transaction as the late
        // message and its context-version invalidation. If this process stops
        // before the post-commit in-memory scheduling below, DIRTY remains a
        // durable recovery signal for ConversationMemoryRebuildWorker.
        const invalidated = await tx.conversationMemory.updateMany({
          where: {
            ...this.scope(scope),
            shopId: conversation.shopId,
            conversationId: conversation.id,
            basedOnThroughSequence: { gte: sequence },
          },
          data: { status: 'DIRTY' },
        });
        if (invalidated.count > 0) {
          lateRebuildRequest = {
            workspaceId: scope.workspaceId,
            tenantId: scope.tenantId,
            shopId: conversation.shopId,
            conversationId: conversation.id,
            reason: 'LATE_MESSAGE',
          };
        }
      } else {
        committed.push(await this.persistCommitted(tx, scope, incoming));
        let lastCommittedSequence = sequence;
        while (true) {
          const buffered = await tx.reorderBufferEntry.findFirst({
            where: {
              ...this.scope(scope),
              conversationId: conversation.id,
              sequence: lastCommittedSequence + 1,
              status: ReorderBufferStatus.BUFFERED,
            },
          });
          if (!buffered) break;
          const bufferedIncoming = this.incomingFromJson(buffered.payloadJson);
          committed.push(await this.persistCommitted(tx, scope, bufferedIncoming));
          await tx.reorderBufferEntry.update({
            where: { id: buffered.id },
            data: { status: ReorderBufferStatus.COMMITTED },
          });
          lastCommittedSequence += 1;
        }
        const remaining = await tx.reorderBufferEntry.count({
          where: { ...this.scope(scope), conversationId: conversation.id, status: ReorderBufferStatus.BUFFERED },
        });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            lastCommittedSequence,
            lastMessageAt: now,
            idleExpiresAt: new Date(now.getTime() + 30 * 60_000),
            syncState: remaining ? ConversationSyncState.RECONCILING : ConversationSyncState.CONNECTED,
            ...(wasDegraded && !remaining ? { contextVersion: { increment: 1 }, needsReplan: true } : {}),
          },
        });
        finalCommittedSequence = lastCommittedSequence;
      }
      if (createdConversation && this.scheduledMessages && committed.length > 0) {
        const lastCommitted = committed.at(-1);
        const lastMessageId = lastCommitted && typeof lastCommitted.id === 'string' ? lastCommitted.id : undefined;
        const finalConversation = await tx.conversation.findFirst({
          where: { id: conversation.id, ...this.scope(scope), shopId: input.shopId },
          select: { contextVersion: true, lastCommittedSequence: true },
        });
        const settings = await tx.shopSettings.findFirst({
          where: { ...this.scope(scope), shopId: input.shopId }, select: { welcomeMessage: true },
        });
        const welcome = settings?.welcomeMessage?.trim();
        if (welcome) {
          await this.scheduledMessages.planWelcomeInTransaction(tx, {
            workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: input.shopId,
          }, {
            id: conversation.id, contextVersion: finalConversation?.contextVersion ?? conversation.contextVersion,
            lastCommittedSequence: finalConversation?.lastCommittedSequence ?? finalCommittedSequence, lastMessageId,
          }, welcome, now);
        }
      }
      return {
        committed,
        gap: null as null | { conversationId: string; deadline: Date },
        lateRebuildRequest,
      };
    }));

    const updatedConversations = new Set<string>();
    for (const message of result.committed) {
      this.publishMessage(scope, message, 'MESSAGE_RECEIVED');
      updatedConversations.add(String(message.conversationId));
      const value = message as { id?: string; conversationId?: string; shopId?: string; sequence?: number; kind?: string };
      if (value.id && value.conversationId && value.shopId) void this.traces?.record({ ...scope, shopId: value.shopId, conversationId: value.conversationId }, `conversation:${value.conversationId}`, 'MESSAGE_COMMITTED', { messageId: value.id, sequence: value.sequence ?? null, kind: value.kind ?? 'TEXT', senderRole: 'BUYER' });
    }
    for (const conversationId of updatedConversations) await this.publishConversation(scope, conversationId);
    if (result.lateRebuildRequest) await this.conversationMemory.scheduleRebuild(result.lateRebuildRequest);
    if (result.gap) await this.scheduleGapCheck(result.gap.conversationId, result.gap.deadline);
    void this.dispatchPending().catch((error: unknown) => this.logger.error(this.errorMessage(error)));
    return accepted();
  }

  private async persistCommitted(
    tx: Prisma.TransactionClient,
    scope: WorkspaceScope,
    incoming: NormalizedIncoming,
    late = false,
  ): Promise<Record<string, unknown>> {
    const message = await tx.message.create({
      data: {
        ...this.scope(scope),
        platform: incoming.platform,
        shopId: incoming.shopId,
        conversationId: incoming.conversationId,
        buyerId: incoming.buyerId,
        externalMessageId: incoming.externalMessageId,
        sequence: incoming.sequence,
        role: PrismaMessageRole.BUYER,
        kind: incoming.kind as PrismaMessageKind,
        contentJson: incoming.content as Prisma.InputJsonValue,
        sentAt: new Date(incoming.sentAt),
        receivedAt: new Date(incoming.receivedAt),
      },
    });
    await tx.processingOutbox.create({
      data: {
        ...this.scope(scope),
        shopId: incoming.shopId,
        eventId: randomUUID(),
        aggregateType: 'MESSAGE',
        aggregateId: message.id,
        eventType: 'MESSAGE_RECEIVED',
        payloadJson: {
          messageId: message.id,
          conversationId: incoming.conversationId,
          sequence: incoming.sequence,
          late,
        },
      },
    });
    await tx.conversation.update({
      where: { id: incoming.conversationId },
      // A buyer turn is an authoritative context change even before the
      // coalescing window flushes.  Stale drafts/jobs must not survive the
      // two-second buffer interval and a generation's final CAS now sees it.
      data: {
        unreadCount: { increment: 1 },
        lastMessageAt: new Date(incoming.receivedAt),
        contextVersion: { increment: 1 },
        needsReplan: true,
      },
    });
    await this.replyDrafts?.staleForContext(
      tx,
      { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: incoming.shopId },
      incoming.conversationId,
      'NEW_BUYER_MESSAGE',
    );
    const productId = incoming.kind === 'GOODS_CARD' ? incoming.content.productId : undefined;
    const orderId = incoming.kind === 'ORDER_CARD' ? incoming.content.orderId : undefined;
    if (typeof productId === 'string' || typeof orderId === 'string') {
      const newerCard = await tx.message.findFirst({
        where: {
          conversationId: incoming.conversationId,
          kind: incoming.kind as PrismaMessageKind,
          status: { not: PrismaMessageStatus.RECALLED },
          sequence: { gt: incoming.sequence },
        },
        select: { id: true },
      });
      if (!newerCard) {
        await tx.conversation.update({
          where: { id: incoming.conversationId },
          data: {
            ...(typeof productId === 'string' ? { currentProductId: productId } : {}),
            ...(typeof orderId === 'string' ? { currentOrderId: orderId } : {}),
          },
        });
      }
    }
    return message as unknown as Record<string, unknown>;
  }

  private async mutateMessage(
    scope: WorkspaceScope,
    messageId: string,
    status: 'EDITED' | 'RECALLED',
    content?: Record<string, unknown>,
    knownShopId?: string,
    knownConversationId?: string,
  ): Promise<MessageMutation> {
    const commit = () => this.prisma.$transaction(async (tx) => {
      const reference = await tx.message.findFirst({
        where: { id: messageId, ...this.scope(scope) },
        select: { conversationId: true },
      });
      if (!reference) throw missing('MESSAGE_NOT_FOUND', 'Message not found in this Workspace');
      await this.lock(tx, reference.conversationId);
      const message = await tx.message.findFirst({
        where: { id: messageId, ...this.scope(scope) },
        include: { _count: { select: { versions: true } } },
      });
      if (!message) throw missing('MESSAGE_NOT_FOUND', 'Message not found in this Workspace');
      // These commands are exposed only under /buyer. Do not let a guessed
      // outgoing message id turn the buyer recall route into an operator
      // privilege that can hide AI/HUMAN replies.
      if (message.role !== PrismaMessageRole.BUYER) {
        throw bad('BUYER_MESSAGE_REQUIRED', 'Only buyer messages can be edited or recalled through this endpoint');
      }
      if (
        status === 'EDITED'
        && (message.kind !== PrismaMessageKind.TEXT
          || message.status === PrismaMessageStatus.RECALLED
          || message.status === PrismaMessageStatus.DELETED)
      ) {
        throw bad('MESSAGE_NOT_EDITABLE', 'Only active text messages can be edited');
      }
      if (status === 'RECALLED' && message.status === PrismaMessageStatus.RECALLED) {
        return { message: message as unknown as Record<string, unknown> };
      }
      if (message.status === PrismaMessageStatus.DELETED) {
        throw bad('MESSAGE_PRIVACY_DELETED', 'Privacy-deleted messages cannot be changed');
      }
      await tx.messageVersion.create({
        data: {
          ...this.scope(scope),
          messageId,
          version: message._count.versions + 1,
          status: message.status,
          contentJson: message.contentJson === null ? Prisma.JsonNull : message.contentJson,
        },
      });
      const updated = await tx.message.update({
        where: { id: messageId },
        data: {
          status: status === 'EDITED' ? PrismaMessageStatus.EDITED : PrismaMessageStatus.RECALLED,
          ...(content ? { contentJson: content as Prisma.InputJsonValue } : {}),
        },
      });
      let recalledContext: { currentProductId?: string | null; currentOrderId?: string | null } = {};
      if (
        status === 'RECALLED' &&
        (message.kind === PrismaMessageKind.GOODS_CARD || message.kind === PrismaMessageKind.ORDER_CARD)
      ) {
        const latestCard = await tx.message.findFirst({
          where: {
            ...this.scope(scope),
            conversationId: message.conversationId,
            kind: message.kind,
            status: { not: PrismaMessageStatus.RECALLED },
          },
          orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }],
        });
        const latestContent = this.record(latestCard?.contentJson);
        recalledContext =
          message.kind === PrismaMessageKind.GOODS_CARD
            ? { currentProductId: typeof latestContent.productId === 'string' ? latestContent.productId : null }
            : { currentOrderId: typeof latestContent.orderId === 'string' ? latestContent.orderId : null };
      }
      await tx.conversation.update({
        where: { id: message.conversationId },
        data: { contextVersion: { increment: 1 }, needsReplan: true, ...recalledContext },
      });
      // Edit/recall changes the source snapshot of every waiting draft. Mark
      // them stale in the same transaction; no delayed worker may send them.
      await this.replyDrafts?.staleForContext(
        tx,
        { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: message.shopId },
        message.conversationId,
        status === 'EDITED' ? 'MESSAGE_EDITED' : 'MESSAGE_RECALLED',
      );
      // Do not restrict this to CLEAN rows. A second edit while a prior
      // rebuild is pending must re-enqueue the same conversation; the
      // coalescing scheduler folds it into one fresh rebuild after commit.
      const dirtied = await tx.conversationMemory.updateMany({
        where: {
          ...this.scope(scope),
          conversationId: message.conversationId,
          basedOnThroughSequence: { gte: message.sequence },
        },
        data: { status: 'DIRTY' },
      });
      return {
        message: { ...updated, entityVersion: message._count.versions + 2 } as unknown as Record<string, unknown>,
        ...(dirtied.count > 0
          ? {
              rebuildRequest: {
                workspaceId: scope.workspaceId,
                tenantId: scope.tenantId,
                shopId: message.shopId,
                conversationId: message.conversationId,
                reason: 'MESSAGE_MUTATED' as const,
              },
            }
          : {}),
      };
    });
    return knownShopId && knownConversationId
      ? this.transportMutex.runMany([
          transportShopMutexKey({ workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: knownShopId }),
          transportMutexKey({ workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: knownShopId }, knownConversationId),
        ], commit)
      : commit();
  }

  /**
   * Coalesce timer, post-commit and Scenario Lab nudges into a single drain.
   * BullMQ still provides durable delivery; this guard prevents one API
   * process from globally scanning/claiming the same outbox concurrently and
   * creating avoidable PostgreSQL lock cycles under burst traffic.
   */
  private dispatchPending(): Promise<void> {
    if (this.dispatchPromise) return this.dispatchPromise;
    const run = this.dispatchPendingOnce().finally(() => {
      if (this.dispatchPromise === run) this.dispatchPromise = undefined;
    });
    this.dispatchPromise = run;
    return run;
  }

  private async dispatchPendingOnce(): Promise<void> {
    // This runs on every dispatcher tick, not only process start: a worker can
    // die just after the PENDING -> DISPATCHING claim. Processing receipts and
    // downstream idempotency make reclaiming an expired lease safe.
    const now = new Date();
    await this.prisma.processingOutbox.updateMany({
      where: {
        status: ProcessingOutboxStatus.DISPATCHING,
        eventType: { in: ['MESSAGE_RECEIVED', 'MESSAGE_COMMITTED', 'USER_TURN_READY', 'WORKFLOW_ROUTE'] },
        updatedAt: { lt: new Date(now.getTime() - 1_000) },
      },
      data: { status: ProcessingOutboxStatus.PENDING, availableAt: now },
    });
    const rows = await this.prisma.processingOutbox.findMany({
      // Scheduled courtesy messages have a separate clock/consumer.  Feeding
      // them to this message payload consumer would make it parse a schedule
      // as a Message and lose the durable intent on failure.
      where: {
        status: ProcessingOutboxStatus.PENDING,
        eventType: { in: ['MESSAGE_RECEIVED', 'MESSAGE_COMMITTED', 'USER_TURN_READY', 'WORKFLOW_ROUTE'] },
        availableAt: { lte: now },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    for (const row of rows) {
      const claimed = await this.prisma.processingOutbox.updateMany({
        where: { id: row.id, status: ProcessingOutboxStatus.PENDING },
        data: { status: ProcessingOutboxStatus.DISPATCHING, attempts: { increment: 1 } },
      });
      if (!claimed.count) continue;
      try {
        if (this.queue) {
          await this.queue.add('outbox', { kind: 'OUTBOX', eventId: row.eventId }, {
            // BullMQ forbids ':' in a custom id.  Hash keeps the DB event id
            // opaque, deterministic and valid without weakening idempotency.
            jobId: runtimeJobId('outbox', row.eventId),
            attempts: 5,
            backoff: { type: 'exponential', delay: 250 },
            removeOnComplete: 1_000,
          });
        } else {
          await this.consumeOutbox(row.eventId);
          await this.markOutboxDispatched(row.eventId);
        }
      } catch (error) {
        await this.prisma.processingOutbox.update({
          where: { id: row.id },
          data: {
            status: ProcessingOutboxStatus.PENDING,
            availableAt: new Date(Date.now() + Math.min(30_000, 250 * 2 ** Math.min(row.attempts, 7))),
          },
        });
        throw error;
      }
    }
  }

  private async consumeOutbox(eventId: string): Promise<void> {
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.processingReceipt.findUnique({ where: { eventId } });
      if (existing) return null;
      const outbox = await tx.processingOutbox.findUnique({ where: { eventId } });
      if (!outbox) return null;
      const payload = this.record(outbox.payloadJson);
      if (outbox.eventType === 'USER_TURN_READY') {
        const conversationId = String(payload.conversationId ?? '');
        const userTurnId = String(payload.userTurnId ?? '');
        const sourceLastMessageId = typeof payload.sourceLastMessageId === 'string' ? payload.sourceLastMessageId : undefined;
        const sourceSequence = Number(payload.sourceSequence);
        const sourceContextVersion = Number(payload.sourceContextVersion);
        if (!conversationId || !userTurnId || !Number.isSafeInteger(sourceSequence) || !Number.isSafeInteger(sourceContextVersion)) {
          throw new Error(`Invalid reply-plan payload ${eventId}`);
        }
        if (!this.replyJobs) throw new Error('ReplyJobService is required to consume USER_TURN_READY');
        await this.lock(tx, conversationId);
        // A welcome receipt may have become the visible tail while the buyer
        // turn was coalescing.  Preserve the UserTurn's buyer-only content,
        // but capture the *current* send cursor so its answer is not rejected
        // by SendGuard merely because the courtesy message won the race.
        const [liveConversation, liveTail] = await Promise.all([
          tx.conversation.findFirst({
            where: { id: conversationId, workspaceId: outbox.workspaceId, tenantId: outbox.tenantId, shopId: outbox.shopId },
            select: { lastCommittedSequence: true, contextVersion: true },
          }),
          tx.message.findFirst({
            where: { workspaceId: outbox.workspaceId, tenantId: outbox.tenantId, shopId: outbox.shopId, conversationId, status: { not: 'RECALLED' } },
            orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }], select: { id: true, sequence: true },
          }),
        ]);
        if (!liveConversation) throw new Error(`Reply conversation missing for ${eventId}`);
        // A welcome projection may advance the visible tail without changing
        // context. A later buyer message does change context: never upgrade an
        // old turn to that newer snapshot, or it could answer stale input.
        if (liveConversation.contextVersion !== sourceContextVersion) {
          await tx.processingReceipt.create({
            data: {
              workspaceId: outbox.workspaceId, tenantId: outbox.tenantId,
              shopId: outbox.shopId, eventId,
            },
          });
          return null;
        }
        const replyShop = await tx.shop.findFirst({
          where: {
            id: outbox.shopId,
            workspaceId: outbox.workspaceId,
            tenantId: outbox.tenantId,
          },
          select: { aiMode: true },
        });
        if (!replyShop) throw new Error(`Reply shop missing for ${eventId}`);
        // MANUAL_ONLY is the Shop master OFF switch, not a request to create a
        // synthetic AI-shaped manual job. The committed buyer turn remains in
        // the conversation for the human inbox, while this durable receipt
        // ensures enabling AI later cannot resurrect work for an OFF-period
        // message. A genuinely future turn may create fresh AUTO work.
        if (replyShop.aiMode === 'MANUAL_ONLY') {
          await tx.processingReceipt.create({
            data: {
              workspaceId: outbox.workspaceId,
              tenantId: outbox.tenantId,
              shopId: outbox.shopId,
              eventId,
            },
          });
          return null;
        }
        const replyJob = await this.replyJobs.createInTransaction(tx, {
          workspaceId: outbox.workspaceId,
          tenantId: outbox.tenantId,
          shopId: outbox.shopId,
        }, {
          conversationId,
          userTurnId,
          // AUTO is merely a candidate. ReplyRuntime applies the current
          // policy, evidence, task/risk result and every conversation ceiling
          // before it can create a send intent.
          mode: 'AUTO',
          sourceLastMessageId: liveTail?.id ?? sourceLastMessageId,
          sourceSequence: Math.max(sourceSequence, liveConversation.lastCommittedSequence),
          sourceContextVersion: liveConversation.contextVersion,
          idempotencyKey: eventId,
          evidence: [],
        }, { lockHeld: true });
        await tx.processingReceipt.create({
          data: {
            workspaceId: outbox.workspaceId,
            tenantId: outbox.tenantId,
            shopId: outbox.shopId,
            eventId,
          },
        });
        return {
          kind: 'REPLY_JOB' as const,
          replyJobId: replyJob.id,
          scope: { workspaceId: outbox.workspaceId, tenantId: outbox.tenantId, shopId: outbox.shopId },
        };
      }
      if (outbox.eventType === 'WORKFLOW_ROUTE') {
        const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
        const taskIds = this.stringArray(payload.taskIds);
        if (!conversationId || !taskIds.length) throw new Error(`Invalid workflow-route payload ${eventId}`);
        if (!this.workflowRouter) throw new Error('WorkflowRouterService is required to consume WORKFLOW_ROUTE');
        // Unlike a pure read receipt, routing has a real external state
        // transition (Task owner CAS). Mark its receipt only after Router
        // returns, so a failed route stays dispatchable on restart.
        return { kind: 'WORKFLOW_ROUTE' as const, eventId, scope: { workspaceId: outbox.workspaceId, tenantId: outbox.tenantId, shopId: outbox.shopId }, conversationId, taskIds };
      }
      const conversationId = String(payload.conversationId ?? '');
      const sequence = Number(payload.sequence);
      const messageId = String(payload.messageId ?? '');
      const late = payload.late === true;
      if (!conversationId || !messageId || !Number.isSafeInteger(sequence)) {
        throw new Error(`Invalid outbox payload ${eventId}`);
      }
      await this.lock(tx, conversationId);
      if (late) {
        const [message, conversation] = await Promise.all([
          tx.message.findFirst({
            where: { id: messageId, workspaceId: outbox.workspaceId, tenantId: outbox.tenantId },
          }),
          tx.conversation.findFirst({
            where: { id: conversationId, workspaceId: outbox.workspaceId, tenantId: outbox.tenantId },
          }),
        ]);
        if (!message || !conversation) throw new Error(`Late message projection missing for ${eventId}`);
        const turn = await tx.userTurn.upsert({
          where: { turnKey: `late:${message.id}` },
          update: {},
          create: {
            workspaceId: outbox.workspaceId,
            tenantId: outbox.tenantId,
            shopId: outbox.shopId,
            conversationId,
            sourceMessageIdsJson: [message.id],
            firstSequence: message.sequence,
            lastSequence: message.sequence,
            normalizedText: this.messageText(message.kind, message.contentJson),
            turnKey: `late:${message.id}`,
          },
        });
        await this.enqueueReplyPlanning(tx, {
          workspaceId: outbox.workspaceId,
          tenantId: outbox.tenantId,
          shopId: outbox.shopId,
          conversation,
          turn,
          sourceLastMessageId: message.id,
        });
        await tx.processingReceipt.create({
          data: {
            workspaceId: outbox.workspaceId,
            tenantId: outbox.tenantId,
            shopId: outbox.shopId,
            eventId,
          },
        });
        return { kind: 'LATE' as const, turn, conversation };
      }
      const existingBuffer = await tx.conversationTurnBuffer.findUnique({ where: { conversationId } });
      const now = new Date();
      const data =
        existingBuffer?.status === TurnBufferStatus.BUFFERING
          ? {
              lastMessageAt: now,
              idleDeadline: new Date(now.getTime() + 2_000),
              latestSequence: Math.max(existingBuffer.latestSequence, sequence),
              generation: { increment: 1 as const },
            }
          : {
              workspaceId: outbox.workspaceId,
              tenantId: outbox.tenantId,
              shopId: outbox.shopId,
              openedAt: now,
              lastMessageAt: now,
              idleDeadline: new Date(now.getTime() + 2_000),
              hardDeadline: new Date(now.getTime() + 5_000),
              firstSequence: sequence,
              latestSequence: sequence,
              generation: (existingBuffer?.generation ?? 0) + 1,
              status: TurnBufferStatus.BUFFERING,
            };
      const buffer = existingBuffer
        ? await tx.conversationTurnBuffer.update({ where: { conversationId }, data })
        : await tx.conversationTurnBuffer.create({
            data: { ...data, conversationId } as Prisma.ConversationTurnBufferUncheckedCreateInput,
          });
      await tx.processingReceipt.create({
        data: {
          workspaceId: outbox.workspaceId,
          tenantId: outbox.tenantId,
          shopId: outbox.shopId,
          eventId,
        },
      });
      return { kind: 'BUFFER' as const, buffer };
    });
    if (!result) return;
    if (result.kind === 'REPLY_JOB') {
      // The planner's receipt has committed. Generation has its own durable
      // claim/CAS boundary and must never run inside the outbox transaction.
      if (this.replyRuntime) await this.replyRuntime.process(result.scope, result.replyJobId);
      return;
    }
    if (result.kind === 'WORKFLOW_ROUTE') {
      await this.workflowRouter?.route(result.scope, { conversationId: result.conversationId, taskIds: result.taskIds });
      try {
        await this.prisma.processingReceipt.create({ data: { ...result.scope, eventId: result.eventId } });
      } catch (error) {
        // A deleted demo workspace cascades its durable outbox rows, but a
        // BullMQ delivery that was already claimed may finish a few ms later.
        // With no source outbox left there is nothing to acknowledge or retry.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
          const sourceStillExists = await this.prisma.processingOutbox.findUnique({ where: { eventId: result.eventId }, select: { id: true } });
          if (!sourceStillExists) return;
        }
        throw error;
      }
      return;
    }
    if (result.kind === 'BUFFER') {
      await this.scheduleTurnFlush(result.buffer.conversationId, result.buffer.generation, this.nextFlushAt(result.buffer));
      await this.publishTurnBuffer(result.buffer);
      return;
    }
    const sourceMessageIds = this.stringArray(result.turn.sourceMessageIdsJson);
    this.gateway.publish({
      eventId: randomUUID(),
      eventType: 'USER_TURN_CREATED',
      workspaceId: result.turn.workspaceId,
      entityType: 'USER_TURN',
      entityId: result.turn.id,
      entityVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: {
        conversationId: result.conversation.id,
        userTurn: {
          id: result.turn.id,
          workspaceId: result.turn.workspaceId,
          tenantId: result.turn.tenantId,
          shopId: result.turn.shopId,
          conversationId: result.turn.conversationId,
          buyerId: result.conversation.buyerId,
          firstSequence: result.turn.firstSequence,
          latestSequence: result.turn.lastSequence,
          sourceMessageIds,
          messageIds: sourceMessageIds,
          normalizedText: result.turn.normalizedText,
          generation: 1,
          status: result.turn.status,
          createdAt: result.turn.createdAt.toISOString(),
          updatedAt: result.turn.updatedAt.toISOString(),
        },
      },
    });
  }

  private async flushTurn(conversationId: string, generation: number): Promise<void> {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, conversationId);
      const buffer = await tx.conversationTurnBuffer.findUnique({ where: { conversationId } });
      if (!buffer || buffer.status !== TurnBufferStatus.BUFFERING || buffer.generation !== generation) return null;
      const nextAt = this.nextFlushAt(buffer);
      if (nextAt.getTime() > Date.now()) return { rescheduleAt: nextAt, buffer, turn: null };
      const conversation = await tx.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation) return null;
      await tx.conversationTurnBuffer.update({
        where: { conversationId },
        data: { status: TurnBufferStatus.FLUSHING },
      });
      const messages = await tx.message.findMany({
        where: {
          workspaceId: buffer.workspaceId,
          tenantId: buffer.tenantId,
          conversationId,
          role: PrismaMessageRole.BUYER,
          sequence: { gte: buffer.firstSequence, lte: buffer.latestSequence },
          status: { not: PrismaMessageStatus.RECALLED },
        },
        orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
      });
      const turnKey = `${conversationId}:${buffer.firstSequence}:${buffer.latestSequence}:${buffer.generation}`;
      if (!messages.length) {
        await tx.conversationTurnBuffer.update({
          where: { conversationId },
          data: { status: TurnBufferStatus.CANCELLED },
        });
        return null;
      }
      const turn = await tx.userTurn.upsert({
        where: { turnKey },
        update: {},
        create: {
          workspaceId: buffer.workspaceId,
          tenantId: buffer.tenantId,
          shopId: buffer.shopId,
          conversationId,
          sourceMessageIdsJson: messages.map((message) => message.id),
          firstSequence: buffer.firstSequence,
          lastSequence: buffer.latestSequence,
          normalizedText: messages.map((message) => this.messageText(message.kind, message.contentJson)).join('\n'),
          turnKey,
        },
      });
      await this.enqueueReplyPlanning(tx, {
        workspaceId: buffer.workspaceId,
        tenantId: buffer.tenantId,
        shopId: buffer.shopId,
        conversation,
        turn,
        sourceLastMessageId: messages.at(-1)!.id,
      });
      await tx.conversationTurnBuffer.update({
        where: { conversationId },
        data: { status: TurnBufferStatus.FLUSHED },
      });
      return { rescheduleAt: null, buffer, turn, conversation };
    });
    if (!result) return;
    if (result.rescheduleAt) {
      await this.scheduleTurnFlush(conversationId, generation, result.rescheduleAt);
      return;
    }
    if (result.turn) {
      const sourceMessageIds = this.stringArray(result.turn.sourceMessageIdsJson);
      const userTurn = {
        id: result.turn.id,
        workspaceId: result.turn.workspaceId,
        tenantId: result.turn.tenantId,
        shopId: result.turn.shopId,
        conversationId,
        buyerId: result.conversation.buyerId,
        firstSequence: result.turn.firstSequence,
        latestSequence: result.turn.lastSequence,
        sourceMessageIds,
        messageIds: sourceMessageIds,
        normalizedText: result.turn.normalizedText,
        generation,
        status: result.turn.status,
        createdAt: result.turn.createdAt.toISOString(),
        updatedAt: result.turn.updatedAt.toISOString(),
      };
      const event: WorkspaceEventEnvelope<Record<string, unknown>> = {
        eventId: randomUUID(),
        eventType: 'USER_TURN_CREATED',
        workspaceId: result.buffer.workspaceId,
        entityType: 'USER_TURN',
        entityId: result.turn.id,
        entityVersion: 1,
        occurredAt: new Date().toISOString(),
        payload: { conversationId, userTurn },
      };
      this.gateway.publish(event);
      void this.traces?.record({ workspaceId: result.buffer.workspaceId, tenantId: result.buffer.tenantId, shopId: result.buffer.shopId, conversationId }, `conversation:${conversationId}`, 'USER_TURN', { userTurnId: result.turn.id, firstSequence: result.turn.firstSequence, lastSequence: result.turn.lastSequence, sourceMessageCount: sourceMessageIds.length });
      await this.publishTurnBuffer(null, {
        workspaceId: result.buffer.workspaceId,
        tenantId: result.buffer.tenantId,
        conversationId,
      });
    }
  }

  /** Writes a deterministic plan intent in the same transaction as UserTurn. */
  private async enqueueReplyPlanning(
    tx: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      tenantId: string;
      shopId: string;
      conversation: { id: string; contextVersion: number };
      turn: { id: string; lastSequence: number };
      sourceLastMessageId: string;
    },
  ): Promise<void> {
    await tx.processingOutbox.upsert({
      where: { eventId: `reply-plan:${input.turn.id}` },
      update: {},
      create: {
        workspaceId: input.workspaceId,
        tenantId: input.tenantId,
        shopId: input.shopId,
        eventId: `reply-plan:${input.turn.id}`,
        aggregateType: 'USER_TURN',
        aggregateId: input.turn.id,
        eventType: 'USER_TURN_READY',
        payloadJson: {
          conversationId: input.conversation.id,
          userTurnId: input.turn.id,
          sourceLastMessageId: input.sourceLastMessageId,
          sourceSequence: input.turn.lastSequence,
          sourceContextVersion: input.conversation.contextVersion,
        },
      },
    });
  }

  private async checkGap(conversationId: string): Promise<void> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, conversationId);
      return tx.reorderBufferEntry.updateMany({
        where: {
          conversationId,
          status: ReorderBufferStatus.BUFFERED,
          reconcileAttempted: false,
        },
        data: { reconcileAttempted: true },
      });
    });
    if (!claimed.count) return;
    const snapshot = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        reorderEntries: {
          where: { status: ReorderBufferStatus.BUFFERED },
          orderBy: { sequence: 'asc' },
        },
      },
    });
    if (!snapshot?.reorderEntries.length) return;
    const scope = { workspaceId: snapshot.workspaceId, tenantId: snapshot.tenantId };
    try {
      const reconciliation = await this.adapter.reconcile({
        ...scope,
        shopId: snapshot.shopId,
        externalConversationId: snapshot.externalConversationId,
        expectedSequence: snapshot.lastCommittedSequence + 1,
        throughSequence: snapshot.reorderEntries.at(-1)!.sequence,
      });
      for (const platformMessage of reconciliation.messages) {
        await this.ingest(scope, {
          shopId: snapshot.shopId,
          buyerId: snapshot.buyerId,
          conversationId: snapshot.id,
          externalConversationId: snapshot.externalConversationId,
          kind: this.adapterKind(platformMessage),
          content: await this.adapterContent(scope, snapshot.shopId, platformMessage),
          sentAt: platformMessage.sentAt,
          forcedSequence: platformMessage.sequence,
          externalMessageId: platformMessage.externalMessageId,
        });
      }
    } catch (error) {
      if (!(error instanceof MockDouyinNotFoundError)) throw error;
      this.logger.warn(`Synthetic history was unavailable while reconciling ${conversationId}`);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, conversationId);
      const buffered = await tx.reorderBufferEntry.findMany({
        where: { conversationId, status: ReorderBufferStatus.BUFFERED },
        orderBy: { sequence: 'asc' },
      });
      if (!buffered.length) return null;
      const conversation = await tx.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation) return null;
      return tx.conversation.update({
        where: { id: conversationId },
        data: { syncState: ConversationSyncState.DEGRADED },
      });
    });
    if (result) {
      await this.publishConversation(
        { workspaceId: result.workspaceId, tenantId: result.tenantId },
        result.id,
      );
    }
  }

  private async recoverDurableWork(): Promise<void> {
    const staleBefore = new Date(Date.now() - 30_000);
    await this.prisma.processingOutbox.updateMany({
      where: {
        status: ProcessingOutboxStatus.DISPATCHING,
        updatedAt: { lt: staleBefore },
      },
      data: {
        status: ProcessingOutboxStatus.PENDING,
        availableAt: new Date(),
      },
    });
    await this.dispatchPending();
    const [buffers, gaps] = await Promise.all([
      this.prisma.conversationTurnBuffer.findMany({ where: { status: TurnBufferStatus.BUFFERING } }),
      this.prisma.reorderBufferEntry.findMany({
        where: { status: ReorderBufferStatus.BUFFERED },
        distinct: ['conversationId'],
        orderBy: { firstBufferedAt: 'asc' },
      }),
    ]);
    for (const buffer of buffers) {
      await this.scheduleTurnFlush(buffer.conversationId, buffer.generation, this.nextFlushAt(buffer));
    }
    for (const gap of gaps) {
      await this.scheduleGapCheck(gap.conversationId, new Date(gap.firstBufferedAt.getTime() + 1_000));
    }
  }

  private async processRuntimeJob(job: Job<RuntimeJob>): Promise<void> {
    switch (job.data.kind) {
      case 'OUTBOX':
        await this.consumeOutbox(job.data.eventId);
        await this.markOutboxDispatched(job.data.eventId);
        break;
      case 'TURN_FLUSH':
        await this.flushTurn(job.data.conversationId, job.data.generation);
        break;
      case 'GAP_CHECK':
        await this.checkGap(job.data.conversationId);
        break;
    }
  }

  private async markOutboxDispatched(eventId: string): Promise<void> {
    await this.prisma.processingOutbox.updateMany({
      where: { eventId, status: ProcessingOutboxStatus.DISPATCHING },
      data: { status: ProcessingOutboxStatus.DISPATCHED, dispatchedAt: new Date() },
    });
  }

  private async scheduleTurnFlush(conversationId: string, generation: number, runAt: Date): Promise<void> {
    const delay = Math.max(0, runAt.getTime() - Date.now());
    const data: RuntimeJob = { kind: 'TURN_FLUSH', conversationId, generation };
    if (this.queue) {
      await this.queue.add('turn-flush', data, {
        jobId: `turn-${conversationId}-${generation}`,
        delay,
        removeOnComplete: 1_000,
      });
    } else {
      this.scheduleLocal(delay, () => this.flushTurn(conversationId, generation));
    }
  }

  private async scheduleGapCheck(conversationId: string, runAt: Date): Promise<void> {
    const delay = Math.max(0, runAt.getTime() - Date.now());
    const data: RuntimeJob = { kind: 'GAP_CHECK', conversationId };
    if (this.queue) {
      await this.queue.add('gap-check', data, {
        jobId: `gap-${conversationId}-${runAt.getTime()}`,
        delay,
        removeOnComplete: 1_000,
      });
    } else {
      this.scheduleLocal(delay, () => this.checkGap(conversationId));
    }
  }

  private scheduleLocal(delay: number, action: () => Promise<void>): void {
    const timer = setTimeout(() => {
      this.localTimers.delete(timer);
      void action().catch((error: unknown) => this.logger.error(this.errorMessage(error)));
    }, delay);
    timer.unref();
    this.localTimers.add(timer);
  }

  private async publishConversation(scope: WorkspaceScope, conversationId: string): Promise<void> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, ...this.scope(scope) },
      include: {
        buyer: true,
        shop: { select: { aiMode: true } },
        messages: { orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }], take: 1 },
        replyJobs: {
          where: { status: { in: ['PENDING', 'GENERATING', 'FAST_PATH_READY', 'WAITING_HUMAN', 'CANCELLING', 'RECOVERY_PENDING'] } },
          orderBy: { updatedAt: 'desc' }, take: 1, include: { draft: true, sendOutbox: true },
        },
        sendOutboxes: { orderBy: { updatedAt: 'desc' }, take: 1 },
      },
    });
    if (!conversation) return;
    const view = this.toSummary(conversation);
    this.gateway.publish({
      eventId: randomUUID(),
      eventType: 'CONVERSATION_UPDATED',
      workspaceId: scope.workspaceId,
      entityType: 'CONVERSATION',
      entityId: conversationId,
      entityVersion: conversation.contextVersion,
      occurredAt: new Date().toISOString(),
      payload: { conversationId, conversation: view },
    });
  }

  private async publishTurnBuffer(
    buffer: {
      id: string;
      workspaceId: string;
      tenantId: string;
      shopId: string;
      conversationId: string;
      openedAt: Date;
      lastMessageAt: Date;
      idleDeadline: Date;
      hardDeadline: Date;
      generation: number;
      firstSequence: number;
      latestSequence: number;
      status: TurnBufferStatus;
    } | null,
    identity?: WorkspaceScope & { conversationId: string },
  ): Promise<void> {
    const workspaceId = buffer?.workspaceId ?? identity?.workspaceId;
    const tenantId = buffer?.tenantId ?? identity?.tenantId;
    const conversationId = buffer?.conversationId ?? identity?.conversationId;
    if (!workspaceId || !tenantId || !conversationId) return;
    const conversation = buffer
      ? await this.prisma.conversation.findFirst({
          where: { id: conversationId, workspaceId, tenantId },
          select: { buyerId: true },
        })
      : null;
    const turnBuffer = buffer
      ? {
          key: buffer.id,
          workspaceId,
          tenantId,
          shopId: buffer.shopId,
          conversationId,
          buyerId: conversation?.buyerId ?? '',
          firstSequence: buffer.firstSequence,
          latestSequence: buffer.latestSequence,
          openedAt: buffer.openedAt.toISOString(),
          lastMessageAt: buffer.lastMessageAt.toISOString(),
          idleDeadline: buffer.idleDeadline.toISOString(),
          hardDeadline: buffer.hardDeadline.toISOString(),
          generation: buffer.generation,
          status: buffer.status,
        }
      : null;
    this.gateway.publish({
      eventId: randomUUID(),
      eventType: 'TURN_BUFFER_UPDATED',
      workspaceId,
      entityType: 'TURN_BUFFER',
      entityId: buffer?.id ?? conversationId,
      entityVersion: buffer?.generation ?? 1,
      occurredAt: new Date().toISOString(),
      payload: { conversationId, turnBuffer },
    });
  }

  private publishMessage(
    scope: WorkspaceScope,
    raw: Record<string, unknown>,
    eventType: 'MESSAGE_RECEIVED' | 'MESSAGE_EDITED' | 'MESSAGE_RECALLED',
  ): void {
    const message = this.toMessage(raw);
    this.gateway.publish({
      eventId: randomUUID(),
      eventType,
      workspaceId: scope.workspaceId,
      entityType: 'MESSAGE',
      entityId: message.id,
      entityVersion: message.entityVersion ?? 1,
      occurredAt: new Date().toISOString(),
      payload: { conversationId: message.conversationId, message },
      ...(eventType === 'MESSAGE_RECALLED'
        ? { payload: { conversationId: message.conversationId, message, contextInvalidationRequired: true } }
        : {}),
    });
  }

  private toSummary(conversation: any): ConversationSummary {
    const last = conversation.messages?.[0];
    return {
      id: conversation.id,
      workspaceId: conversation.workspaceId,
      tenantId: conversation.tenantId,
      shopId: conversation.shopId,
      buyerId: conversation.buyerId,
      externalConversationId: conversation.externalConversationId,
      state: conversation.state,
      mode: conversation.mode,
      overrideMode: conversation.overrideMode,
      effectiveMode: effectiveConversationMode(conversation),
      syncState: conversation.syncState,
      contextVersion: conversation.contextVersion,
      lastCommittedSequence: conversation.lastCommittedSequence,
      activeTopic: conversation.activeTopic,
      currentProductId: conversation.currentProductId,
      currentOrderId: conversation.currentOrderId,
      humanActive: conversation.humanActive,
      needsReplan: conversation.needsReplan,
      idleExpiresAt: conversation.idleExpiresAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      buyer: {
        id: conversation.buyer.id,
        workspaceId: conversation.buyer.workspaceId,
        tenantId: conversation.buyer.tenantId,
        displayName: conversation.buyer.displayName,
        avatar: conversation.buyer.avatar,
        tags: this.stringArray(conversation.buyer.tagsJson),
      },
      unreadCount: conversation.unreadCount,
      ...(conversation.replyJobs?.[0]
        ? {
            activeReplyJobId: conversation.replyJobs[0].id,
            activeReplyJob: this.toReplyJob(conversation.replyJobs[0]),
            currentDraft: conversation.replyJobs[0].draft ? this.toReplyDraft(conversation.replyJobs[0].draft) : null,
          }
        : { activeReplyJobId: null, activeReplyJob: null, currentDraft: null }),
      sendOutbox: conversation.sendOutboxes?.[0]
        ? this.toSendOutbox(conversation.sendOutboxes[0])
        : conversation.replyJobs?.[0]?.sendOutbox ? this.toSendOutbox(conversation.replyJobs[0].sendOutbox) : null,
      ...(last ? { lastMessage: this.toMessage(last, last._count?.versions ? last._count.versions + 1 : 1) } : {}),
    };
  }

  private toReplyJob(raw: any) {
    return {
      id: raw.id, workspaceId: raw.workspaceId, tenantId: raw.tenantId, shopId: raw.shopId,
      conversationId: raw.conversationId, userTurnId: raw.userTurnId, status: raw.status, mode: raw.mode,
      sourceLastMessageId: raw.sourceLastMessageId, sourceSequence: raw.sourceSequence, sourceContextVersion: raw.sourceContextVersion,
      staleReason: raw.staleReason ?? null, createdAt: raw.createdAt?.toISOString?.(), updatedAt: raw.updatedAt?.toISOString?.(),
      draft: raw.draft ? this.toReplyDraft(raw.draft) : null,
      currentDraft: raw.draft ? this.toReplyDraft(raw.draft) : null,
      sendOutbox: raw.sendOutbox ? this.toSendOutbox(raw.sendOutbox) : null,
    };
  }

  private toReplyDraft(raw: any) {
    return {
      id: raw.id, replyJobId: raw.replyJobId, aiDraft: raw.aiDraft, humanFinal: raw.humanFinal ?? null, editType: raw.editType ?? null,
      status: raw.status, sourceContextVersion: raw.sourceContextVersion, sourceLastMessageId: raw.sourceLastMessageId ?? null,
      sourceSequence: raw.sourceSequence ?? null, generatedAt: raw.generatedAt?.toISOString?.(), expiresAt: raw.expiresAt?.toISOString?.() ?? null,
      staleReason: raw.staleReason ?? null, updatedAt: raw.updatedAt?.toISOString?.(),
    };
  }

  private toSendOutbox(raw: any) {
    return {
      id: raw.id, workspaceId: raw.workspaceId, tenantId: raw.tenantId, shopId: raw.shopId, conversationId: raw.conversationId,
      replyJobId: raw.replyJobId ?? null, idempotencyKey: raw.idempotencyKey, payload: this.record(raw.payloadJson),
      expectedLastMessageId: raw.expectedLastMessageId ?? null, expectedSequence: raw.expectedSequence ?? null,
      expectedContextVersion: raw.expectedContextVersion ?? null, status: raw.status, receipt: raw.receiptJson ? this.record(raw.receiptJson) : null,
      failureCode: raw.failureCode ?? null, failureReason: raw.failureReason ?? null,
      createdAt: raw.createdAt?.toISOString?.(), updatedAt: raw.updatedAt?.toISOString?.(),
    };
  }

  private toTaskBundle(tasks: any[], userTurnId?: string) {
    if (!userTurnId) return null;
    const scoped = tasks.filter((task) => task.userTurnId === userTurnId).slice(0, 4);
    if (scoped.length === 0) return null;
    const status: 'ALL_RESOLVED' | 'PARTIAL_RESOLVED' | 'NEEDS_CLARIFICATION' | 'HIGH_RISK' | 'FAILED' = scoped.some((task) => task.status === 'AMBIGUOUS') ? 'NEEDS_CLARIFICATION'
      : scoped.some((task) => task.status === 'FAILED' && task.blocking) ? 'FAILED'
        : scoped.some((task) => task.status === 'FAILED') ? 'PARTIAL_RESOLVED'
          : scoped.some((task) => task.riskLevel === 'HIGH') ? 'HIGH_RISK' : 'ALL_RESOLVED';
    return {
      id: `bundle:${userTurnId}`, userTurnId, status,
      tasks: scoped.map((task) => ({
        id: task.id, userTurnId: task.userTurnId, intent: task.intent, riskLevel: task.riskLevel, operation: task.operation,
        requiredContext: this.stringArray(task.requiredContextJson), requiredKnowledge: this.stringArray(task.requiredKnowledgeJson),
        requiredTools: this.stringArray(task.requiredToolsJson), status: task.status,
        result: task.resultJson ? { status: task.status, blocking: task.blocking, facts: this.record(task.resultJson), errorCode: task.errorCode ?? null } : null,
        blocking: task.blocking,
      })),
    };
  }

  private toMessage(raw: any, entityVersion?: number): Message {
    const date = (value: unknown): string =>
      value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
    return {
      id: String(raw.id),
      workspaceId: String(raw.workspaceId),
      tenantId: String(raw.tenantId),
      platform: String(raw.platform) as Message['platform'],
      shopId: String(raw.shopId),
      conversationId: String(raw.conversationId),
      buyerId: String(raw.buyerId),
      externalMessageId: String(raw.externalMessageId),
      sequence: Number(raw.sequence),
      role: raw.role === 'ASSISTANT' ? 'AI' : raw.role,
      kind: raw.kind,
      status: raw.status,
      content: this.record(raw.contentJson ?? raw.content),
      sentAt: date(raw.sentAt),
      receivedAt: date(raw.receivedAt),
      createdAt: date(raw.createdAt),
      entityVersion: entityVersion ?? Number(raw.entityVersion ?? 1),
    };
  }

  private async platformContext(
    scope: WorkspaceScope,
    shopId: string,
    buyerId: string,
    conversationId?: string,
  ): Promise<{ conversationId?: string; externalBuyerId: string; externalConversationId: string; nextSequence: number }> {
    const now = new Date();
    const [shop, buyer, conversation] = await Promise.all([
      this.prisma.shop.findFirst({ where: { id: shopId, ...this.scope(scope) }, select: { id: true } }),
      this.prisma.buyer.findFirst({
        where: { id: buyerId, ...this.scope(scope) },
        select: { id: true, externalBuyerId: true },
      }),
      conversationId
        ? this.prisma.conversation.findFirst({ where: { id: conversationId, ...this.scope(scope) } })
        : this.prisma.conversation.findFirst({
            where: {
              ...this.scope(scope),
              shopId,
              buyerId,
              state: 'ACTIVE',
              OR: [{ idleExpiresAt: null }, { idleExpiresAt: { gt: now } }],
            },
            orderBy: { updatedAt: 'desc' },
          }),
    ]);
    if (!shop) throw missing('SHOP_NOT_FOUND', 'Shop not found in this Workspace');
    if (!buyer) throw missing('BUYER_NOT_FOUND', 'Buyer not found in this Workspace');
    if (conversationId && !conversation) {
      throw missing('CONVERSATION_NOT_FOUND', 'Conversation not found in this Workspace');
    }
    if (conversation && (conversation.shopId !== shopId || conversation.buyerId !== buyerId)) {
      throw bad('CONVERSATION_SCOPE_MISMATCH', 'Conversation does not belong to the selected buyer and shop');
    }
    const maxBuffered = conversation
      ? await this.prisma.reorderBufferEntry.aggregate({
          where: { ...this.scope(scope), conversationId: conversation.id, status: ReorderBufferStatus.BUFFERED },
          _max: { sequence: true },
        })
      : { _max: { sequence: null } };
    return {
      conversationId: conversation?.id,
      externalBuyerId: buyer.externalBuyerId,
      externalConversationId: conversation?.externalConversationId ?? `mock_conv_${randomUUID()}`,
      nextSequence: Math.max(conversation?.lastCommittedSequence ?? 0, maxBuffered._max.sequence ?? 0) + 1,
    };
  }

  private async activeConversationId(scope: WorkspaceScope, shopId: string, buyerId: string): Promise<string | undefined> {
    const repository = this.prisma as unknown as { conversation?: { findFirst(input: unknown): Promise<{ id: string } | null> } };
    if (!repository.conversation?.findFirst) return undefined;
    const conversation = await repository.conversation.findFirst({
      where: { ...this.scope(scope), shopId, buyerId, state: 'ACTIVE', OR: [{ idleExpiresAt: null }, { idleExpiresAt: { gt: new Date() } }] },
      orderBy: { updatedAt: 'desc' }, select: { id: true },
    });
    return conversation?.id;
  }

  private async platformMessageContext(
    scope: WorkspaceScope,
    messageId: string,
  ): Promise<{ shopId: string; conversationId: string; externalMessageId: string }> {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, ...this.scope(scope) },
      select: { shopId: true, conversationId: true, externalMessageId: true, role: true },
    });
    if (!message) throw missing('MESSAGE_NOT_FOUND', 'Message not found in this Workspace');
    if (message.role !== PrismaMessageRole.BUYER) {
      throw bad('BUYER_MESSAGE_REQUIRED', 'Only buyer messages can be edited or recalled through this endpoint');
    }
    return { shopId: message.shopId, conversationId: message.conversationId, externalMessageId: message.externalMessageId };
  }

  private adapterKind(message: MockDouyinMessage): MessageKind {
    if (message.kind === 'PRODUCT_CARD') return 'GOODS_CARD';
    return message.kind;
  }

  private async adapterContent(
    scope: WorkspaceScope,
    shopId: string,
    message: MockDouyinMessage,
  ): Promise<Record<string, unknown>> {
    if (message.kind === 'TEXT') return { text: message.text ?? '' };
    if (message.kind === 'IMAGE') return { attachmentId: 'pending-analysis', analysisStatus: 'PENDING_PHASE_03' };
    if (message.kind === 'PRODUCT_CARD') {
      const product = await this.prisma.product.findFirst({
        where: { ...this.scope(scope), shopId, externalProductId: message.product?.externalProductId },
        select: { id: true, externalProductId: true, title: true },
      });
      return {
        ...(product ? { productId: product.id, title: product.title } : {}),
        externalProductId: message.product?.externalProductId ?? '',
      };
    }
    const order = await this.prisma.order.findFirst({
      where: { ...this.scope(scope), shopId, externalOrderId: message.order?.externalOrderId },
      select: { id: true, externalOrderId: true, status: true },
    });
    return {
      ...(order ? { orderId: order.id, status: order.status } : {}),
      externalOrderId: message.order?.externalOrderId ?? '',
    };
  }

  private async assertShop(scope: WorkspaceScope, shopId: string): Promise<void> {
    const shop = await this.prisma.shop.findFirst({ where: { id: shopId, ...this.scope(scope) }, select: { id: true } });
    if (!shop) throw missing('SHOP_NOT_FOUND', 'Shop not found in this Workspace');
  }

  private async assertBuyer(scope: WorkspaceScope, buyerId: string): Promise<void> {
    const buyer = await this.prisma.buyer.findFirst({ where: { id: buyerId, ...this.scope(scope) }, select: { id: true } });
    if (!buyer) throw missing('BUYER_NOT_FOUND', 'Buyer not found in this Workspace');
  }

  private async lock(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  private scope(scope: WorkspaceScope): { workspaceId: string; tenantId: string } {
    return { workspaceId: scope.workspaceId, tenantId: scope.tenantId };
  }

  private nextFlushAt(buffer: { idleDeadline: Date; hardDeadline: Date }): Date {
    return new Date(Math.min(buffer.idleDeadline.getTime(), buffer.hardDeadline.getTime()));
  }

  private incomingFromJson(value: Prisma.JsonValue): NormalizedIncoming {
    const record = this.record(value);
    return {
      platform: 'DOUYIN_DEMO',
      externalMessageId: String(record.externalMessageId),
      shopId: String(record.shopId),
      buyerId: String(record.buyerId),
      conversationId: String(record.conversationId),
      sequence: Number(record.sequence),
      kind: String(record.kind) as MessageKind,
      content: this.record(record.content),
      sentAt: String(record.sentAt),
      receivedAt: String(record.receivedAt),
    };
  }

  private messageText(kind: PrismaMessageKind, content: Prisma.JsonValue): string {
    const record = this.record(content);
    if (kind === PrismaMessageKind.TEXT) return String(record.text ?? '');
    if (kind === PrismaMessageKind.GOODS_CARD) return '[商品卡]';
    if (kind === PrismaMessageKind.ORDER_CARD) return '[订单卡]';
    if (kind === PrismaMessageKind.IMAGE) {
      const analysis = this.record(record.analysis);
      const observations = this.stringArray(analysis.observations).slice(0, 12);
      const scene = typeof analysis.scene === 'string' ? analysis.scene : 'UNKNOWN';
      return observations.length > 0 ? `[图片 ${scene}] ${observations.join('；')}` : `[图片 ${scene}]`;
    }
    return String(record.text ?? '[系统消息]');
  }

  private record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private recordOrNull(value: unknown): Record<string, unknown> | null {
    const record = this.record(value);
    return Object.keys(record).length ? record : null;
  }

  private stringRecord(value: unknown): Record<string, string> {
    return Object.fromEntries(Object.entries(this.record(value)).map(([key, item]) => [key, String(item)]));
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String) : [];
  }

  private generationFromTurnKey(turnKey: string): number {
    const generation = Number(turnKey.split(':').at(-1));
    return Number.isSafeInteger(generation) ? generation : 1;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.stack ?? error.message : String(error);
  }
}

function accepted(): OperationAccepted {
  return { operationId: randomUUID(), status: 'ACCEPTED' };
}

function missing(code: string, message: string): NotFoundException {
  return new NotFoundException({ code, message });
}

function bad(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}
