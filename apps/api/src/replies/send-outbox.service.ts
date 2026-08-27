import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type SendOutbox } from '@prisma/client';
import { evaluateSendGuard, type SendGuardFailureCode } from '@ai-customer-service/core';
import { PrismaService } from '../database/prisma.service';
import type { ReplyJobScope } from './reply-job.service';
import { ConversationTransportMutex, localConversationTransportMutex, transportMutexKey, transportShopMutexKey } from './conversation-transport-mutex.service';
import { TraceService } from '../trace/trace.service';
import { ReplyIncidentPublisher } from '../incidents/reply-incident.publisher';

export interface EnqueueSendOutboxInput {
  replyJobId?: string;
  conversationId: string;
  idempotencyKey: string;
  text: string;
  expectedLastMessageId?: string;
  expectedSequence?: number;
  expectedContextVersion?: number;
  /** Human finals may send while a takeover is active; AI rows never may. */
  senderRole?: 'AI' | 'HUMAN';
}

export type SendClaim =
  | { claimed: true; sendOutbox: SendOutbox }
  | { claimed: false; failureCode: SendGuardFailureCode | 'DUPLICATE_ACTION' };

export type FencedTransportDelivery =
  | {
      delivered: true;
      conversationId: string;
      buyerId: string;
      text: string;
      senderRole: 'AI' | 'HUMAN';
      receipt: Record<string, unknown>;
    }
  | { delivered: false; uncertain: boolean };

/**
 * One durable stale/cancel policy for every ReplyJob writer.  Only an AI
 * reply linked to one of the stale jobs is touched: human finals remain
 * actionable.  A row that crossed the transport-start fence is explicitly
 * uncertain, never retried as though it were still pending.
 */
export async function cancelAiSendsForStaleJobs(
  tx: Prisma.TransactionClient,
  scope: ReplyJobScope,
  replyJobIds: readonly string[],
  reason: string,
): Promise<void> {
  if (!replyJobIds.length) return;
  // Unit ports that exercise only job planning may deliberately omit the
  // unrelated outbox repository. Prisma's real TransactionClient always has
  // it; keeping this seam optional preserves that focused test boundary.
  const sendOutbox = (tx as unknown as { sendOutbox?: typeof tx.sendOutbox }).sendOutbox;
  if (!sendOutbox) return;
  const where = {
    ...scope,
    replyJobId: { in: [...replyJobIds] },
    payloadJson: { path: ['senderRole'], equals: 'AI' },
  };
  await sendOutbox.updateMany({
    where: { ...where, status: 'PENDING' },
    data: { status: 'CANCELLED', failureCode: 'REPLY_JOB_STALE', failureReason: reason },
  });
  await sendOutbox.updateMany({
    where: { ...where, status: 'SENDING', transportStartedAt: null },
    data: { status: 'CANCELLED', failureCode: 'REPLY_JOB_STALE', failureReason: reason },
  });
  await sendOutbox.updateMany({
    where: { ...where, status: 'SENDING', transportStartedAt: { not: null } },
    data: { status: 'UNCERTAIN', failureCode: 'SEND_TRANSPORT_UNKNOWN', failureReason: reason },
  });
}

/**
 * Durable outbound delivery state. Actual transport must only be attempted by
 * a later worker after it claims PENDING -> SENDING and applies SendGuard.
 */
