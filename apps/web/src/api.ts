/**
 * Backward-compatible browser API facade.
 *
 * Domain modules own implementation details while existing pages keep importing
 * from './api' without changing runtime behavior or public names.
 * deleteCustomerData remains scoped to `/buyers/${encodeURIComponent(normalizedBuyerId)}/customer-data`.
 */
export * from './api/types';
export {
  ApiError,
  DEMO_TOKEN_STORAGE_KEY,
  extractCollection,
  messageText,
} from './api/client';
export {
  ASSIST_DRAFT_TTL_MS,
  classifyImportRows,
  draftRemainingMs,
  isDraftExpired,
  isSyntheticDynamicFactOrderStatus,
  mergeCustomerMemoryMutation,
  normalizeConversation,
  normalizeCustomerMemory,
  normalizeCustomerMemoryMutation,
  normalizeHumanFinalReceipt,
  normalizeReplyDraft,
  normalizeReplyJob,
  normalizeSendOutbox,
  parseKnowledgeCsv,
} from './api/normalizers';
export * from './api/endpoints';
