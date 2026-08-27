import type { IsoDateTime } from './workspace';

/** Counts returned after the workspace-scoped customer-data deletion command. */
export interface CustomerDataDeletionCounts {
  conversations: number;
  messages: number;
  attachments: number;
  customerMemories: number;
  knowledgeCandidates: number;
}

/** Identifiers that remain only as irreversible, non-personal aggregates. */
export interface CustomerDataAnonymizedCounts {
  buyers: number;
  orders: number;
}

/** Records intentionally retained after deletion because they cannot identify a buyer. */
export interface CustomerDataPreservedCounts {
  anonymousAggregates: number;
  auditFacts: number;
}

export type CustomerDataDeletionStatus = 'COMPLETED';

/**
 * Durable result for `DELETE /api/buyers/{buyerId}/customer-data`.
 * The buyerId is an opaque request reference; the response must not include
 * the buyer's former display name, external id, avatar, tags, or chat content.
 */
export interface CustomerDataDeletionResult {
  buyerId: string;
  status: CustomerDataDeletionStatus;
  deleted: CustomerDataDeletionCounts;
  anonymized: CustomerDataAnonymizedCounts;
  preserved: CustomerDataPreservedCounts;
  completedAt: IsoDateTime;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCountMap(value: unknown, keys: readonly string[]): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return keys.every((key) => isNonNegativeInteger(record[key]));
}

/** Runtime boundary guard used by the Web client before rendering deletion results. */
export function isCustomerDataDeletionResult(value: unknown): value is CustomerDataDeletionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.buyerId === 'string'
    && record.buyerId.length > 0
    && record.status === 'COMPLETED'
    && typeof record.completedAt === 'string'
    && record.completedAt.length > 0
    && isCountMap(record.deleted, ['conversations', 'messages', 'attachments', 'customerMemories', 'knowledgeCandidates'])
    && isCountMap(record.anonymized, ['buyers', 'orders'])
    && isCountMap(record.preserved, ['anonymousAggregates', 'auditFacts']);
}
