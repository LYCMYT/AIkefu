import { Injectable, Logger, Optional, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { MockDouyinAdapter } from '@ai-customer-service/mock-douyin';
import { checkForbiddenTerms } from '@ai-customer-service/core';
import { PrismaService } from '../database/prisma.service';
import { SendOutboxService } from './send-outbox.service';
import { WorkspaceGateway } from '../websocket/workspace.gateway';
import { randomUUID } from 'node:crypto';
import { TraceService } from '../trace/trace.service';

/**
 * V1's sole platform dispatcher. It keeps the synthetic transport outside the
 * SendGuard transaction, records only confirmed acknowledgements as SENT, and
 * leaves ambiguous post-claim failures UNCERTAIN for explicit review.
 */
@Injectable()
export class MockDouyinSendWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MockDouyinSendWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outboxes: SendOutboxService,
    private readonly adapter: MockDouyinAdapter,
    private readonly gateway?: WorkspaceGateway,
    @Optional() private readonly traces?: TraceService,
  ) {}

  onModuleInit(): void {
    if (!process.env.DATABASE_URL?.trim()) return;
    void this.recoverReceiptProjections().catch((error: unknown) => this.logger.error(message(error)));
    this.timer = setInterval(() => void this.dispatchOnce().catch((error: unknown) => this.logger.error(message(error))), 400);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async dispatchOnce(): Promise<{ sent: number; skipped: number; failed: number }> {
    const rows = await this.prisma.sendOutbox.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 25 });
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const row of rows) {
      const scope = { workspaceId: row.workspaceId, tenantId: row.tenantId, shopId: row.shopId };
      const textBeforeClaim = textPayload(row.payloadJson) ?? '';
      const settings = await this.prisma.shopSettings.findFirst({
        where: { ...scope, shopId: scope.shopId }, select: { forbiddenTermsJson: true },
      });
      const forbiddenTermBlocked = !checkForbiddenTerms(textBeforeClaim, forbiddenRules(settings?.forbiddenTermsJson)).allowed;
      const claim = await this.outboxes.claim(scope, row.id, forbiddenTermBlocked);
      if (!claim.claimed) {
        skipped += 1;
        continue;
      }
      try {
        const delivery = await this.outboxes.deliverWithConversationFence(scope, claim.sendOutbox.id, forbiddenTermBlocked, async ({ outbox, conversation, text }) => {
          const event = await this.adapter.sendMessage({
            ...scope, externalBuyerId: conversation.buyer.externalBuyerId,
            externalConversationId: conversation.externalConversationId, text, externalMessageId: outbox.id,
          });
          const platformMessage = event.payload.message;
          return {
            externalMessageId: platformMessage?.externalMessageId ?? outbox.id,
            sentAt: platformMessage?.sentAt ?? new Date().toISOString(),
          };
        });
        if (!delivery.delivered) {
          if (delivery.uncertain) failed += 1;
          else skipped += 1;
          continue;
        }
        const externalMessageId = typeof delivery.receipt.externalMessageId === 'string' ? delivery.receipt.externalMessageId : undefined;
        const sentAt = typeof delivery.receipt.sentAt === 'string' ? delivery.receipt.sentAt : undefined;
        if (await this.persistVisibleMessage(scope, delivery.conversationId, delivery.buyerId, delivery.text, delivery.senderRole, externalMessageId, sentAt)) {
          this.publishRefresh(scope, delivery.conversationId);
          await this.recordReceiptTrace(scope, delivery.conversationId, externalMessageId, claim.sendOutbox.id, delivery.senderRole);
        }
        sent += 1;
      } catch (error) {
        // A transport call may have reached the platform even when it rejected
        // locally; the only safe automatic action is to stop retries.
        await this.outboxes.markUncertain(scope, claim.sendOutbox.id, 'SEND_TRANSPORT_UNKNOWN');
        failed += 1;
      }
    }
    return { sent, skipped, failed };
  }

  /** Restarts repair the durable receipt → chat projection without re-sending. */
  async recoverReceiptProjections(): Promise<number> {
    const rows = await this.prisma.sendOutbox.findMany({
      where: { status: 'SENT' }, orderBy: { updatedAt: 'asc' }, take: 100,
    });
    let repaired = 0;
    for (const row of rows) {
      const text = textPayload(row.payloadJson);
      const receipt = record(row.receiptJson);
      const externalMessageId = typeof receipt.externalMessageId === 'string' ? receipt.externalMessageId : undefined;
      if (!text || !externalMessageId) continue;
      const scope = { workspaceId: row.workspaceId, tenantId: row.tenantId, shopId: row.shopId };
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: row.conversationId, ...scope }, select: { buyerId: true },
      });
      if (!conversation) continue;
      if (await this.persistVisibleMessage(scope, row.conversationId, conversation.buyerId, text, senderRolePayload(row.payloadJson), externalMessageId, typeof receipt.sentAt === 'string' ? receipt.sentAt : undefined)) {
        repaired += 1;
        this.publishRefresh(scope, row.conversationId);
        await this.recordReceiptTrace(scope, row.conversationId, externalMessageId, row.id, senderRolePayload(row.payloadJson));
      }
    }
    return repaired;
  }

  private async persistVisibleMessage(
    scope: { workspaceId: string; tenantId: string; shopId: string }, conversationId: string, buyerId: string,
    text: string, senderRole: 'AI' | 'HUMAN', externalMessageId?: string, sentAt?: string,
  ): Promise<boolean> {
    const client = this.prisma as unknown as { $transaction?: Function };
    if (!client.$transaction) return false;
    return client.$transaction(async (tx: PrismaLikeTransaction) => {
      // All message writers use the conversation id advisory key.  A receipt
      // replay therefore cannot race an inbound commit for the same sequence.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conversationId}))`;
      const projectionId = externalMessageId ?? `outbox:${conversationId}`;
      const existing = await tx.message.findFirst({
        where: { platform: 'DOUYIN_DEMO', shopId: scope.shopId, externalMessageId: projectionId },
        select: { id: true },
      });
      if (existing) return false;
      const conversation = await tx.conversation.findFirst({ where: { id: conversationId, ...scope }, select: { lastCommittedSequence: true } });
      if (!conversation) return false;
      const sequence = conversation.lastCommittedSequence + 1;
      await tx.message.create({
        data: {
          // SendOutbox's transport role intentionally has the compact AI/HUMAN
          // vocabulary.  Persisting it directly is invalid Prisma data: the
          // conversation Message enum uses ASSISTANT for automated replies.
          ...scope, conversationId, buyerId, platform: 'DOUYIN_DEMO', role: senderRole === 'AI' ? 'ASSISTANT' : 'HUMAN', kind: 'TEXT', status: 'ACTIVE',
          externalMessageId: projectionId, sequence,
          contentJson: { text }, sentAt: sentAt ? new Date(sentAt) : new Date(), receivedAt: new Date(),
        },
      });
      const advanced = await tx.conversation.updateMany({
        where: { id: conversationId, ...scope, lastCommittedSequence: conversation.lastCommittedSequence },
        data: { lastCommittedSequence: sequence, lastMessageAt: new Date() },
      });
      if (advanced.count !== 1) throw new Error('SEND_PROJECTION_CURSOR_CAS_LOST');
      return true;
    });
  }

  private publishRefresh(scope: { workspaceId: string; tenantId: string; shopId: string }, conversationId: string): void {
    this.gateway?.publish({
      eventId: randomUUID(), eventType: 'CONVERSATION_UPDATED', workspaceId: scope.workspaceId,
      entityType: 'CONVERSATION', entityId: conversationId, entityVersion: 1, occurredAt: new Date().toISOString(),
      payload: { conversationId, refresh: true },
    });
  }

  private async recordReceiptTrace(scope: { workspaceId: string; tenantId: string; shopId: string }, conversationId: string, externalMessageId: string | undefined, sendOutboxId: string, senderRole: 'AI' | 'HUMAN'): Promise<void> {
    if (!this.traces || !externalMessageId) return;
    try {
      const message = await this.prisma.message.findFirst({ where: { ...scope, platform: 'DOUYIN_DEMO', externalMessageId }, select: { id: true } });
      if (message) await this.traces.record({ ...scope, conversationId }, `reply:${message.id}`, 'SEND_RECEIPT', { sendOutboxId, senderRole, status: 'SENT' });
    } catch { /* diagnostics must not affect a confirmed receipt */ }
  }
}

type PrismaLikeTransaction = {
  $executeRaw: { (query: TemplateStringsArray, ...values: unknown[]): Promise<unknown> };
  conversation: { findFirst(input: unknown): Promise<{ lastCommittedSequence: number } | null>; updateMany(input: unknown): Promise<{ count: number }> };
  message: { findFirst(input: unknown): Promise<{ id: string } | null>; create(input: unknown): Promise<unknown> };
};

function textPayload(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const text = (value as Record<string, unknown>).text;
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

function senderRolePayload(value: unknown): 'AI' | 'HUMAN' {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).senderRole === 'HUMAN') ? 'HUMAN' : 'AI';
}

function forbiddenRules(value: unknown): Array<{ term: string; replacement: string }> {
  if (Array.isArray(value)) return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    return typeof record.term === 'string' ? [{ term: record.term, replacement: typeof record.replacement === 'string' ? record.replacement : '' }] : [];
  });
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([term, replacement]) => typeof replacement === 'string' ? [{ term, replacement }] : []);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
