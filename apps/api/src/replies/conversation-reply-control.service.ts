import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ReplyDraftEditType } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { containsForbiddenKnowledgeText } from '../knowledge/knowledge.policy';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { ReplyJobService, type ReplyJobScope } from './reply-job.service';
import { SendOutboxService, cancelAiSendsForStaleJobs } from './send-outbox.service';
import { ReplyRuntimeService } from './reply-runtime.service';
import { WorkspaceGateway } from '../websocket/workspace.gateway';
import { ConversationTransportMutex, localConversationTransportMutex, transportMutexKey, transportShopMutexKey } from './conversation-transport-mutex.service';

export type HumanFinalInput = {
  text: string;
  sourceDraftId?: string;
  editType?: ReplyDraftEditType;
};

const ACTIVE_JOB_STATUSES = ['PENDING', 'FAST_PATH_READY', 'GENERATING', 'WAITING_HUMAN', 'CANCELLING', 'RECOVERY_PENDING'] as const;

/** Explicit operator controls; all effects are bounded by workspace/tenant/shop. */
@Injectable()
export class ConversationReplyControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    private readonly replyJobs: ReplyJobService,
    private readonly sendOutboxes: SendOutboxService,
    private readonly runtime?: ReplyRuntimeService,
    private readonly gateway?: WorkspaceGateway,
    private readonly transportMutex: ConversationTransportMutex = localConversationTransportMutex,
  ) {}

  async setMode(scope: ReplyJobScope, conversationId: string, mode: 'AUTO' | 'ASSIST' | 'MANUAL' | 'HOLD') {
    const result = await this.transportMutex.runMany([transportShopMutexKey(scope), transportMutexKey(scope, conversationId)], () => this.prisma.$transaction(async (tx) => {
      await this.lock(tx, conversationId, scope);
      const conversation = await tx.conversation.findFirst({
        where: { id: conversationId, ...scope },
        select: { id: true, contextVersion: true, shop: { select: { aiMode: true } } },
      });
      if (!conversation) throw notFound();
      assertModeWithinShopCeiling(mode, conversation.shop?.aiMode);
      const becomesHumanActive = mode === 'MANUAL' || mode === 'HOLD';
      const updated = await tx.conversation.updateMany({
        where: { id: conversationId, ...scope },
        // Explicit operator selection is the new configured base. Keeping an
        // AUTO request only as an override would remain ASSIST because
        // effectiveConversationMode intentionally treats overrides as
        // conservative ceilings rather than privilege escalation.
        data: { mode, overrideMode: mode, humanActive: becomesHumanActive, needsReplan: true },
      });
      if (updated.count !== 1) throw changed();
      const requiresSaferReply = mode === 'ASSIST' || becomesHumanActive;
      if (requiresSaferReply) await this.staleActive(tx, scope, conversationId, 'MODE_CHANGED');
      await this.cancelScheduled(tx, scope, conversationId);
      if (mode !== 'ASSIST') return {
        id: conversationId, overrideMode: mode, effectiveMode: mode,
        shopAiMode: conversation.shop?.aiMode, humanActive: becomesHumanActive,
        replyJobId: undefined as string | undefined,
      };
      const userTurns = tx as unknown as { userTurn?: { findFirst(input: unknown): Promise<{ id: string; lastSequence: number; sourceMessageIdsJson: unknown } | null> } };
      const latest = userTurns.userTurn
        ? await userTurns.userTurn.findFirst({ where: { ...scope, conversationId }, orderBy: [{ lastSequence: 'desc' }, { updatedAt: 'desc' }], select: { id: true, lastSequence: true, sourceMessageIdsJson: true } })
        : null;
      if (!latest) return {
        id: conversationId, overrideMode: mode, effectiveMode: mode,
        shopAiMode: conversation.shop?.aiMode, humanActive: false,
        replyJobId: undefined as string | undefined,
      };
      const sourceIds = Array.isArray(latest.sourceMessageIdsJson) ? latest.sourceMessageIdsJson : [];
      const sourceLastMessageId = sourceIds.at(-1);
      const job = await this.replyJobs.createInTransaction(tx, scope, {
        conversationId, userTurnId: latest.id, mode: 'ASSIST', sourceLastMessageId: typeof sourceLastMessageId === 'string' ? sourceLastMessageId : undefined,
        sourceSequence: latest.lastSequence, sourceContextVersion: conversation.contextVersion,
        idempotencyKey: `reply-mode-assist:${latest.id}:${conversation.contextVersion}:${randomUUID()}`, evidence: [],
      }, { lockHeld: true });
      return {
        id: conversationId, overrideMode: mode, effectiveMode: mode,
        shopAiMode: conversation.shop?.aiMode, humanActive: false, replyJobId: job.id,
      };
    }));
    if (result.replyJobId && this.runtime) await this.runtime.process(scope, result.replyJobId);
    this.publishRefresh(scope, conversationId);
    return result;
  }

  async takeover(scope: ReplyJobScope, conversationId: string) {
    const result = await this.transportMutex.runMany([transportShopMutexKey(scope), transportMutexKey(scope, conversationId)], () => this.prisma.$transaction(async (tx) => {
      await this.lock(tx, conversationId, scope);
      const conversation = await tx.conversation.findFirst({
        where: { id: conversationId, ...scope }, select: { id: true, shopId: true, contextVersion: true },
      });
      if (!conversation) throw notFound();
      const updated = await tx.conversation.updateMany({
        where: { id: conversationId, ...scope, humanActive: false }, data: { humanActive: true, overrideMode: 'MANUAL' },
      });
      if (!updated.count) {
        return { id: conversationId, humanActive: true, overrideMode: 'MANUAL' as const };
      }
      await this.staleActive(tx, scope, conversationId, 'HUMAN_TAKEOVER');
      await this.cancelScheduled(tx, scope, conversationId);
      return { id: conversationId, humanActive: true, overrideMode: 'MANUAL' as const };
    }));
    this.publishRefresh(scope, conversationId);
    return result;
  }

  async resumeAi(scope: ReplyJobScope, conversationId: string) {
    const resumed = await this.transportMutex.runMany([transportShopMutexKey(scope), transportMutexKey(scope, conversationId)], () => this.prisma.$transaction(async (tx) => {
      await this.lock(tx, conversationId, scope);
      const conversation = await tx.conversation.findFirst({
        where: { id: conversationId, ...scope },
        select: { id: true, contextVersion: true, lastCommittedSequence: true, shop: { select: { aiMode: true } } },
      });
      if (!conversation) throw notFound();
      if (conversation.shop?.aiMode === 'MANUAL_ONLY') {
        throw new ConflictException({
          code: 'SHOP_MANUAL_ONLY',
          message: 'Raise the Shop AI ceiling before resuming AI',
        });
      }
      const resumedMode = conversation.shop?.aiMode === 'AUTO_ALLOWED' ? 'AUTO' as const : 'ASSIST' as const;
      const result = await tx.conversation.updateMany({
        where: { id: conversationId, ...scope, humanActive: true },
        data: { humanActive: false, mode: resumedMode, overrideMode: null, needsReplan: true },
      });
      if (!result.count) return { id: conversationId, humanActive: false, overrideMode: null, resumed: false, replyJobId: undefined as string | undefined };
      const userTurns = tx as unknown as { userTurn?: { findFirst(input: unknown): Promise<{ id: string; lastSequence: number; sourceMessageIdsJson: unknown } | null> } };
      const latest = userTurns.userTurn
        ? await userTurns.userTurn.findFirst({
            where: { ...scope, conversationId }, orderBy: [{ lastSequence: 'desc' }, { updatedAt: 'desc' }],
            select: { id: true, lastSequence: true, sourceMessageIdsJson: true },
          })
        : null;
      if (!latest) return { id: conversationId, humanActive: false, overrideMode: null, resumed: true, replyJobId: undefined as string | undefined };
      const sourceIds = Array.isArray(latest.sourceMessageIdsJson) ? latest.sourceMessageIdsJson : [];
      const sourceLastMessageId = sourceIds.at(-1);
      const job = await this.replyJobs.createInTransaction(tx, scope, {
        conversationId, userTurnId: latest.id, mode: resumedMode,
        sourceLastMessageId: typeof sourceLastMessageId === 'string' ? sourceLastMessageId : undefined,
        sourceSequence: latest.lastSequence, sourceContextVersion: conversation.contextVersion,
        idempotencyKey: `reply-resume:${latest.id}:${conversation.contextVersion}:${randomUUID()}`,
        evidence: [],
      }, { lockHeld: true });
      return { id: conversationId, humanActive: false, overrideMode: null, resumed: true, replyJobId: job.id };
    }));
    if (resumed.replyJobId && this.runtime) await this.runtime.process(scope, resumed.replyJobId);
    this.publishRefresh(scope, conversationId);
    return resumed;
  }

  async regenerate(scope: ReplyJobScope, conversationId: string) {
    const job = await this.transportMutex.runMany([transportShopMutexKey(scope), transportMutexKey(scope, conversationId)], () => this.prisma.$transaction(async (tx) => {
      await this.lock(tx, conversationId, scope);
      const conversation = await tx.conversation.findFirst({
        where: { id: conversationId, ...scope }, select: { id: true, contextVersion: true, humanActive: true, lastCommittedSequence: true },
      });
      if (!conversation) throw notFound();
      if (conversation.humanActive) throw new ConflictException({ code: 'HUMAN_ACTIVE', message: 'Resume AI before regenerating a reply' });
      const turn = await tx.userTurn.findFirst({
        where: { conversationId, ...scope }, orderBy: [{ lastSequence: 'desc' }, { updatedAt: 'desc' }],
        select: { id: true, lastSequence: true, sourceMessageIdsJson: true },
      });
      if (!turn) throw new BadRequestException({ code: 'REPLY_REGENERATE_TURN_REQUIRED', message: 'A user turn is required before regenerating' });
      const sourceMessageIds = Array.isArray(turn.sourceMessageIdsJson) ? turn.sourceMessageIdsJson : [];
      const lastSourceMessageId = sourceMessageIds.at(-1);
      const sourceLastMessageId = typeof lastSourceMessageId === 'string' ? lastSourceMessageId : undefined;
      return this.replyJobs.createInTransaction(tx, scope, {
        conversationId, userTurnId: turn.id, mode: 'ASSIST', sourceLastMessageId,
        sourceSequence: turn.lastSequence, sourceContextVersion: conversation.contextVersion,
        idempotencyKey: `reply-regenerate:${turn.id}:${conversation.contextVersion}:${randomUUID()}`,
        evidence: [],
      }, { lockHeld: true });
    }));
    if (this.runtime) await this.runtime.process(scope, job.id);
    this.publishRefresh(scope, conversationId);
    return job;
  }

  async saveHumanFinal(scope: ReplyJobScope, conversationId: string, input: HumanFinalInput): Promise<{ sendOutboxId: string; candidateId?: string }> {
    const text = input.text?.trim();
    if (!text) throw new BadRequestException({ code: 'HUMAN_MESSAGE_REQUIRED', message: 'text is required' });
    const effect = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, conversationId, scope);
      const conversation = await tx.conversation.findFirst({
        where: { id: conversationId, ...scope }, select: { id: true, buyerId: true, lastCommittedSequence: true, contextVersion: true, humanActive: true, overrideMode: true },
      });
      if (!conversation) throw notFound();
      let replyJobId: string | undefined;
      let sendOutboxId: string | undefined;
      if (input.sourceDraftId) {
        const draft = await tx.replyDraft.findFirst({
          where: { id: input.sourceDraftId, ...scope, replyJob: { conversationId, status: 'WAITING_HUMAN' } },
          select: { id: true, replyJobId: true, aiDraft: true, sourceContextVersion: true, sourceLastMessageId: true, sourceSequence: true, status: true },
        });
        if (!draft) throw new NotFoundException({ code: 'REPLY_DRAFT_NOT_FOUND', message: 'Reply draft not found in this Shop' });
        if (draft.status !== 'WAITING_HUMAN' || draft.sourceContextVersion !== conversation.contextVersion) {
          throw new ConflictException({ code: 'REPLY_DRAFT_STALE', message: 'Reply draft no longer matches the conversation' });
        }
        const updatedDraft = await tx.replyDraft.updateMany({
          where: { id: draft.id, ...scope, status: 'WAITING_HUMAN' },
          data: { humanFinal: text, editType: input.editType ?? 'STYLE_EDIT' },
        });
        if (!updatedDraft.count) throw changed();
        const updatedJob = await tx.replyJob.updateMany({
          where: { id: draft.replyJobId, ...scope, status: 'WAITING_HUMAN' }, data: { status: 'FAST_PATH_READY' },
        });
        if (!updatedJob.count) throw new ConflictException({ code: 'REPLY_DRAFT_STALE', message: 'Reply draft is no longer actionable' });
        replyJobId = draft.replyJobId;
        const outbox = await this.sendOutboxes.enqueueInTransaction(tx, scope, {
          replyJobId: draft.replyJobId, conversationId, text, senderRole: 'HUMAN',
          idempotencyKey: `human-final:${draft.id}:${draft.sourceContextVersion}`,
          expectedLastMessageId: draft.sourceLastMessageId ?? undefined,
          expectedSequence: draft.sourceSequence ?? undefined,
          expectedContextVersion: draft.sourceContextVersion,
        });
        sendOutboxId = outbox.id;
      } else {
        if (!conversation.humanActive && !['MANUAL', 'HOLD'].includes(String(conversation.overrideMode ?? ''))) {
          throw new BadRequestException({ code: 'HUMAN_MESSAGE_DRAFT_REQUIRED', message: 'Take over or select a draft before sending a human final' });
        }
        const lastMessage = await tx.message.findFirst({
          where: { ...scope, conversationId, status: { not: 'RECALLED' } },
          orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }], select: { id: true },
        });
        const outbox = await this.sendOutboxes.enqueueInTransaction(tx, scope, {
          conversationId, text, senderRole: 'HUMAN',
          idempotencyKey: `human-manual:${conversationId}:${conversation.contextVersion}:${conversation.lastCommittedSequence}:${textFingerprint(text)}`,
          expectedLastMessageId: lastMessage?.id,
          expectedSequence: conversation.lastCommittedSequence,
          expectedContextVersion: conversation.contextVersion,
        });
        sendOutboxId = outbox.id;
      }
      const turn = replyJobId && (input.editType === 'FACTUAL_CORRECTION' || input.editType === 'KNOWLEDGE_ENRICHMENT')
        ? await tx.userTurn.findFirst({ where: { conversationId, ...scope }, orderBy: [{ lastSequence: 'desc' }, { updatedAt: 'desc' }], select: { normalizedText: true } })
        : null;
      if (!sendOutboxId) throw new BadRequestException({ code: 'HUMAN_MESSAGE_DRAFT_REQUIRED', message: 'sourceDraftId is required for a durable human final' });
      // Human delivery and long-lived Knowledge have different safety
      // boundaries. A reviewer may send a current fulfillment correction,
      // while inventory/order/relative delivery facts must never be indexed
      // as reusable knowledge. Keep the durable edit label, but skip only the
      // unsafe candidate instead of rolling back the operator's send intent.
      const candidate = replyJobId && turn?.normalizedText
        && (input.editType === 'FACTUAL_CORRECTION' || input.editType === 'KNOWLEDGE_ENRICHMENT')
        && !containsForbiddenKnowledgeText(turn.normalizedText, text)
        ? await this.knowledge.createHumanCandidateInTransaction(tx, scope, {
            shopId: scope.shopId, conversationId, replyJobId,
            question: turn.normalizedText, answer: text, source: input.editType,
          })
        : undefined;
      return { sendOutboxId, candidateId: candidate?.id };
    });
    this.publishRefresh(scope, conversationId);
    return { sendOutboxId: effect.sendOutboxId, ...(effect.candidateId ? { candidateId: effect.candidateId } : {}) };
  }

  /**
   * Locally soft-recall an already projected operator/assistant reply. The
   * immutable version and audit fact remain, and remoteRecalled=false makes
   * the demo transport boundary explicit instead of pretending a platform
   * withdrawal occurred.
   */
  async deleteOutgoingMessage(scope: ReplyJobScope, conversationId: string, messageId: string) {
    const result = await this.transportMutex.runMany(
      [transportShopMutexKey(scope), transportMutexKey(scope, conversationId)],
      () => this.prisma.$transaction(async (tx) => {
        await this.lock(tx, conversationId, scope);
        const conversation = await tx.conversation.findFirst({
          where: { id: conversationId, ...scope }, select: { id: true },
        });
        if (!conversation) throw notFound();
        const message = await tx.message.findFirst({
          where: { id: messageId, conversationId, ...scope },
          include: { _count: { select: { versions: true } } },
        });
        if (!message) {
          throw new NotFoundException({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found in this Conversation and Shop' });
        }
        if (message.role !== 'ASSISTANT' && message.role !== 'HUMAN') {
          throw new BadRequestException({
            code: 'OUTGOING_MESSAGE_REQUIRED',
            message: 'Only assistant or human replies can be removed here; use buyer recall for buyer messages',
          });
        }
        if (message.status === 'RECALLED') {
          return { id: message.id, status: 'RECALLED' as const, remoteRecalled: false as const };
        }
        if (message.status === 'DELETED') {
          throw new ConflictException({ code: 'MESSAGE_PRIVACY_DELETED', message: 'Privacy-deleted messages cannot be changed' });
        }
        await tx.messageVersion.create({
          data: {
            workspaceId: scope.workspaceId, tenantId: scope.tenantId,
            messageId: message.id, version: message._count.versions + 1,
            status: message.status,
            contentJson: message.contentJson === null ? Prisma.JsonNull : message.contentJson,
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { status: 'RECALLED' } });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { contextVersion: { increment: 1 }, needsReplan: true },
        });
        await this.staleActive(tx, scope, conversationId, 'OUTGOING_MESSAGE_RECALLED');
        await this.cancelScheduled(tx, scope, conversationId);
        await tx.conversationMemory.updateMany({
          where: { ...scope, conversationId, basedOnThroughSequence: { gte: message.sequence } },
          data: { status: 'DIRTY' },
        });
        await tx.auditLog.create({
          data: {
            workspaceId: scope.workspaceId, tenantId: scope.tenantId,
            action: 'OUTGOING_MESSAGE_SOFT_RECALLED', entityType: 'MESSAGE', entityId: message.id,
            metadataJson: {
              shopId: scope.shopId, conversationId, role: message.role,
              previousStatus: message.status, sequence: message.sequence,
              remoteRecalled: false,
            },
          },
        });
        return { id: message.id, status: 'RECALLED' as const, remoteRecalled: false as const };
      }),
    );
    this.publishRefresh(scope, conversationId);
    return result;
  }

  private async cancelScheduled(tx: Prisma.TransactionClient, scope: ReplyJobScope, conversationId: string): Promise<void> {
    await tx.processingOutbox.updateMany({
      where: { ...scope, aggregateType: 'CONVERSATION', aggregateId: conversationId, eventType: { in: ['SCHEDULED_WELCOME', 'SCHEDULED_CLOSING'] }, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  }

  private async staleActive(tx: Prisma.TransactionClient, scope: ReplyJobScope, conversationId: string, reason: string): Promise<void> {
    const jobRepository = tx.replyJob as unknown as { findMany?: (input: unknown) => Promise<Array<{ id: string }>> };
    const active = jobRepository.findMany
      ? await jobRepository.findMany({ where: { ...scope, conversationId, status: { in: [...ACTIVE_JOB_STATUSES] } }, select: { id: true } })
      : [];
    await tx.replyJob.updateMany({
      where: { ...scope, conversationId, status: { in: [...ACTIVE_JOB_STATUSES] } },
      data: { status: 'STALE', staleReason: reason },
    });
    if (active.length) await tx.replyDraft.updateMany({
      where: { ...scope, status: 'WAITING_HUMAN', replyJobId: { in: active.map((job) => job.id) } }, data: { status: 'STALE', staleReason: reason },
    });
    await cancelAiSendsForStaleJobs(tx, scope, active.map((job) => job.id), reason);
  }

  private async lock(tx: Prisma.TransactionClient, conversationId: string, scope: ReplyJobScope): Promise<void> {
    await tx.$queryRaw(Prisma.sql`
      SELECT 1 FROM "Conversation"
      WHERE "id" = ${conversationId} AND "workspaceId" = ${scope.workspaceId}
        AND "tenantId" = ${scope.tenantId} AND "shopId" = ${scope.shopId}
      FOR UPDATE
    `);
  }

  private publishRefresh(scope: ReplyJobScope, conversationId: string): void {
    this.gateway?.publish({
      eventId: randomUUID(), eventType: 'CONVERSATION_UPDATED', workspaceId: scope.workspaceId,
      entityType: 'CONVERSATION', entityId: conversationId, entityVersion: 1,
      occurredAt: new Date().toISOString(), payload: { conversationId, refresh: true },
    });
  }
}

function textFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function notFound(): NotFoundException {
  return new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found in this Shop' });
}

function changed(): ConflictException {
  return new ConflictException({ code: 'CONVERSATION_CHANGED', message: 'Conversation changed; retry the command' });
}

function assertModeWithinShopCeiling(
  requested: 'AUTO' | 'ASSIST' | 'MANUAL' | 'HOLD',
  shopMode: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY' | undefined,
): void {
  if (requested === 'AUTO' && shopMode !== 'AUTO_ALLOWED') {
    throw new ConflictException({
      code: 'SHOP_AUTO_MODE_DISABLED',
      message: 'Enable AUTO_ALLOWED for this Shop before selecting AUTO',
      shopAiMode: shopMode ?? 'UNKNOWN', requestedMode: requested,
    });
  }
  if (requested === 'ASSIST' && shopMode === 'MANUAL_ONLY') {
    throw new ConflictException({
      code: 'SHOP_AI_MODE_CEILING',
      message: 'This Shop is MANUAL_ONLY; raise the Shop ceiling before selecting ASSIST',
      shopAiMode: shopMode, requestedMode: requested,
    });
  }
}
