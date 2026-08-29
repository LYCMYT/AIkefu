import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma, ProcessingOutboxStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { autoReplyReady } from '../shops/shop-ai-readiness';
import type { ReplyJobScope } from './reply-job.service';
import { SendOutboxService } from './send-outbox.service';

type ScheduledConversationCursor = {
  id: string;
  contextVersion: number;
  lastCommittedSequence: number;
  lastMessageId?: string | null;
  currentOrderId?: string | null;
  currentOrderStatus?: string | null;
};

type ScheduledPayload = {
  conversationId: string;
  text: string;
  expectedLastMessageId?: string;
  expectedSequence: number;
  expectedContextVersion: number;
  expectedOrderId?: string;
  expectedOrderStatus?: string;
};

/** Durable schedule intent built on the existing ProcessingOutbox clock. */
@Injectable()
export class ScheduledConversationMessageService {
  constructor(private readonly prisma: PrismaService) {}

  async planWelcomeInTransaction(
    tx: Prisma.TransactionClient,
    scope: ReplyJobScope,
    conversation: ScheduledConversationCursor,
    text: string,
    availableAt = new Date(),
  ) {
    if (!(await scopedShopAutoReady(tx, scope, true))) return null;
    return tx.processingOutbox.upsert({
      where: { eventId: `scheduled:welcome:${conversation.id}` },
      update: {},
      create: {
        ...scope,
        eventId: `scheduled:welcome:${conversation.id}`,
        aggregateType: 'CONVERSATION',
        aggregateId: conversation.id,
        eventType: 'SCHEDULED_WELCOME',
        payloadJson: payload(conversation, text),
        status: ProcessingOutboxStatus.PENDING,
        availableAt,
      },
    });
  }

  async planClosing(scope: ReplyJobScope, conversation: ScheduledConversationCursor, text: string, availableAt: Date) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await scopedShopAutoReady(tx, scope, true))) return null;
      return tx.processingOutbox.upsert({
        where: { eventId: `scheduled:closing:${conversation.id}:${conversation.contextVersion}` },
        update: {},
        create: {
          ...scope,
          eventId: `scheduled:closing:${conversation.id}:${conversation.contextVersion}`,
          aggregateType: 'CONVERSATION',
          aggregateId: conversation.id,
          eventType: 'SCHEDULED_CLOSING',
          payloadJson: payload(conversation, text),
          status: ProcessingOutboxStatus.PENDING,
          availableAt,
        },
      });
    });
  }
}

