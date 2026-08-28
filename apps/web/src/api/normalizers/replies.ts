/** Response normalizers and client-side validation for the frozen demo contracts. */

import type {
  ActionProposal,
  Conversation,
  CustomerDataDeletionResult,
  CustomerMemory,
  CustomerMemoryStatusResult,
  DeveloperTrace,
  ExistingKnowledgeMatch,
  HumanFinalReceipt,
  KnowledgeBusinessStatus,
  KnowledgeCandidate,
  KnowledgeCandidateStatus,
  KnowledgeConflict,
  KnowledgeConflictSideSnapshot,
  KnowledgeImportPreview,
  KnowledgeImportRow,
  KnowledgeImportRowInput,
  KnowledgeImportRowStatus,
  KnowledgeIndexStatus,
  KnowledgeItem,
  KnowledgeScope,
  KnowledgeSourceType,
  KnowledgeVersionSnapshot,
  NodeRun,
  OperationAccepted,
  ProductLearningJob,
  ProductLearningJobStatus,
  ProductLearningJobItem,
  ProductLearningStatus,
  QualityResult,
  QualityReview,
  ReplyDraft,
  ReplyIncident,
  ReplyJob,
  Scenario,
  SendOutbox,
  SyntheticDynamicFactAccepted,
  SyntheticDynamicFactOrderStatus,
  TraceEvent,
  Workflow,
  WorkflowGraph,
  WorkflowRun,
  WorkflowVersion,
} from '../types';

import type {
  ActionProposal as ActionProposalContract,
  IncidentSeverity,
  IncidentStatus,
  Message as MessageContract,
  OperationAccepted as OperationAcceptedContract,
  QualityReview as QualityReviewContract,
  ScenarioKey,
  TraceEvent as TraceEventContract,
  WorkflowGraph as WorkflowGraphContract,
} from '@ai-customer-service/contracts';

import { ApiError, extractEntity, readTextValue, stringValue } from '../client';

import {
  ASSIST_DRAFT_TTL_MS, actionProposalStatuses, actionProposalTypes, actionRiskLevels, hasOwn,
  isActionProposal, isOperationAccepted, isQualityReview, isScenarioKey, isTraceEvent, isWorkflowGraph,
  nullableStringValue, numberValue, objectRecord, qualityResults, scenarioKeys, workflowNodeRunStatuses,
  workflowRunStatuses,
} from './shared';

export function normalizeReplyDraft(value: unknown): ReplyDraft | null {
  const record = objectRecord(value);
  if (!record) return null;
  const editType = nullableStringValue(record.editType);
  return {
    id: String(record.id ?? record.draftId ?? ''),
    replyJobId: String(record.replyJobId ?? record.jobId ?? ''),
    aiDraft: String(record.aiDraft ?? record.draft ?? record.text ?? ''),
    humanFinal: nullableStringValue(record.humanFinal ?? record.finalText),
    editType: editType as ReplyDraft['editType'],
    status: String(record.status ?? 'GENERATING') as ReplyDraft['status'],
    sourceContextVersion: numberValue(record.sourceContextVersion)
      ?? numberValue(record.expectedContextVersion)
      ?? numberValue(record.contextVersion)
      ?? 0,
    sourceLastMessageId: nullableStringValue(record.sourceLastMessageId ?? record.expectedLastMessageId),
    sourceSequence: numberValue(record.sourceSequence) ?? numberValue(record.expectedSequence) ?? null,
    generatedAt: nullableStringValue(record.generatedAt ?? record.createdAt) ?? undefined,
    expiresAt: nullableStringValue(record.expiresAt ?? record.draftExpiresAt),
    staleReason: nullableStringValue(record.staleReason ?? record.reason),
    updatedAt: nullableStringValue(record.updatedAt) ?? undefined,
  };
}

