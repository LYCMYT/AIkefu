import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  buildConversationMemory,
  validateStructuredOutput,
  type GeneratedConversationSummary,
} from '@ai-customer-service/core';
import { PrismaService } from '../database/prisma.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import {
  CONVERSATION_MEMORY_REBUILD_SCHEDULER,
  type ConversationMemoryRebuildRequest,
  type ConversationMemoryRebuildScheduler,
} from './conversation-memory.scheduler';

/**
 * Immutable values observed by the worker before it waits on the model. They
 * are used as an optimistic-concurrency token when that output is persisted.
 */
export type ConversationMemoryRebuildBaseline = {
  contextVersion: number;
  summaryVersion: number;
  memoryUpdatedAt: Date;
};

export type ConversationMemoryRebuildResult =
  | {
      conversationId: string;
      applied: false;
      retry: boolean;
    }
  | ({
      id: string;
      conversationId: string;
      updatedAt: string;
      applied: true;
      retry: false;
    } & ReturnType<typeof buildConversationMemory>);

@Injectable()
export class ConversationMemoryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(CONVERSATION_MEMORY_REBUILD_SCHEDULER)
    private readonly rebuildScheduler?: ConversationMemoryRebuildScheduler,
  ) {}

  /**
   * Called only after the transaction that made a summary stale has committed.
   * The in-memory scheduler intentionally coalesces repeated requests; the
   * durable DIRTY state remains the recovery source if this process exits.
   */
  async scheduleRebuild(request: ConversationMemoryRebuildRequest): Promise<void> {
    await this.rebuildScheduler?.schedule(request);
  }

  /**
   * Late arrivals whose sequence was already summarized invalidate that
   * summary.  The update is fully workspace/tenant/shop scoped after resolving
   * the server-owned conversation, then a coalesced rebuild is requested.
   */
  async markDirtyForLateMessage(scope: WorkspaceScope, conversationId: string, sequence: number): Promise<boolean> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId: scope.workspaceId, tenantId: scope.tenantId },
      select: { id: true, shopId: true },
    });
    if (!conversation) return false;
    const changed = await this.prisma.conversationMemory.updateMany({
      where: {
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        shopId: conversation.shopId,
        conversationId: conversation.id,
        basedOnThroughSequence: { gte: sequence },
      },
      data: { status: 'DIRTY' },
    });
    if (changed.count > 0) {
      await this.scheduleRebuild({
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        shopId: conversation.shopId,
        conversationId: conversation.id,
        reason: 'LATE_MESSAGE',
      });
      return true;
    }
    return false;
  }

  async rebuild(
    scope: WorkspaceScope,
    conversationId: string,
    output: unknown,
    baseline?: ConversationMemoryRebuildBaseline,
  ): Promise<ConversationMemoryRebuildResult> {
    if (!validateStructuredOutput('ConversationSummary', output)) {
      throw new BadRequestException({
        code: 'CONVERSATION_SUMMARY_SCHEMA_INVALID',
        message: 'Conversation summary failed the frozen structured output schema',
      });
    }
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId: scope.workspaceId, tenantId: scope.tenantId },
      include: {
        messages: {
          where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId },
          select: { id: true, sequence: true, status: true },
          orderBy: { sequence: 'asc' },
        },
        memory: { select: { summaryVersion: true, updatedAt: true, status: true } },
      },
    });
    if (!conversation) {
      throw new NotFoundException({
        code: 'CONVERSATION_NOT_FOUND',
        message: 'Conversation not found in this Workspace',
      });
    }
    const memory = buildConversationMemory({
      previousVersion: conversation.memory?.summaryVersion ?? 0,
      messages: conversation.messages,
      output: output as GeneratedConversationSummary,
    });
    const structuredFacts = {
      activeTopic: memory.activeTopic,
      activeProductId: memory.activeProductId,
      activeOrderId: memory.activeOrderId,
      resolvedFacts: memory.resolvedFacts,
      openQuestions: memory.openQuestions,
      deprecatedFacts: memory.deprecatedFacts,
    } as Prisma.InputJsonValue;
    const data = {
      narrative: memory.narrativeSummary,
      structuredFactsJson: structuredFacts,
      summaryVersion: memory.summaryVersion,
      basedOnThroughSequence: memory.basedOnThroughSequence,
      status: memory.status,
    } as const;
    if (baseline) {
      // A model response may arrive after an edit/recall (contextVersion) or
      // a late message (memory updatedAt) invalidated this same summary. Only
      // the exact snapshot observed by the worker is allowed to become CLEAN.
      const persisted = await this.prisma.conversationMemory.updateManyAndReturn({
        where: {
          workspaceId: scope.workspaceId,
          tenantId: scope.tenantId,
          shopId: conversation.shopId,
          conversationId: conversation.id,
          summaryVersion: baseline.summaryVersion,
          updatedAt: baseline.memoryUpdatedAt,
          status: 'DIRTY',
          conversation: { is: { contextVersion: baseline.contextVersion } },
        },
        data,
        select: { id: true, updatedAt: true },
      });
      const persistedMemory = persisted[0];
      if (!persistedMemory) return this.staleRebuildResult(scope, conversationId, baseline);
      return {
        id: persistedMemory.id,
        conversationId: conversation.id,
        ...memory,
        updatedAt: persistedMemory.updatedAt.toISOString(),
        applied: true,
        retry: false,
      };
    }
    const persisted = await this.prisma.conversationMemory.upsert({
      where: { conversationId: conversation.id },
      create: {
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        shopId: conversation.shopId,
        conversationId: conversation.id,
        ...data,
      },
      update: data,
    });
    return {
      id: persisted.id,
      conversationId: conversation.id,
      ...memory,
      updatedAt: persisted.updatedAt.toISOString(),
      applied: true,
      retry: false,
    };
  }

  /**
   * A failed CAS is not an error: it means a newer context won.  Do not let a
   * duplicate worker turn a newer CLEAN row back into DIRTY, but do preserve
   * DIRTY (and request another pass) when the conversation was invalidated.
   */
  private async staleRebuildResult(
    scope: WorkspaceScope,
    conversationId: string,
    baseline: ConversationMemoryRebuildBaseline,
  ): Promise<ConversationMemoryRebuildResult> {
    const current = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId: scope.workspaceId, tenantId: scope.tenantId },
      select: {
        id: true,
        shopId: true,
        contextVersion: true,
        memory: { select: { summaryVersion: true, status: true, updatedAt: true } },
      },
    });
    if (!current?.memory) return { conversationId, applied: false, retry: false };

    if (current.contextVersion !== baseline.contextVersion) {
      // Make the desired durable state explicit even if another worker wrote
      // CLEAN immediately after the edit/recall transaction committed.
      await this.prisma.conversationMemory.updateMany({
        where: {
          workspaceId: scope.workspaceId,
          tenantId: scope.tenantId,
          shopId: current.shopId,
          conversationId: current.id,
          conversation: { is: { contextVersion: { not: baseline.contextVersion } } },
        },
        data: { status: 'DIRTY' },
      });
      return { conversationId, applied: false, retry: true };
    }

    // A late arrival can invalidate the memory without incrementing the
    // conversation version. Its DIRTY status is itself the durable retry bit.
    if (current.memory.status === 'DIRTY') return { conversationId, applied: false, retry: true };

    // Same-context CLEAN means no durable invalidation remains (normally a
    // duplicate worker already won), so scheduling again would only churn.
    return { conversationId, applied: false, retry: false };
  }
}