/** Converts only still-valid schedule intents into an idempotent SendOutbox. */
@Injectable()
export class ScheduledConversationMessageWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledConversationMessageWorker.name);
  private timer?: NodeJS.Timeout;
  private workPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sendOutboxes: SendOutboxService,
    private readonly schedules?: ScheduledConversationMessageService,
  ) {}

  onModuleInit(): void {
    if (!process.env.DATABASE_URL?.trim()) return;
    this.timer = setInterval(() => this.runTracked(), 1_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.workPromise;
  }

  private runTracked(): void {
    if (this.workPromise) return;
    const run = this.dispatchOnce()
      .catch((error: unknown) => this.logger.error(errorMessage(error)))
      .then(() => undefined)
      .finally(() => { if (this.workPromise === run) this.workPromise = undefined; });
    this.workPromise = run;
  }

  async dispatchOnce(now = new Date()): Promise<{ dispatched: number; cancelled: number }> {
    if (this.schedules) await this.planDueClosings(now);
    // Scheduled work has a separate consumer; reclaim only its own expired
    // lease so a crash between claim and enqueue becomes at-least-once again.
    await this.prisma.processingOutbox.updateMany({
      where: {
        status: ProcessingOutboxStatus.DISPATCHING,
        eventType: { in: ['SCHEDULED_WELCOME', 'SCHEDULED_CLOSING'] },
        updatedAt: { lt: new Date(now.getTime() - 1_000) },
      },
      data: { status: ProcessingOutboxStatus.PENDING, availableAt: now },
    });
    const rows = await this.prisma.processingOutbox.findMany({
      where: {
        status: ProcessingOutboxStatus.PENDING,
        eventType: { in: ['SCHEDULED_WELCOME', 'SCHEDULED_CLOSING'] },
        availableAt: { lte: now },
      },
      orderBy: { availableAt: 'asc' },
      take: 50,
    });
    let dispatched = 0;
    let cancelled = 0;
    for (const row of rows) {
      const claimed = await this.prisma.processingOutbox.updateMany({
        where: {
          id: row.id,
          workspaceId: row.workspaceId,
          tenantId: row.tenantId,
          shopId: row.shopId,
          status: ProcessingOutboxStatus.PENDING,
        },
        data: { status: ProcessingOutboxStatus.DISPATCHING, attempts: { increment: 1 } },
      });
      if (!claimed.count) continue;
      const scope = { workspaceId: row.workspaceId, tenantId: row.tenantId, shopId: row.shopId };
      try {
        const outcome = await this.prisma.$transaction(async (tx) => {
          // Serialize the final readiness decision with the Shop kill switch.
          // Lock the schedule too, so reclaim cannot race an atomic conversion.
          await lockScopedShop(tx, scope);
          await tx.$queryRaw(Prisma.sql`
            SELECT 1 FROM "ProcessingOutbox"
            WHERE "id" = ${row.id}
              AND "workspaceId" = ${scope.workspaceId}
              AND "tenantId" = ${scope.tenantId}
              AND "shopId" = ${scope.shopId}
            FOR UPDATE
          `);
          const current = await tx.processingOutbox.findFirst({
            where: { id: row.id, ...scope, status: ProcessingOutboxStatus.DISPATCHING },
          });
          if (!current) return 'SKIPPED' as const;
          const scheduled = parsePayload(current.payloadJson);
          if (!scheduled || !(await this.stillValid(tx, scope, scheduled))) {
            await tx.processingOutbox.updateMany({
              where: { id: row.id, ...scope, status: ProcessingOutboxStatus.DISPATCHING },
              data: { status: ProcessingOutboxStatus.FAILED },
            });
            return 'CANCELLED' as const;
          }
          await this.sendOutboxes.enqueueInTransaction(tx, scope, {
            conversationId: scheduled.conversationId,
            text: scheduled.text,
            idempotencyKey: `scheduled-send:${row.eventId}`,
            expectedLastMessageId: scheduled.expectedLastMessageId,
            expectedSequence: scheduled.expectedSequence,
            expectedContextVersion: scheduled.expectedContextVersion,
          });
          const completed = await tx.processingOutbox.updateMany({
            where: { id: row.id, ...scope, status: ProcessingOutboxStatus.DISPATCHING },
            data: { status: ProcessingOutboxStatus.DISPATCHED, dispatchedAt: new Date() },
          });
          if (!completed.count) throw new Error('SCHEDULED_MESSAGE_CLAIM_LOST');
          return 'DISPATCHED' as const;
        });
        if (outcome === 'DISPATCHED') dispatched += 1;
        if (outcome === 'CANCELLED') cancelled += 1;
      } catch {
        // A durable SendOutbox may already exist after a crash. Move back to
        // PENDING and retry its idempotent enqueue rather than dropping it.
        await this.prisma.processingOutbox.updateMany({
          where: { id: row.id, ...scope, status: ProcessingOutboxStatus.DISPATCHING },
          data: { status: ProcessingOutboxStatus.PENDING, availableAt: new Date(now.getTime() + 1_000) },
        });
      }
    }
    return { dispatched, cancelled };
  }

  /** Closing messages are only a safe idle courtesy, never a marketing nudge. */
  private async planDueClosings(now: Date): Promise<void> {
    const conversations = await this.prisma.conversation.findMany({
      where: { state: 'ACTIVE', humanActive: false, idleExpiresAt: { lte: now } },
      select: { id: true, workspaceId: true, tenantId: true, shopId: true, contextVersion: true, lastCommittedSequence: true, currentOrderId: true },
      take: 100,
    });
    for (const conversation of conversations) {
      const scope = { workspaceId: conversation.workspaceId, tenantId: conversation.tenantId, shopId: conversation.shopId };
      const [lastMessage, settings, order] = await Promise.all([
        this.prisma.message.findFirst({
          where: { ...scope, conversationId: conversation.id, status: { not: 'RECALLED' } },
          orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }], select: { id: true },
        }),
        this.prisma.shopSettings.findFirst({
          where: { ...scope, shopId: conversation.shopId }, select: { closingMessagesJson: true },
        }),
        conversation.currentOrderId
          ? this.prisma.order.findFirst({ where: { ...scope, id: conversation.currentOrderId }, select: { id: true, status: true } })
          : Promise.resolve(null),
      ]);
      const text = closingText(settings?.closingMessagesJson, order?.status);
      if (!text) continue;
      await this.schedules!.planClosing(scope, {
        id: conversation.id, contextVersion: conversation.contextVersion,
        lastCommittedSequence: conversation.lastCommittedSequence, lastMessageId: lastMessage?.id,
        currentOrderId: order?.id, currentOrderStatus: order?.status,
      }, text, now);
    }
  }

  private async stillValid(tx: Prisma.TransactionClient, scope: ReplyJobScope, scheduled: ScheduledPayload): Promise<boolean> {
    const [conversation, lastMessage, ready] = await Promise.all([
      tx.conversation.findFirst({
        where: { id: scheduled.conversationId, ...scope },
        select: { id: true, state: true, humanActive: true, contextVersion: true, lastCommittedSequence: true, currentOrderId: true },
      }),
      tx.message.findFirst({
        where: { ...scope, conversationId: scheduled.conversationId, status: { not: 'RECALLED' } },
        orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }], select: { id: true },
      }),
      scopedShopAutoReady(tx, scope, false),
    ]);
    if (!ready) return false;
    if (scheduled.expectedOrderId) {
      if (conversation?.currentOrderId !== scheduled.expectedOrderId) return false;
      const order = await tx.order.findFirst({ where: { ...scope, id: scheduled.expectedOrderId }, select: { status: true } });
      if (!order || order.status !== scheduled.expectedOrderStatus) return false;
    }
    return Boolean(
      conversation
      && conversation.state === 'ACTIVE'
      && !conversation.humanActive
      && conversation.contextVersion === scheduled.expectedContextVersion
      && conversation.lastCommittedSequence === scheduled.expectedSequence
      && (scheduled.expectedLastMessageId ?? null) === (lastMessage?.id ?? null),
    );
  }
}

