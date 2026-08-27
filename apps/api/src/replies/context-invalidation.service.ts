import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceGateway } from '../websocket/workspace.gateway';
import type { ReplyJobScope } from './reply-job.service';
import { cancelAiSendsForStaleJobs } from './send-outbox.service';
import { ConversationTransportMutex, localConversationTransportMutex, transportShopMutexKey } from './conversation-transport-mutex.service';

const ACTIVE_JOB_STATUSES = ['PENDING', 'GENERATING', 'FAST_PATH_READY', 'WAITING_HUMAN', 'RECOVERY_PENDING'] as const;

/**
 * Dynamic operational facts are never knowledge.  This narrow, scoped seam
 * lets a sync/scenario writer atomically change inventory/order state and
 * invalidate every reply cursor that had selected the affected entity.
 */
@Injectable()
export class ContextInvalidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway?: WorkspaceGateway,
    private readonly transportMutex: ConversationTransportMutex = localConversationTransportMutex,
  ) {}

  async updateSkuInventory(scope: ReplyJobScope, productId: string, skuId: string, inventory: number) {
    if (!Number.isSafeInteger(inventory) || inventory < 0) throw new RangeError('SKU_INVENTORY_INVALID');
    const result = await this.transportMutex.runMany([transportShopMutexKey(scope)], () => this.prisma.$transaction(async (tx) => {
      const updated = await tx.productSku.updateMany({
        where: { id: skuId, productId, ...scope }, data: { inventory },
      });
      if (!updated.count) return { updated: false as const, ids: [] as string[] };
      const ids = await this.invalidateFor(tx, scope, { currentProductId: productId }, 'SKU_INVENTORY_CHANGED');
      return { updated: true as const, ids };
    }));
    if (result.updated) {
      this.gateway?.publish({
        eventId: randomUUID(), eventType: 'PRODUCT_UPDATED', workspaceId: scope.workspaceId,
        entityType: 'PRODUCT', entityId: productId, entityVersion: 1, occurredAt: new Date().toISOString(),
        payload: { shopId: scope.shopId, productId, product: { id: productId, skuId, inventory } },
      });
      this.publishConversations(scope, result.ids);
    }
    return { updated: result.updated, invalidatedConversations: result.ids.length };
  }

  async updateOrderStatus(scope: ReplyJobScope, orderId: string, status: string) {
    if (!status.trim()) throw new RangeError('ORDER_STATUS_INVALID');
    const result = await this.transportMutex.runMany([transportShopMutexKey(scope)], () => this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: orderId, ...scope }, data: { status: status.trim(), version: { increment: 1 } },
      });
      if (!updated.count) return { updated: false as const, ids: [] as string[] };
      const ids = await this.invalidateFor(tx, scope, { currentOrderId: orderId }, 'ORDER_STATUS_CHANGED');
      return { updated: true as const, ids };
    }));
    if (result.updated) {
      this.gateway?.publish({
        eventId: randomUUID(), eventType: 'ORDER_UPDATED', workspaceId: scope.workspaceId,
        entityType: 'ORDER', entityId: orderId, entityVersion: 1, occurredAt: new Date().toISOString(),
        payload: { shopId: scope.shopId, orderId, order: { id: orderId, status: status.trim() } },
      });
      this.publishConversations(scope, result.ids);
    }
    return { updated: result.updated, invalidatedConversations: result.ids.length };
  }

  private async invalidateFor(
    tx: Prisma.TransactionClient,
    scope: ReplyJobScope,
    entity: { currentProductId?: string; currentOrderId?: string },
    reason: 'SKU_INVENTORY_CHANGED' | 'ORDER_STATUS_CHANGED',
  ): Promise<string[]> {
    const conversations = await tx.conversation.findMany({ where: { ...scope, ...entity }, select: { id: true } });
    const ids = conversations.map((row) => row.id);
    const jobRepository = tx.replyJob as unknown as { findMany?: (input: unknown) => Promise<Array<{ id: string; conversationId: string }>> };
    const activeJobs = ids.length && jobRepository.findMany
      ? await jobRepository.findMany({ where: { ...scope, conversationId: { in: ids }, status: { in: [...ACTIVE_JOB_STATUSES] } }, select: { id: true, conversationId: true } })
      : [];
    const outboxRepository = tx as unknown as { sendOutbox?: { findMany(input: unknown): Promise<Array<{ conversationId: string }>> } };
    const actionableOutboxes = ids.length && outboxRepository.sendOutbox?.findMany
      ? await outboxRepository.sendOutbox.findMany({
          where: { ...scope, conversationId: { in: ids }, status: { in: ['PENDING', 'SENDING'] }, payloadJson: { path: ['senderRole'], equals: 'AI' } },
          select: { conversationId: true },
        })
      : [];
    const replanIds = [...new Set([...activeJobs.map((job) => job.conversationId), ...actionableOutboxes.map((row) => row.conversationId)])];
    if (ids.length) {
      await tx.$queryRaw(Prisma.sql`
        SELECT 1 FROM "Conversation"
        WHERE "id" IN (${Prisma.join(ids)})
          AND "workspaceId" = ${scope.workspaceId} AND "tenantId" = ${scope.tenantId} AND "shopId" = ${scope.shopId}
        FOR UPDATE
      `);
      await tx.conversation.updateMany({
        where: { id: { in: ids }, ...scope, ...entity }, data: { contextVersion: { increment: 1 }, needsReplan: true },
      });
      await this.enqueueReplans(tx, scope, replanIds);
    }
    if (ids.length) await tx.replyJob.updateMany({
      where: { ...scope, conversationId: { in: ids }, status: { in: [...ACTIVE_JOB_STATUSES] } }, data: { status: 'STALE', staleReason: reason },
    });
    if (activeJobs.length) await tx.replyDraft.updateMany({
      where: { ...scope, replyJobId: { in: activeJobs.map((job) => job.id) }, status: 'WAITING_HUMAN' }, data: { status: 'STALE', staleReason: reason },
    });
    await cancelAiSendsForStaleJobs(tx, scope, activeJobs.map((job) => job.id), reason);
    return ids;
  }

  /**
   * A fact update must replan the most recent turn even when no buyer sends a
   * further message.  The new context version is part of the deterministic
   * event id, so retries coalesce but a later fact revision creates a fresh
   * job rather than reviving the stale one.
   */
  private async enqueueReplans(tx: Prisma.TransactionClient, scope: ReplyJobScope, conversationIds: string[]): Promise<void> {
    if (!conversationIds.length) return;
    const repository = tx as unknown as {
      conversation: { findMany(input: unknown): Promise<Array<{ id: string; contextVersion?: number }>> };
      userTurn?: { findFirst(input: unknown): Promise<{ id: string; lastSequence: number; sourceMessageIdsJson: unknown } | null> };
      processingOutbox?: { upsert(input: unknown): Promise<unknown> };
    };
    if (!repository.userTurn || !repository.processingOutbox) return;
    const conversations = await repository.conversation.findMany({
      where: { id: { in: conversationIds }, ...scope }, select: { id: true, contextVersion: true },
    });
    for (const conversation of conversations) {
      if (!Number.isSafeInteger(conversation.contextVersion)) continue;
      const turn = await repository.userTurn.findFirst({
        where: { ...scope, conversationId: conversation.id }, orderBy: [{ lastSequence: 'desc' }, { updatedAt: 'desc' }],
        select: { id: true, lastSequence: true, sourceMessageIdsJson: true },
      });
      if (!turn) continue;
      const ids = Array.isArray(turn.sourceMessageIdsJson) ? turn.sourceMessageIdsJson : [];
      const sourceLastMessageId = typeof ids.at(-1) === 'string' ? ids.at(-1) : undefined;
      const eventId = `reply-replan:${turn.id}:v${conversation.contextVersion}`;
      await repository.processingOutbox.upsert({
        where: { eventId }, update: {},
        create: {
          ...scope, eventId, aggregateType: 'USER_TURN', aggregateId: turn.id, eventType: 'USER_TURN_READY',
          payloadJson: {
            conversationId: conversation.id, userTurnId: turn.id, sourceLastMessageId,
            sourceSequence: turn.lastSequence, sourceContextVersion: conversation.contextVersion,
          },
        },
      });
    }
  }

  private publishConversations(scope: ReplyJobScope, conversationIds: string[]): void {
    for (const conversationId of conversationIds) {
      this.gateway?.publish({
        eventId: randomUUID(), eventType: 'CONVERSATION_UPDATED', workspaceId: scope.workspaceId,
        entityType: 'CONVERSATION', entityId: conversationId, entityVersion: 1, occurredAt: new Date().toISOString(),
        payload: { conversationId, refresh: true },
      });
    }
  }
}
