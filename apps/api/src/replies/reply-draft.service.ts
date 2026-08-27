import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ReplyDraft } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { ReplyJobScope } from './reply-job.service';

export const ASSIST_DRAFT_TTL_MS = 5 * 60_000;

export interface CreateWaitingHumanDraftInput {
  replyJobId: string;
  aiDraft: string;
  sourceContextVersion: number;
  sourceLastMessageId?: string;
  sourceSequence?: number;
}

@Injectable()
export class ReplyDraftService {
  constructor(private readonly prisma: PrismaService) {}

  async createWaitingHuman(
    scope: ReplyJobScope,
    input: CreateWaitingHumanDraftInput,
    now = new Date(),
  ): Promise<ReplyDraft> {
    if (!input.aiDraft.trim()) {
      throw new ConflictException({ code: 'REPLY_DRAFT_EMPTY', message: 'Reply draft must not be empty' });
    }
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.replyJob.findFirst({
        where: { id: input.replyJobId, ...scope },
        select: { id: true, conversationId: true, status: true, sourceContextVersion: true, sourceLastMessageId: true, sourceSequence: true },
      });
      if (!job) throw new NotFoundException({ code: 'REPLY_JOB_NOT_FOUND', message: 'Reply job not found in this Shop' });
      if (!['PENDING', 'GENERATING', 'FAST_PATH_READY'].includes(job.status)) {
        throw new ConflictException({ code: 'REPLY_JOB_NOT_DRAFTABLE', message: 'Reply job is no longer draftable' });
      }
      if (job.sourceContextVersion !== input.sourceContextVersion
        || job.sourceLastMessageId !== input.sourceLastMessageId
        || job.sourceSequence !== input.sourceSequence) {
        throw new ConflictException({ code: 'REPLY_CONTEXT_STALE', message: 'Reply draft source no longer matches its job' });
      }
      // Coordinate with message mutations (which use this same advisory key)
      // and then read the authoritative conversation cursor before creating
      // anything.  A stale worker may never resurrect its ReplyJob as WAITING.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${job.conversationId}))`;
      const conversation = await tx.conversation.findFirst({
        where: { id: job.conversationId, ...scope }, select: { id: true, contextVersion: true, humanActive: true, state: true },
      });
      if (!conversation || conversation.contextVersion !== input.sourceContextVersion || conversation.humanActive || conversation.state !== 'ACTIVE') {
        throw new ConflictException({ code: 'REPLY_CONTEXT_STALE', message: 'Reply draft context changed before persistence' });
      }
      const expiresAt = new Date(now.getTime() + ASSIST_DRAFT_TTL_MS);
      const data = {
        ...scope,
        replyJobId: input.replyJobId,
        aiDraft: input.aiDraft.trim(),
        humanFinal: null,
        editType: null,
        status: 'WAITING_HUMAN' as const,
        sourceContextVersion: input.sourceContextVersion,
        sourceLastMessageId: input.sourceLastMessageId,
        sourceSequence: input.sourceSequence,
        generatedAt: now,
        expiresAt,
        staleReason: null,
      };
      const claimed = await tx.replyJob.updateMany({
        where: {
          id: input.replyJobId, ...scope, sourceContextVersion: input.sourceContextVersion,
          status: { in: ['PENDING', 'GENERATING', 'FAST_PATH_READY'] },
        },
        data: { status: 'WAITING_HUMAN' },
      });
      if (!claimed.count) {
        throw new ConflictException({ code: 'REPLY_CONTEXT_STALE', message: 'Reply job changed before draft persistence' });
      }
      const draft = await tx.replyDraft.upsert({
        where: { replyJobId: input.replyJobId },
        create: data,
        update: data,
      });
      return draft;
    });
  }

  async expireDue(scope: ReplyJobScope, now = new Date()): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.replyDraft.findMany({
        where: { ...scope, status: 'WAITING_HUMAN', expiresAt: { lte: now } },
        select: { replyJobId: true },
      });
      if (due.length === 0) return 0;
      const replyJobIds = due.map((draft) => draft.replyJobId);
      const expired = await tx.replyDraft.updateMany({
        where: { ...scope, replyJobId: { in: replyJobIds }, status: 'WAITING_HUMAN', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      });
      await tx.replyJob.updateMany({
        where: { id: { in: replyJobIds }, ...scope, status: 'WAITING_HUMAN' },
        data: { status: 'EXPIRED' },
      });
      return expired.count;
    });
  }

  /** Recovery runs without a caller scope, but still transitions only due rows. */
  async expireDueAll(now = new Date()): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.replyDraft.findMany({
        where: { status: 'WAITING_HUMAN', expiresAt: { lte: now } },
        select: { replyJobId: true },
      });
      if (due.length === 0) return 0;
      const replyJobIds = due.map((draft) => draft.replyJobId);
      const expired = await tx.replyDraft.updateMany({
        where: { replyJobId: { in: replyJobIds }, status: 'WAITING_HUMAN', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      });
      await tx.replyJob.updateMany({
        where: { id: { in: replyJobIds }, status: 'WAITING_HUMAN' },
        data: { status: 'EXPIRED' },
      });
      return expired.count;
    });
  }

  async staleForContext(
    tx: Prisma.TransactionClient,
    scope: ReplyJobScope,
    conversationId: string,
    reason: string,
  ): Promise<void> {
    const jobs = await tx.replyJob.findMany({
      where: { ...scope, conversationId, status: { in: ['PENDING', 'FAST_PATH_READY', 'GENERATING', 'WAITING_HUMAN'] } },
      select: { id: true },
    });
    if (jobs.length === 0) return;
    const replyJobIds = jobs.map((job) => job.id);
    await tx.replyDraft.updateMany({
      where: { ...scope, replyJobId: { in: replyJobIds }, status: 'WAITING_HUMAN' },
      data: { status: 'STALE', staleReason: reason },
    });
    await tx.replyJob.updateMany({
      where: { ...scope, id: { in: replyJobIds }, status: { in: ['PENDING', 'FAST_PATH_READY', 'GENERATING', 'WAITING_HUMAN'] } },
      data: { status: 'STALE', staleReason: reason },
    });
  }
}