async function lockScopedShop(tx: Prisma.TransactionClient, scope: ReplyJobScope): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT 1 FROM "Shop"
    WHERE "id" = ${scope.shopId}
      AND "workspaceId" = ${scope.workspaceId}
      AND "tenantId" = ${scope.tenantId}
    FOR UPDATE
  `);
}

async function scopedShopAutoReady(
  tx: Prisma.TransactionClient,
  scope: ReplyJobScope,
  lock: boolean,
): Promise<boolean> {
  if (lock) await lockScopedShop(tx, scope);
  const shop = await tx.shop.findFirst({
    where: { id: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId },
    select: {
      aiMode: true,
      seedKey: true,
      productLearningJobs: {
        where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { status: true },
      },
    },
  });
  return autoReplyReady({
    aiMode: shop?.aiMode,
    seedKey: shop?.seedKey,
    learningStatus: shop?.productLearningJobs[0]?.status,
  });
}

function payload(conversation: ScheduledConversationCursor, text: string): ScheduledPayload {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('SCHEDULED_MESSAGE_TEXT_REQUIRED');
  return {
    conversationId: conversation.id,
    text: trimmed,
    ...(conversation.lastMessageId ? { expectedLastMessageId: conversation.lastMessageId } : {}),
    expectedSequence: conversation.lastCommittedSequence,
    expectedContextVersion: conversation.contextVersion,
    ...(conversation.currentOrderId ? { expectedOrderId: conversation.currentOrderId } : {}),
    ...(conversation.currentOrderStatus ? { expectedOrderStatus: conversation.currentOrderStatus } : {}),
  };
}

function parsePayload(value: unknown): ScheduledPayload | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.conversationId === 'string'
    && typeof record.text === 'string'
    && Number.isSafeInteger(record.expectedSequence)
    && Number.isSafeInteger(record.expectedContextVersion)
    && (record.expectedLastMessageId === undefined || typeof record.expectedLastMessageId === 'string')
    && (record.expectedOrderId === undefined || typeof record.expectedOrderId === 'string')
    && (record.expectedOrderStatus === undefined || typeof record.expectedOrderStatus === 'string')
    ? {
        conversationId: record.conversationId,
        text: record.text,
        ...(typeof record.expectedLastMessageId === 'string' ? { expectedLastMessageId: record.expectedLastMessageId } : {}),
        ...(typeof record.expectedOrderId === 'string' ? { expectedOrderId: record.expectedOrderId } : {}),
        ...(typeof record.expectedOrderStatus === 'string' ? { expectedOrderStatus: record.expectedOrderStatus } : {}),
        expectedSequence: Number(record.expectedSequence),
        expectedContextVersion: Number(record.expectedContextVersion),
      }
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closingText(value: unknown, orderStatus?: string): string | undefined {
  if (Array.isArray(value)) return value.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)?.trim();
  if (!value || typeof value !== 'object') return undefined;
  const messages = value as Record<string, unknown>;
  const key = orderStatus && ['WAITING_SHIPMENT', 'SHIPPED', 'COMPLETED'].includes(orderStatus) ? orderStatus : 'NO_ORDER';
  return typeof messages[key] === 'string' && messages[key].trim() ? messages[key].trim() : undefined;
}
