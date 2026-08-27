import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ReplyJob } from '@prisma/client';
import type { ReplyEvidenceSnapshot } from '@ai-customer-service/contracts';
import { PrismaService } from '../database/prisma.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { cancelAiSendsForStaleJobs } from './send-outbox.service';

export type ReplyJobScope = WorkspaceScope & { shopId: string };

export type ReplyJobMode = 'AUTO' | 'ASSIST' | 'MANUAL';

export interface CreateReplyJobInput {
  conversationId: string;
  userTurnId: string;
  mode: ReplyJobMode;
  sourceLastMessageId?: string;
  sourceSequence: number;
  sourceContextVersion: number;
  idempotencyKey: string;
  evidence: ReplyEvidenceSnapshot[];
}

export interface CreateReplyJobOptions {
  /** The caller already acquired the exact scoped Conversation row lock. */
  lockHeld?: boolean;
}

const ACTIVE_REPLY_JOB_STATUSES = [
  'PENDING',
  'FAST_PATH_READY',
  'GENERATING',
  'WAITING_HUMAN',
  'CANCELLING',
  'RECOVERY_PENDING',
] as const;

/**
 * The ReplyJob is the durable boundary between a planned UserTurn and later
 * composition/send workers. This service deliberately does not invoke models
 * or platforms, so its transaction stays short and restart-safe.
 */
@Injectable()
export class ReplyJobService {
  constructor(private readonly prisma: PrismaService) {}

  async create(scope: ReplyJobScope, input: CreateReplyJobInput): Promise<ReplyJob> {
    validateCreateInput(input);
    try {
      return await this.prisma.$transaction((tx) => this.createInTransaction(tx, scope, input));
    } catch (error) {
      if (isUniqueViolation(error)) {
        // No unscoped recovery lookup: callers may retry the same scoped
        // idempotency key, otherwise they receive a neutral conflict.
        throw new ConflictException({ code: 'REPLY_JOB_CONFLICT', message: 'A reply job is already active' });
      }
      throw error;
    }
  }

  async createInTransaction(
    tx: Prisma.TransactionClient,
    scope: ReplyJobScope,
    input: CreateReplyJobInput,
    options: CreateReplyJobOptions = {},
  ): Promise<ReplyJob> {
    validateCreateInput(input);
    if (!options.lockHeld) {
      // Serialize per conversation. The partial unique index is a second
      // line of defence if an application process loses this lock.
      await tx.$queryRaw(Prisma.sql`
        SELECT 1 FROM "Conversation"
        WHERE "id" = ${input.conversationId}
          AND "workspaceId" = ${scope.workspaceId}
          AND "tenantId" = ${scope.tenantId}
          AND "shopId" = ${scope.shopId}
        FOR UPDATE
      `);
    }

    const existing = await tx.replyJob.findFirst({
      where: { ...scope, idempotencyKey: input.idempotencyKey },
    });
    if (existing) return existing;

    const conversation = await tx.conversation.findFirst({
      where: { id: input.conversationId, ...scope },
      select: { id: true, contextVersion: true },
    });
    if (!conversation) throw replyContextNotFound();
    if (conversation.contextVersion !== input.sourceContextVersion) {
      throw new ConflictException({ code: 'REPLY_CONTEXT_STALE', message: 'Reply context has changed' });
    }

    const userTurn = await tx.userTurn.findFirst({
      where: { id: input.userTurnId, conversationId: input.conversationId, ...scope },
      select: { id: true },
    });
    if (!userTurn) throw replyContextNotFound();

    const active = await tx.replyJob.findMany({
      where: {
        ...scope,
        conversationId: input.conversationId,
        status: { in: [...ACTIVE_REPLY_JOB_STATUSES] },
      },
      select: { id: true },
    });
    await tx.replyJob.updateMany({
      where: {
        ...scope,
        conversationId: input.conversationId,
        status: { in: [...ACTIVE_REPLY_JOB_STATUSES] },
      },
      data: { status: 'STALE', staleReason: 'NEW_REPLY_JOB' },
    });
    if (active.length > 0) {
      await tx.replyDraft.updateMany({
        where: { ...scope, replyJobId: { in: active.map((job) => job.id) }, status: 'WAITING_HUMAN' },
        data: { status: 'STALE', staleReason: 'NEW_REPLY_JOB' },
      });
      await cancelAiSendsForStaleJobs(tx, scope, active.map((job) => job.id), 'NEW_REPLY_JOB');
    }
    const job = await tx.replyJob.create({
      data: {
        ...scope,
        conversationId: input.conversationId,
        userTurnId: input.userTurnId,
        mode: input.mode,
        status: 'PENDING',
        sourceLastMessageId: input.sourceLastMessageId,
        sourceSequence: input.sourceSequence,
        sourceContextVersion: input.sourceContextVersion,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (input.evidence.length > 0) {
      await tx.replyEvidence.createMany({
        data: input.evidence.map((evidence) => ({
          ...scope,
          replyJobId: job.id,
          knowledgeItemId: evidence.itemId,
          knowledgeVersionId: evidence.versionId,
          knowledgeVersionNumber: evidence.version,
          sourceType: evidence.source,
          scope: evidence.scope,
          productId: evidence.productId,
          retrievedContentSnapshotJson: cloneJson(evidence.contentSnapshot),
          retrievalScore: evidence.retrievalScore,
        })),
      });
    }
    // A successful current-context plan consumes the coalescing signal. Any
    // subsequent message must set it again while holding this same row lock.
    await tx.conversation.updateMany({
      where: { id: input.conversationId, ...scope, contextVersion: input.sourceContextVersion },
      data: { needsReplan: false },
    });
    return job;
  }

  async get(scope: ReplyJobScope, replyJobId: string) {
    return this.prisma.replyJob.findFirst({
      where: { id: replyJobId, ...scope },
      include: { evidences: true },
    });
  }
}

function replyContextNotFound(): NotFoundException {
  return new NotFoundException({ code: 'REPLY_CONTEXT_NOT_FOUND', message: 'Conversation or UserTurn not found in this Shop' });
}

function validateCreateInput(input: CreateReplyJobInput): void {
  if (!input.conversationId || !input.userTurnId || !input.idempotencyKey) {
    throw new ConflictException({ code: 'REPLY_JOB_INVALID', message: 'Reply job identifiers are required' });
  }
  if (!Number.isSafeInteger(input.sourceSequence) || input.sourceSequence < 0
    || !Number.isSafeInteger(input.sourceContextVersion) || input.sourceContextVersion < 1) {
    throw new ConflictException({ code: 'REPLY_JOB_INVALID', message: 'Reply source version is invalid' });
  }
}

function cloneJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
