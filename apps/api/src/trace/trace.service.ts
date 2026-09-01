import { Injectable, NotFoundException } from '@nestjs/common';
import { sanitizeContext } from '@ai-customer-service/core';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';

type TraceScope = WorkspaceScope & { shopId?: string; conversationId?: string; replyJobId?: string };

/** Opt-in structured diagnostics: never retain prompt, CoT, raw messages, or credentials. */
@Injectable()
export class TraceService {
  constructor(private readonly prisma: PrismaService) {}

  async record(scope: TraceScope, traceId: string, stage: string, payload: Record<string, unknown>) {
    // CurrentWorkspace carries hydrated `workspace` / `tenant` objects in
    // addition to the scalar scope. Never spread that request context into a
    // Prisma create input: doing so makes Prisma select the checked relation
    // input and reject the otherwise valid workspaceId / tenantId scalars.
    return this.prisma.traceEvent.create({
      data: {
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        ...(scope.shopId ? { shopId: scope.shopId } : {}),
        ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
        ...(scope.replyJobId ? { replyJobId: scope.replyJobId } : {}),
        traceId,
        stage,
        payloadJson: redactTracePayload(payload) as Prisma.InputJsonValue,
      },
    });
  }

  async replyTrace(scope: WorkspaceScope, replyId: string, enabled: boolean) {
    this.requireEnabled(enabled);
    const reply = await this.prisma.message.findFirst({ where: { id: replyId, ...scope, role: { in: ['ASSISTANT', 'HUMAN'] } }, select: { id: true, conversationId: true, externalMessageId: true } });
    if (!reply) throw new NotFoundException({ code: 'REPLY_NOT_FOUND', message: 'Reply not found in this Workspace' });
    const sendOutboxes = this.prisma as unknown as { sendOutbox?: { findFirst(input: unknown): Promise<{ id: string; replyJobId: string | null } | null> } };
    const outbox = await sendOutboxes.sendOutbox?.findFirst({
      where: { ...scope, conversationId: reply.conversationId, OR: [{ id: reply.externalMessageId }, { receiptJson: { path: ['externalMessageId'], equals: reply.externalMessageId } }] },
      select: { id: true, replyJobId: true },
    });
    const traceIds = [
      `reply:${reply.id}`,
      ...(outbox?.replyJobId ? [`reply-job:${outbox.replyJobId}`] : []),
      ...(outbox?.id ? [`send:${outbox.id}`] : []),
      `conversation:${reply.conversationId}`,
    ];
    return this.toDeveloperTrace(scope, `reply:${reply.id}`, { conversationId: reply.conversationId, traceIds });
  }

  async conversationTrace(scope: WorkspaceScope, conversationId: string, enabled: boolean) {
    this.requireEnabled(enabled);
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, ...scope }, select: { id: true } });
    if (!conversation) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found in this Workspace' });
    return this.toDeveloperTrace(scope, `conversation:${conversation.id}`, { conversationId: conversation.id });
  }

  private async toDeveloperTrace(scope: WorkspaceScope, traceId: string, input: { conversationId?: string; traceIds?: string[] }) {
    const where = { ...scope, ...(input.conversationId ? { conversationId: input.conversationId } : {}), ...(input.traceIds ? { traceId: { in: input.traceIds } } : {}) };
    const rows = await this.prisma.traceEvent.findMany({ where, orderBy: { createdAt: 'asc' } });
    return {
      traceId,
      events: rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        tenantId: row.tenantId,
        shopId: row.shopId,
        conversationId: row.conversationId,
        replyJobId: row.replyJobId,
        traceId: row.traceId,
        stage: row.stage,
        createdAt: row.createdAt.toISOString(),
        payload: redactTracePayload(asRecord(row.payloadJson)),
      })),
    };
  }

  private requireEnabled(enabled: boolean): void {
    if (!enabled) throw new NotFoundException({ code: 'TRACE_DISABLED', message: 'trace=1 is required' });
  }
}

// Keep opaque identifiers such as messageId: they are essential for joining a
// trace and are not message content. Raw/camel-case bodies (rawMessages,
// rawModelOutput), prompts and credentials remain denylisted recursively.
const UNSAFE_TRACE_KEY = /(?:prompt|reasoning|chain[_-]?of[_-]?thought|\bcot\b|(?:^|[_-])messages?(?:$|[_-])|content|authorization|cookie|token|secret|password|raw)/i;

export function redactTracePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeContext({ trace: stripUnsafe(payload) }, ['trace']).value.trace;
  return asRecord(sanitized);
}

function stripUnsafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnsafe);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_TRACE_KEY.test(key)) continue;
    result[key] = stripUnsafe(nested);
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
