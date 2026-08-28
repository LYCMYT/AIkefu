/** Domain endpoints. Keep this module as the only consumer of the shared transport. */

import type {
  BootstrapPayload,
  Buyer,
  BuyerCardInput,
  BuyerMessageInput,
  Conversation,
  ConversationControlResult,
  ConversationMessageInput,
  ConversationMode,
  CustomerDataDeletionResult,
  CustomerMemory,
  CustomerMemoryStatusResult,
  DeveloperTrace,
  HumanFinalReceipt,
  KnowledgeCandidate,
  KnowledgeConflict,
  KnowledgeConflictResolution,
  KnowledgeFilters,
  KnowledgeImportCommitResult,
  KnowledgeImportPreview,
  KnowledgeItem,
  KnowledgeModerationFilters,
  ResolveKnowledgeConflictInput,
  KnowledgeVersionSnapshot,
  MutationResult,
  OperationAccepted,
  Order,
  Product,
  ProductLearningJob,
  ProductLearningInput,
  ProductSyncResult,
  QualityConclusionInput,
  QualityResult,
  QualityReview,
  ReplyIncident,
  Scenario,
  SyntheticDynamicFactAccepted,
  SyntheticDynamicFactInventoryInput,
  SyntheticDynamicFactOrderStatus,
  SyntheticDynamicFactOrderStatusInput,
  Workflow,
  WorkflowGraph,
  WorkflowRun,
  WorkflowRunQuery,
  WorkflowVersion,
  WorkspaceResetResult,
} from '../types';

import type {
  ApproveActionProposalInput,
  ConversationModeCommand,
  CreateReplyIncidentInput,
  CreateWorkflowInput,
  CorrectionInput,
  CustomerMemoryDisableCommand,
  CustomerMemoryInput,
  IncidentSeverity,
  IncidentStatus,
  RejectActionProposalInput,
  ScenarioKey,
  WorkspaceSession,
} from '@ai-customer-service/contracts';

import { ApiError, DEMO_TOKEN_STORAGE_KEY, extractCollection, extractEntity, jsonHeaders, request, workspaceHeaders } from '../client';

import {
  isScenarioKey,
  isSyntheticDynamicFactOrderStatus,
  isWorkflowGraph,
  normalizeAcceptedOperation,
  normalizeCustomerDataDeletionResult,
  normalizeCustomerMemory,
  normalizeCustomerMemoryMutation,
  normalizeConversation,
  normalizeDeveloperTrace,
  normalizeHumanFinalReceipt,
  normalizeImportPreview,
  normalizeKnowledgeCandidate,
  normalizeKnowledgeConflict,
  normalizeKnowledgeItem,
  normalizeProductLearningJob,
  normalizeQualityReview,
  normalizeReplyIncident,
  normalizeScenario,
  normalizeSyntheticDynamicFactAccepted,
  normalizeWorkflow,
  normalizeWorkflowRun,
  normalizeWorkflowVersion,
  qualityResults,
} from '../normalizers';

export function sendBuyerMessage(token: string, input: BuyerMessageInput): Promise<MutationResult> {
  return request<unknown>('/buyer/messages', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ ...input, kind: 'TEXT' }),
  }).then((payload) => extractEntity<MutationResult>(payload, 'message'));
}

export function editBuyerMessage(token: string, messageId: string, text: string): Promise<MutationResult> {
  return request<unknown>(`/buyer/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: jsonHeaders(token),
    body: JSON.stringify({ text }),
  }).then((payload) => extractEntity<MutationResult>(payload, 'message'));
}

export function recallBuyerMessage(token: string, messageId: string): Promise<MutationResult> {
  return request<unknown>(`/buyer/messages/${encodeURIComponent(messageId)}/recall`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({}),
  }).then((payload) => extractEntity<MutationResult>(payload, 'message'));
}

export function sendBuyerProductCard(token: string, input: BuyerCardInput): Promise<MutationResult> {
  const body = JSON.stringify(input);
  return request<unknown>('/buyer/cards/product', {
    method: 'POST',
    headers: jsonHeaders(token),
    body,
  }).catch((error: unknown) => {
    // The first Phase 02 API shipped the equivalent REST route as
    // `/buyer/product-cards`; keep the frozen contract as the primary call
    // while allowing that deployed server to be used during the transition.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return request<unknown>('/buyer/product-cards', {
      method: 'POST',
      headers: jsonHeaders(token),
      body,
    });
  }).then((payload) => extractEntity<MutationResult>(payload, 'message'));
}

export function sendBuyerOrderCard(token: string, input: BuyerCardInput): Promise<MutationResult> {
  const body = JSON.stringify(input);
  return request<unknown>('/buyer/cards/order', {
    method: 'POST',
    headers: jsonHeaders(token),
    body,
  }).catch((error: unknown) => {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return request<unknown>('/buyer/order-cards', {
      method: 'POST',
      headers: jsonHeaders(token),
      body,
    });
  }).then((payload) => extractEntity<MutationResult>(payload, 'message'));
}

export function sendConversationMessage(token: string, conversationId: string, shopId: string, text: string): Promise<HumanFinalReceipt>;
export function sendConversationMessage(token: string, conversationId: string, shopId: string, input: ConversationMessageInput): Promise<HumanFinalReceipt>;
export function sendConversationMessage(
  token: string,
  conversationId: string,
  shopId: string,
  textOrInput: string | ConversationMessageInput,
): Promise<HumanFinalReceipt> {
  const input: ConversationMessageInput = typeof textOrInput === 'string' ? { text: textOrInput } : textOrInput;
  const body = { shopId, ...input };
  return request<unknown>(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  }).then((payload) => normalizeHumanFinalReceipt(extractEntity<unknown>(payload, 'receipt')));
}

export function isWorkspaceCredentialError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 ||
      error.status === 403 ||
      error.code === 'WORKSPACE_TOKEN_REQUIRED' ||
      error.code === 'WORKSPACE_TOKEN_INVALID')
  );
}

export function readStoredWorkspaceToken(): string | null {
  try {
    return window.localStorage.getItem(DEMO_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeWorkspaceToken(token: string): void {
  try {
    window.localStorage.setItem(DEMO_TOKEN_STORAGE_KEY, token);
  } catch {
    // The session remains usable for this page even if browser storage is disabled.
  }
}

export function clearStoredWorkspaceToken(): void {
  try {
    window.localStorage.removeItem(DEMO_TOKEN_STORAGE_KEY);
  } catch {
    // There is no recovery action when browser storage is unavailable.
  }
}