/** Normalize a ReplyJob projection, including either `draft` or `currentDraft`. */
export function normalizeReplyJob(value: unknown): ReplyJob | null {
  const record = objectRecord(value);
  if (!record) return null;
  const hasDraft = hasOwn(record, 'draft') || hasOwn(record, 'currentDraft');
  const draft = normalizeReplyDraft(record.draft ?? record.currentDraft);
  const normalized: ReplyJob = {
    id: String(record.id ?? record.replyJobId ?? ''),
    workspaceId: nullableStringValue(record.workspaceId) ?? undefined,
    tenantId: nullableStringValue(record.tenantId) ?? undefined,
    shopId: nullableStringValue(record.shopId) ?? undefined,
    conversationId: String(record.conversationId ?? ''),
    userTurnId: nullableStringValue(record.userTurnId),
    status: String(record.status ?? 'PENDING') as ReplyJob['status'],
    mode: String(record.mode ?? 'ASSIST') as ReplyJob['mode'],
    sourceLastMessageId: nullableStringValue(record.sourceLastMessageId ?? record.expectedLastMessageId),
    sourceSequence: numberValue(record.sourceSequence) ?? numberValue(record.expectedSequence) ?? null,
    sourceContextVersion: numberValue(record.sourceContextVersion) ?? numberValue(record.expectedContextVersion) ?? null,
    needsReplanReason: nullableStringValue(record.needsReplanReason),
    staleReason: nullableStringValue(record.staleReason ?? record.reason),
    abortReason: nullableStringValue(record.abortReason),
    expiresAt: nullableStringValue(record.expiresAt ?? record.draftExpiresAt),
    provider: nullableStringValue(record.provider),
    model: nullableStringValue(record.model),
    promptVersion: nullableStringValue(record.promptVersion),
    ragStrategy: nullableStringValue(record.ragStrategy),
    tokenUsage: objectRecord(record.tokenUsage)
      ? {
          inputTokens: numberValue(objectRecord(record.tokenUsage)?.inputTokens) ?? 0,
          outputTokens: numberValue(objectRecord(record.tokenUsage)?.outputTokens) ?? 0,
        }
      : null,
    fallbackUsed: record.fallbackUsed === true,
    ...(hasDraft ? { draft, currentDraft: draft } : {}),
    ...(hasOwn(record, 'sendOutbox') ? { sendOutbox: normalizeSendOutbox(record.sendOutbox) } : {}),
    createdAt: nullableStringValue(record.createdAt) ?? undefined,
    updatedAt: nullableStringValue(record.updatedAt) ?? undefined,
  };
  return normalized;
}

export function normalizeSendOutbox(value: unknown): SendOutbox | null {
  const record = objectRecord(value);
  if (!record) return null;
  const receipt = objectRecord(record.receipt);
  return {
    id: String(record.id ?? record.sendOutboxId ?? ''),
    workspaceId: nullableStringValue(record.workspaceId) ?? undefined,
    tenantId: nullableStringValue(record.tenantId) ?? undefined,
    shopId: nullableStringValue(record.shopId) ?? undefined,
    conversationId: nullableStringValue(record.conversationId) ?? undefined,
    replyJobId: nullableStringValue(record.replyJobId),
    idempotencyKey: String(record.idempotencyKey ?? ''),
    payload: objectRecord(record.payload),
    expectedLastMessageId: nullableStringValue(record.expectedLastMessageId),
    expectedSequence: numberValue(record.expectedSequence) ?? null,
    expectedContextVersion: numberValue(record.expectedContextVersion) ?? null,
    status: String(record.status ?? 'PENDING') as SendOutbox['status'],
    receipt: receipt
      ? {
          id: nullableStringValue(receipt.id) ?? undefined,
          externalMessageId: nullableStringValue(receipt.externalMessageId) ?? undefined,
          platformMessageId: nullableStringValue(receipt.platformMessageId) ?? undefined,
          sentAt: nullableStringValue(receipt.sentAt) ?? undefined,
          acceptedAt: nullableStringValue(receipt.acceptedAt) ?? undefined,
          raw: objectRecord(receipt.raw),
        }
      : null,
    failureCode: nullableStringValue(record.failureCode),
    failureReason: nullableStringValue(record.failureReason ?? record.reason),
    createdAt: nullableStringValue(record.createdAt) ?? undefined,
    updatedAt: nullableStringValue(record.updatedAt) ?? undefined,
  };
}

export function normalizeCustomerMemory(value: unknown): CustomerMemory {
  const record = objectRecord(value) ?? {};
  const rawValue = objectRecord(record.value ?? record.valueJson);
  return {
    id: String(record.id ?? ''),
    workspaceId: nullableStringValue(record.workspaceId) ?? undefined,
    tenantId: nullableStringValue(record.tenantId) ?? undefined,
    buyerId: String(record.buyerId ?? ''),
    shopId: String(record.shopId ?? ''),
    type: String(record.type ?? 'PREFERENCE') as CustomerMemory['type'],
    key: String(record.key ?? ''),
    value: rawValue ?? {},
    status: String(record.status ?? 'ACTIVE') as CustomerMemory['status'],
    expiresAt: nullableStringValue(record.expiresAt) ?? undefined,
    createdBy: nullableStringValue(record.createdBy) ?? undefined,
    updatedBy: nullableStringValue(record.updatedBy) ?? undefined,
    createdAt: nullableStringValue(record.createdAt) ?? undefined,
    updatedAt: nullableStringValue(record.updatedAt) ?? undefined,
  };
}

