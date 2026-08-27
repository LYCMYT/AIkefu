import { Injectable } from '@nestjs/common';

export type ConversationMemoryRebuildRequest = {
  workspaceId: string;
  tenantId: string;
  shopId: string;
  conversationId: string;
  reason: 'LATE_MESSAGE' | 'MESSAGE_MUTATED';
};

/**
 * Phase 03 boundary only: it records a coalesced rebuild request but never
 * generates a reply or starts a Phase 04 workflow.  A later runtime worker
 * may consume this interface without coupling message ingestion to an LLM.
 */
export interface ConversationMemoryRebuildScheduler {
  schedule(request: ConversationMemoryRebuildRequest): Promise<void>;
  drainPending?(): ConversationMemoryRebuildRequest[];
}

export const CONVERSATION_MEMORY_REBUILD_SCHEDULER = Symbol('CONVERSATION_MEMORY_REBUILD_SCHEDULER');

@Injectable()
export class CoalescingConversationMemoryRebuildScheduler implements ConversationMemoryRebuildScheduler {
  private readonly pending = new Map<string, ConversationMemoryRebuildRequest>();

  async schedule(request: ConversationMemoryRebuildRequest): Promise<void> {
    this.pending.set(`${request.workspaceId}:${request.tenantId}:${request.shopId}:${request.conversationId}`, { ...request });
  }

  /** Explicit hand-off seam for a future scheduler; never runs generation. */
  drainPending(): ConversationMemoryRebuildRequest[] {
    const requests = [...this.pending.values()].map((request) => ({ ...request }));
    this.pending.clear();
    return requests;
  }
}