@Injectable()
export class SendOutboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transportMutex: ConversationTransportMutex = localConversationTransportMutex,
    private readonly traces?: TraceService,
    private readonly incidentPublisher?: ReplyIncidentPublisher,
  ) {}

  async enqueue(scope: ReplyJobScope, input: EnqueueSendOutboxInput): Promise<SendOutbox> {
    if (!input.idempotencyKey.trim() || !input.text.trim()) {
      throw new ConflictException({ code: 'SEND_OUTBOX_INVALID', message: 'Send idempotency key and text are required' });
    }
    try {
      return await this.prisma.$transaction((tx) => this.enqueueInTransaction(tx, scope, input));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'SEND_OUTBOX_CONFLICT', message: 'Send idempotency key is already in use' });
      }
      throw error;
    }
  }

  async enqueueInTransaction(
    tx: Prisma.TransactionClient,
    scope: ReplyJobScope,
    input: EnqueueSendOutboxInput,
  ): Promise<SendOutbox> {
    if (!input.idempotencyKey.trim() || !input.text.trim()) {
      throw new ConflictException({ code: 'SEND_OUTBOX_INVALID', message: 'Send idempotency key and text are required' });
    }
    if (input.replyJobId) {
      const job = await tx.replyJob.findFirst({
        where: { id: input.replyJobId, conversationId: input.conversationId, ...scope },
        select: { id: true, conversationId: true },
      });
      if (!job) throw new NotFoundException({ code: 'REPLY_JOB_NOT_FOUND', message: 'Reply job not found in this Shop' });
    }
    const existing = await tx.sendOutbox.findFirst({ where: { ...scope, idempotencyKey: input.idempotencyKey } });
    if (existing) return existing;
    return tx.sendOutbox.create({
      data: {
        ...scope, replyJobId: input.replyJobId, conversationId: input.conversationId, idempotencyKey: input.idempotencyKey,
        payloadJson: { text: input.text.trim(), senderRole: input.senderRole ?? 'AI' },
        expectedLastMessageId: input.expectedLastMessageId, expectedSequence: input.expectedSequence,
        expectedContextVersion: input.expectedContextVersion, status: 'PENDING',
      },
    });
  }

  /** Called only after a successful platform acknowledgement is available. */
  async recordReceipt(scope: ReplyJobScope, sendOutboxId: string, receipt: Record<string, unknown>): Promise<boolean> {
    const received = await this.prisma.$transaction(async (tx) => {
      const outbox = await tx.sendOutbox.findFirst({
        where: { id: sendOutboxId, ...scope },
        select: { id: true, replyJobId: true },
      });
      if (!outbox) return false;
      const updated = await tx.sendOutbox.updateMany({
        where: { id: sendOutboxId, ...scope, status: 'SENDING' },
        data: { status: 'SENT', receiptJson: cloneJson(receipt), failureCode: null, failureReason: null },
      });
      if (!updated.count) return false;
      if (outbox.replyJobId) {
        await tx.replyJob.updateMany({
          where: { id: outbox.replyJobId, ...scope, status: { in: ['FAST_PATH_READY', 'WAITING_HUMAN'] } },
          data: { status: 'SENT' },
        });
        await tx.replyDraft.updateMany({
          where: { replyJobId: outbox.replyJobId, ...scope, status: 'WAITING_HUMAN' },
          data: { status: 'SENT' },
        });
      }
      // A correction becomes corrected only when its human outbox has a
      // durable receipt. Merely creating PENDING must remain DRAFTED.
      const incidents = (tx as unknown as { replyIncident?: { updateMany(input: unknown): Promise<unknown> } }).replyIncident;
      await incidents?.updateMany({
        where: { ...scope, correctionSendOutboxId: sendOutboxId, status: 'CORRECTION_DRAFTED' },
        data: { status: 'CORRECTED' },
      });
      return true;
    });
    if (received) {
      const incidentRepository = (this.prisma as unknown as { replyIncident?: { findFirst(input: unknown): Promise<object | null> } }).replyIncident;
      const correction = await incidentRepository?.findFirst({ where: { ...scope, correctionSendOutboxId: sendOutboxId, status: 'CORRECTED' } });
      if (correction) this.incidentPublisher?.publish(scope, correction);
    }
    return received;
  }

  /**
   * Locks the scoped conversation, rechecks every send cursor, and atomically
   * claims one PENDING row. Transport is deliberately outside this transaction.
   */
  async claim(scope: ReplyJobScope, sendOutboxId: string, forbiddenTermBlocked = false): Promise<SendClaim> {
    return this.prisma.$transaction(async (tx) => {
      const shopRepository = tx as unknown as { shop?: { findFirst(input: unknown): Promise<{ aiMode: string } | null> } };
      const outbox = await tx.sendOutbox.findFirst({
        where: { id: sendOutboxId, ...scope },
      });
      if (!outbox || outbox.status !== 'PENDING') return { claimed: false, failureCode: 'DUPLICATE_ACTION' };

      await tx.$queryRaw(Prisma.sql`
        SELECT 1 FROM "Conversation"
        WHERE "id" = ${outbox.conversationId}
          AND "workspaceId" = ${scope.workspaceId}
          AND "tenantId" = ${scope.tenantId}
          AND "shopId" = ${scope.shopId}
        FOR UPDATE
      `);
      const [conversation, lastMessage, shop] = await Promise.all([
        tx.conversation.findFirst({
          where: { id: outbox.conversationId, ...scope },
          select: { id: true, state: true, humanActive: true, overrideMode: true, lastCommittedSequence: true, contextVersion: true },
        }),
        tx.message.findFirst({
          where: { ...scope, conversationId: outbox.conversationId, status: { not: 'RECALLED' } },
          orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }],
          select: { id: true },
        }),
        shopRepository.shop?.findFirst({ where: { id: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId }, select: { aiMode: true } }) ?? Promise.resolve({ aiMode: 'AUTO_ALLOWED' }),
      ]);
      if (!conversation) return this.rejectClaim(tx, scope, outbox.id, 'CONTEXT_STALE');
      if (!isHumanPayload(outbox.payloadJson) && !autoSendAllowed(shop?.aiMode, conversation.overrideMode)) {
        return this.rejectClaim(tx, scope, outbox.id, 'CONTEXT_STALE');
      }
      if (!isHumanPayload(outbox.payloadJson) && outbox.replyJobId) {
        const job = await tx.replyJob.findFirst({
          where: { id: outbox.replyJobId, conversationId: outbox.conversationId, ...scope, status: 'FAST_PATH_READY' },
          select: { id: true },
        });
        if (!job) return this.rejectClaim(tx, scope, outbox.id, 'CONTEXT_STALE');
      }
      const guard = evaluateSendGuard({
        lastMessageId: lastMessage?.id ?? null,
        lastSequence: conversation.lastCommittedSequence,
        contextVersion: conversation.contextVersion,
        humanActive: isHumanPayload(outbox.payloadJson) ? false : conversation.humanActive,
        conversationState: conversation.state,
        idempotencyKey: outbox.idempotencyKey,
        expectedLastMessageId: outbox.expectedLastMessageId,
        expectedSequence: outbox.expectedSequence,
        expectedContextVersion: outbox.expectedContextVersion,
        forbiddenTermBlocked,
      });
      if (!guard.allowed) return this.rejectClaim(tx, scope, outbox.id, guard.failureCode);
      void this.recordTrace(scope, outbox.conversationId, outbox.id, 'SEND_GUARD', { allowed: true, phase: 'CLAIM', replyJobId: outbox.replyJobId ?? null });
      const claimed = await tx.sendOutbox.updateMany({
        where: { id: outbox.id, ...scope, status: 'PENDING' },
        data: { status: 'SENDING' },
      });
      return claimed.count ? { claimed: true, sendOutbox: outbox } : { claimed: false, failureCode: 'DUPLICATE_ACTION' };
    });
  }

  /** Final fence immediately before transport; takeover can cancel an AI row after its initial claim. */
  async fenceBeforeTransport(scope: ReplyJobScope, sendOutboxId: string, forbiddenTermBlocked = false): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const shopRepository = tx as unknown as { shop?: { findFirst(input: unknown): Promise<{ aiMode: string } | null> } };
      const outbox = await tx.sendOutbox.findFirst({ where: { id: sendOutboxId, ...scope, status: 'SENDING' } });
      if (!outbox) return false;
      await tx.$queryRaw(Prisma.sql`
        SELECT 1 FROM "Conversation" WHERE "id" = ${outbox.conversationId}
          AND "workspaceId" = ${scope.workspaceId} AND "tenantId" = ${scope.tenantId} AND "shopId" = ${scope.shopId}
        FOR UPDATE
      `);
      const [conversation, lastMessage, shop] = await Promise.all([
        tx.conversation.findFirst({ where: { id: outbox.conversationId, ...scope }, select: { humanActive: true, overrideMode: true, state: true, lastCommittedSequence: true, contextVersion: true } }),
        tx.message.findFirst({ where: { ...scope, conversationId: outbox.conversationId, status: { not: 'RECALLED' } }, orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }], select: { id: true } }),
        shopRepository.shop?.findFirst({ where: { id: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId }, select: { aiMode: true } }) ?? Promise.resolve({ aiMode: 'AUTO_ALLOWED' }),
      ]);
      const job = !isHumanPayload(outbox.payloadJson) && outbox.replyJobId
        ? await tx.replyJob.findFirst({
            where: { id: outbox.replyJobId, conversationId: outbox.conversationId, ...scope, status: 'FAST_PATH_READY' },
            select: { id: true },
          })
        : { id: 'human-or-unlinked' };
      const guard = conversation && evaluateSendGuard({
        lastMessageId: lastMessage?.id ?? null, lastSequence: conversation.lastCommittedSequence, contextVersion: conversation.contextVersion,
        humanActive: isHumanPayload(outbox.payloadJson) ? false : conversation.humanActive, conversationState: conversation.state,
        idempotencyKey: outbox.idempotencyKey, expectedLastMessageId: outbox.expectedLastMessageId,
        expectedSequence: outbox.expectedSequence, expectedContextVersion: outbox.expectedContextVersion, forbiddenTermBlocked,
      });
      if (!job || !guard || !guard.allowed || (!isHumanPayload(outbox.payloadJson) && !autoSendAllowed(shop?.aiMode, conversation?.overrideMode))) {
        const failureCode: SendGuardFailureCode = guard && !guard.allowed ? guard.failureCode : 'CONTEXT_STALE';
        await tx.sendOutbox.updateMany({
          where: { id: outbox.id, ...scope, status: 'SENDING' },
          data: { status: 'CANCELLED', failureCode, failureReason: 'SEND_TRANSPORT_FENCED' },
        });
        return false;
      }
      void this.recordTrace(scope, outbox.conversationId, outbox.id, 'SEND_GUARD', { allowed: true, phase: 'TRANSPORT_FENCE', replyJobId: outbox.replyJobId ?? null });
      const started = await tx.sendOutbox.updateMany({
        where: { id: outbox.id, ...scope, status: 'SENDING', transportStartedAt: null },
        data: { transportStartedAt: new Date() },
      });
      return started.count === 1;
    });
  }

  /**
   * Mock-Douyin V1 serializes local takeover and final transport hand-off
   * with a conversation mutex. The final SendGuard persists a durable start
   * marker before network I/O; a crash after platform acceptance therefore
   * remains SENDING+started and recovery/takeover can only mark UNCERTAIN.
   *
   * The mutex is process-local. A multi-process mock deployment needs a
   * provider fencing token; do not mistake this local test adapter seam for
   * a distributed transport guarantee.
   */
  async deliverWithConversationFence(
    scope: ReplyJobScope,
    sendOutboxId: string,
    forbiddenTermBlocked: boolean,
    transport: (input: {
      outbox: SendOutbox;
      conversation: { id: string; buyerId: string; externalConversationId: string; buyer: { externalBuyerId: string } };
      text: string;
      senderRole: 'AI' | 'HUMAN';
    }) => Promise<Record<string, unknown>>,
  ): Promise<FencedTransportDelivery> {
    const pending = await this.prisma.sendOutbox.findFirst({ where: { id: sendOutboxId, ...scope, status: 'SENDING' }, select: { conversationId: true } });
    if (!pending) return { delivered: false, uncertain: false };
    return this.transportMutex.runMany([transportShopMutexKey(scope), transportMutexKey(scope, pending.conversationId)], async () => {
      // This short transaction locks the Conversation and commits the start
      // marker only after the complete SendGuard (including ReplyJob state).
      if (!(await this.fenceBeforeTransport(scope, sendOutboxId, forbiddenTermBlocked))) {
        return { delivered: false, uncertain: false };
      }
      const [outbox, conversation] = await Promise.all([
        this.prisma.sendOutbox.findFirst({ where: { id: sendOutboxId, ...scope, status: 'SENDING', transportStartedAt: { not: null } } }),
        this.prisma.conversation.findFirst({ where: { id: pending.conversationId, ...scope }, include: { buyer: { select: { externalBuyerId: true } } } }),
      ]);
      const text = outbox ? textPayload(outbox.payloadJson) : undefined;
      if (!outbox || !conversation || !text) {
        await this.markUncertain(scope, sendOutboxId, 'SEND_TRANSPORT_CONTEXT_LOST');
        return { delivered: false, uncertain: true };
      }
      const senderRole = senderRolePayload(outbox.payloadJson);
      try {
        const receipt = await transport({ outbox, conversation, text, senderRole });
        if (!(await this.recordReceipt(scope, sendOutboxId, receipt))) {
          await this.markUncertain(scope, sendOutboxId, 'SEND_RECEIPT_CAS_LOST');
          return { delivered: false, uncertain: true };
        }
        return { delivered: true, conversationId: conversation.id, buyerId: conversation.buyerId, text, senderRole, receipt };
      } catch {
        await this.markUncertain(scope, sendOutboxId, 'SEND_TRANSPORT_UNKNOWN');
        return { delivered: false, uncertain: true };
      }
    });
  }

  /** A process restart must never blindly retry a send whose outcome is unknown. */
  async recoverUncertain(staleBefore: Date): Promise<number> {
    const updated = await this.prisma.sendOutbox.updateMany({
      where: { status: 'SENDING', updatedAt: { lt: staleBefore } },
      data: { status: 'UNCERTAIN', failureCode: 'SEND_UNCERTAIN' },
    });
    return updated.count;
  }

  /** A failed transport after SENDING is ambiguous and must never auto-retry. */
  async markUncertain(scope: ReplyJobScope, sendOutboxId: string, failureCode = 'SEND_TRANSPORT_UNKNOWN'): Promise<boolean> {
    const updated = await this.prisma.sendOutbox.updateMany({
      where: { id: sendOutboxId, ...scope, status: 'SENDING' },
      data: { status: 'UNCERTAIN', failureCode },
    });
    return updated.count === 1;
  }

  private async rejectClaim(
    tx: Prisma.TransactionClient,
    scope: ReplyJobScope,
    sendOutboxId: string,
    failureCode: SendGuardFailureCode,
  ): Promise<SendClaim> {
    await tx.sendOutbox.updateMany({
      where: { id: sendOutboxId, ...scope, status: 'PENDING' },
      data: { status: 'FAILED', failureCode, failureReason: 'SEND_GUARD_REJECTED' },
    });
    return { claimed: false, failureCode };
  }

  private async recordTrace(scope: ReplyJobScope, conversationId: string, sendOutboxId: string, stage: string, payload: Record<string, unknown>): Promise<void> {
    try { await this.traces?.record({ ...scope, conversationId }, `send:${sendOutboxId}`, stage, payload); } catch { /* tracing cannot affect a delivery decision */ }
  }
}

function cloneJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isHumanPayload(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).senderRole === 'HUMAN');
}

function textPayload(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const text = (value as Record<string, unknown>).text;
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

function senderRolePayload(value: unknown): 'AI' | 'HUMAN' {
  return isHumanPayload(value) ? 'HUMAN' : 'AI';
}

function autoSendAllowed(shopMode: unknown, overrideMode: unknown): boolean {
  if (overrideMode === 'ASSIST' || overrideMode === 'MANUAL' || overrideMode === 'HOLD') return false;
  return shopMode === 'AUTO_ALLOWED';
}
