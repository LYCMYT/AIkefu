import { Injectable } from '@nestjs/common';

/**
 * Process-local serialization for Mock-Douyin's final hand-off.  It pairs
 * the short durable transport-start transaction with takeover so a single
 * server process has no marker-commit -> adapter race.  Database state still
 * fences restart recovery; multi-process mock deployments need a provider
 * fencing token and are deliberately not represented as strongly safe here.
 */
@Injectable()
export class ConversationTransportMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.tails.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === queued) {
        this.tails.delete(key);
      }
    }
  }

  async runMany<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const acquire = async (index: number): Promise<T> => index >= ordered.length
      ? work()
      : this.run(ordered[index]!, () => acquire(index + 1));
    return acquire(0);
  }
}

/** Directly constructed unit services share the same safe local fallback. */
export const localConversationTransportMutex = new ConversationTransportMutex();

export function transportMutexKey(scope: { workspaceId: string; tenantId: string; shopId: string }, conversationId: string): string {
  return `${scope.workspaceId}:${scope.tenantId}:${scope.shopId}:conversation:${conversationId}`;
}

export function transportShopMutexKey(scope: { workspaceId: string; tenantId: string; shopId: string }): string {
  return `${scope.workspaceId}:${scope.tenantId}:${scope.shopId}:shop`;
}