/** A disable endpoint may intentionally return only the durable id/status pair. */
export function normalizeCustomerMemoryMutation(value: unknown): CustomerMemory | CustomerMemoryStatusResult | OperationAccepted {
  const entity = extractEntity<unknown>(value, 'memory');
  const record = objectRecord(entity);
  if (record?.id && (record.buyerId || record.shopId || record.key || record.value || record.valueJson)) {
    return normalizeCustomerMemory(record);
  }
  if (typeof record?.id === 'string' && (record.status === 'ACTIVE' || record.status === 'DISABLED' || record.status === 'DELETED')) {
    return { id: record.id, status: record.status };
  }
  const operation = extractEntity<unknown>(value, 'operation');
  if (isOperationAccepted(operation)) return operation;
  throw new ApiError('CustomerMemory 变更未返回有效回执。', 502, 'MEMORY_MUTATION_RECEIPT_INVALID');
}

/** Merge a partial state mutation with the loaded memory so the UI never renders an empty card. */
export function mergeCustomerMemoryMutation(current: CustomerMemory, mutation: CustomerMemory | CustomerMemoryStatusResult | OperationAccepted): CustomerMemory {
  if ('id' in mutation && mutation.id === current.id && 'status' in mutation) {
    return { ...current, ...(mutation as Partial<CustomerMemory>) };
  }
  return current;
}

/** Normalize the 202 command response; visibility is established by a later snapshot/event. */
export function normalizeHumanFinalReceipt(value: unknown): HumanFinalReceipt {
  const record = objectRecord(value) ?? {};
  const status = record.status === 'QUEUED' ? 'QUEUED' : 'ACCEPTED';
  return {
    sendOutboxId: String(record.sendOutboxId ?? record.outboxId ?? ''),
    ...(nullableStringValue(record.candidateId) ? { candidateId: nullableStringValue(record.candidateId)! } : {}),
    status,
  };
}

/** Return remaining ASSIST Draft lifetime; terminal/stale drafts always return 0. */
export function draftRemainingMs(draft: Pick<ReplyDraft, 'status' | 'expiresAt' | 'generatedAt'>, now = Date.now()): number {
  if (draft.status !== 'GENERATING' && draft.status !== 'WAITING_HUMAN') return 0;
  const expiresAt = draft.expiresAt
    ? new Date(draft.expiresAt).getTime()
    : draft.generatedAt
      ? new Date(draft.generatedAt).getTime() + ASSIST_DRAFT_TTL_MS
      : Number.NaN;
  if (!Number.isFinite(expiresAt)) return 0;
  return Math.max(0, expiresAt - now);
}

export function isDraftExpired(draft: Pick<ReplyDraft, 'status' | 'expiresAt' | 'generatedAt'>, now = Date.now()): boolean {
  return draft.status === 'EXPIRED' || draftRemainingMs(draft, now) === 0;
}

export function normalizeConversation(value: unknown): Conversation {
  const record = objectRecord(value) ?? {};
  const hasDraft = hasOwn(record, 'currentDraft') || hasOwn(record, 'draft');
  const hasReplyJob = hasOwn(record, 'activeReplyJob') || hasOwn(record, 'replyJob');
  const hasSendOutbox = hasOwn(record, 'sendOutbox');
  const rawJob = record.activeReplyJob ?? record.replyJob;
  const activeReplyJob = normalizeReplyJob(rawJob);
  const currentDraft = normalizeReplyDraft(record.currentDraft ?? record.draft ?? activeReplyJob?.currentDraft);
  const rawMemories = Array.isArray(record.customerMemories) ? record.customerMemories : undefined;
  return {
    ...(value as Conversation),
    ...(hasReplyJob ? { activeReplyJob } : {}),
    ...(hasDraft || activeReplyJob?.currentDraft ? { currentDraft } : {}),
    ...(hasSendOutbox ? { sendOutbox: normalizeSendOutbox(record.sendOutbox) } : {}),
    ...(rawMemories ? { customerMemories: rawMemories.map(normalizeCustomerMemory) } : {}),
  };
}
