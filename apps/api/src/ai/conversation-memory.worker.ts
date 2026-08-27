import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { sanitizeContext, type GeneratedConversationSummary } from '@ai-customer-service/core';
import { PrismaService } from '../database/prisma.service';
import { AiRuntimeApplicationService } from './ai-runtime-application.service';
import { ConversationMemoryService } from './conversation-memory.service';
import {
  CONVERSATION_MEMORY_REBUILD_SCHEDULER,
  type ConversationMemoryRebuildRequest,
  type ConversationMemoryRebuildScheduler,
} from './conversation-memory.scheduler';

/**
 * Coalesced Phase 03 summary worker. It has one narrow responsibility:
 * regenerate an already-dirty ConversationMemory. It neither sends a reply
 * nor creates a ReplyJob/Workflow.
 */
@Injectable()
export class ConversationMemoryRebuildWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;

  constructor(
    @Inject(CONVERSATION_MEMORY_REBUILD_SCHEDULER)
    private readonly scheduler: ConversationMemoryRebuildScheduler,
    private readonly prisma: PrismaService,
    private readonly runtime: AiRuntimeApplicationService,
    private readonly memories: ConversationMemoryService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const configured = Number(process.env.CONVERSATION_MEMORY_DRAIN_INTERVAL_MS);
    const intervalMs = Number.isSafeInteger(configured) && configured > 0 ? configured : 1_000;
    this.timer = setInterval(() => void this.drainOnce().catch(() => undefined), intervalMs);
    this.timer.unref?.();
    // Do not wait for the first interval after a process restart: durable
    // DIRTY rows are safe to enqueue immediately and are still coalesced.
    void this.drainOnce().catch(() => undefined);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async drainOnce(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let rebuilt = 0;
    try {
      // The scheduler is deliberately in-memory, so a process restart loses
      // its pending map. DIRTY is the durable signal: scan it before every
      // drain and feed those rows back through the same coalescing boundary.
      const dirtyMemories = await this.prisma.conversationMemory.findMany({
        where: { status: 'DIRTY' },
        select: { workspaceId: true, tenantId: true, shopId: true, conversationId: true },
        take: 100,
      });
      for (const memory of dirtyMemories) {
        await this.scheduler.schedule({
          workspaceId: memory.workspaceId,
          tenantId: memory.tenantId,
          shopId: memory.shopId,
          conversationId: memory.conversationId,
          reason: 'MESSAGE_MUTATED',
        });
      }
      for (const request of this.scheduler.drainPending?.() ?? []) {
        try {
          if (await this.rebuild(request)) rebuilt += 1;
        } catch {
          // Keep failure recovery at the same coalescing boundary. No provider
          // message or raw conversation context is persisted here.
          await this.scheduler.schedule(request);
        }
      }
      return rebuilt;
    } finally {
      this.draining = false;
    }
  }

  private async rebuild(request: ConversationMemoryRebuildRequest): Promise<boolean> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: request.conversationId,
        workspaceId: request.workspaceId,
        tenantId: request.tenantId,
        shopId: request.shopId,
      },
      include: {
        messages: {
          where: { workspaceId: request.workspaceId, tenantId: request.tenantId, shopId: request.shopId },
          orderBy: { sequence: 'asc' },
          select: { id: true, sequence: true, kind: true, contentJson: true, status: true },
        },
        memory: { select: { summaryVersion: true, updatedAt: true } },
      },
    });
    // A scheduled rebuild is only meaningful for a durable DIRTY memory.
    // If it was deleted before this worker acquired the snapshot, there is
    // nothing stale left to make clean.
    if (!conversation?.memory) return false;
    const baseline = {
      contextVersion: conversation.contextVersion,
      summaryVersion: conversation.memory.summaryVersion,
      memoryUpdatedAt: conversation.memory.updatedAt,
    };
    const result = await this.runtime.runStructured<GeneratedConversationSummary>(
      {
        workspaceId: request.workspaceId,
        tenantId: request.tenantId,
        shopId: request.shopId,
        conversationId: request.conversationId,
      },
      {
        purpose: 'SUMMARY',
        schema: 'ConversationSummary',
        context: {
          messages: conversation.messages
            .filter((message) => message.status !== 'RECALLED')
            .map((message) => ({
              id: message.id,
              sequence: message.sequence,
              kind: message.kind,
              // The runtime sanitizer redacts PII and removes secret-shaped
              // nested keys before the offline/provider boundary.
              content: message.contentJson,
            })),
        },
        allowedDataClasses: ['messages'],
        promptVersion: 'conversation-summary-v1',
        evidence: [],
        ragStrategy: 'NONE',
        contextVersion: baseline.contextVersion,
      },
    );
    // Provider output is untrusted too: redact PII recursively before the
    // summary schema and dynamic-fact policy are enforced by the service.
    const sanitized = sanitizeContext({ summary: result.output }, ['summary']).value.summary;
    const persisted = await this.memories.rebuild(
      { workspaceId: request.workspaceId, tenantId: request.tenantId },
      request.conversationId,
      sanitized,
      baseline,
    );
    if (!persisted.applied && persisted.retry) {
      // The service observed a newer dirty context while applying its CAS.
      // Feed the same request back through the coalescing boundary so the
      // next pass captures a fresh, post-mutation snapshot.
      await this.scheduler.schedule(request);
    }
    return persisted.applied;
  }
}
