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

export function getBuyers(token: string, shopId: string): Promise<Buyer[]> {
  const params = new URLSearchParams({ shopId });
  return request<unknown>(`/buyers?${params.toString()}`, { headers: workspaceHeaders(token) }).then((payload) =>
    extractCollection<Buyer>(payload, 'buyers'),
  );
}

export function getConversations(token: string, shopId: string): Promise<Conversation[]> {
  const params = new URLSearchParams({ shopId });
  return request<unknown>(`/conversations?${params.toString()}`, { headers: workspaceHeaders(token) }).then((payload) =>
    extractCollection<unknown>(payload, 'conversations').map(normalizeConversation),
  );
}

export function getConversation(token: string, conversationId: string): Promise<Conversation> {
  return request<unknown>(`/conversations/${encodeURIComponent(conversationId)}`, {
    headers: workspaceHeaders(token),
  }).then((payload) => normalizeConversation(extractEntity<unknown>(payload, 'conversation')));
}

export function setConversationMode(
  token: string,
  conversationId: string,
  shopId: string,
  mode: NonNullable<Conversation['mode']> | ConversationModeCommand,
): Promise<ConversationControlResult> {
  const body: ConversationModeCommand = typeof mode === 'string'
    ? { shopId, mode: mode as ConversationModeCommand['mode'] }
    : { ...mode, shopId };
  return request<unknown>(`/conversations/${encodeURIComponent(conversationId)}/mode`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  }).then((payload) => extractEntity<ConversationControlResult>(payload, 'conversation'));
}

export function takeoverConversation(token: string, conversationId: string, shopId: string): Promise<ConversationControlResult> {
  return request<unknown>(`/conversations/${encodeURIComponent(conversationId)}/takeover`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ shopId }),
  }).then((payload) => extractEntity<ConversationControlResult>(payload, 'conversation'));
}

export function resumeConversationAi(token: string, conversationId: string, shopId: string): Promise<ConversationControlResult> {
  return request<unknown>(`/conversations/${encodeURIComponent(conversationId)}/resume-ai`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ shopId }),
  }).then((payload) => extractEntity<ConversationControlResult>(payload, 'conversation'));
}

export function regenerateReply(token: string, conversationId: string, shopId: string): Promise<OperationAccepted> {
  return request<unknown>(`/conversations/${encodeURIComponent(conversationId)}/reply/regenerate`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ shopId }),
  }).then((payload) => extractEntity<OperationAccepted>(payload, 'operation'));
}

/** Compatibility alias used by callers that name the command after its route. */
export const regenerateConversationReply = regenerateReply;

export function getCustomerMemories(token: string, buyerId: string, shopId: string): Promise<CustomerMemory[]> {
  const suffix = `?${new URLSearchParams({ shopId }).toString()}`;
  return request<unknown>(`/buyers/${encodeURIComponent(buyerId)}/memories${suffix}`, {
    headers: workspaceHeaders(token),
  }).then((payload) => extractCollection<unknown>(payload, 'memories').map(normalizeCustomerMemory));
}

export function createCustomerMemory(token: string, buyerId: string, input: CustomerMemoryInput): Promise<CustomerMemory> {
  return request<unknown>(`/buyers/${encodeURIComponent(buyerId)}/memories`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  }).then((payload) => normalizeCustomerMemory(extractEntity<unknown>(payload, 'memory')));
}

export function updateCustomerMemory(token: string, memoryId: string, input: CustomerMemoryInput): Promise<CustomerMemory> {
  return request<unknown>(`/memories/${encodeURIComponent(memoryId)}`, {
    method: 'PATCH',
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  }).then((payload) => normalizeCustomerMemory(extractEntity<unknown>(payload, 'memory')));
}

export function disableCustomerMemory(
  token: string,
  memoryId: string,
  shopId: string,
  input: Omit<CustomerMemoryDisableCommand, 'shopId'> = {},
): Promise<CustomerMemory | CustomerMemoryStatusResult | OperationAccepted> {
  return request<unknown>(`/memories/${encodeURIComponent(memoryId)}/disable`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ shopId, ...input }),
  }).then(normalizeCustomerMemoryMutation);
}

export function deleteCustomerMemory(token: string, memoryId: string, shopId: string): Promise<void> {
  const suffix = `?${new URLSearchParams({ shopId }).toString()}`;
  return request<unknown>(`/memories/${encodeURIComponent(memoryId)}${suffix}`, {
    method: 'DELETE',
    headers: workspaceHeaders(token),
  }).then(() => undefined);
}

/** Delete/anonymize all customer data in the current Demo Workspace. */
export function deleteCustomerData(token: string, buyerId: string): Promise<CustomerDataDeletionResult> {
  const normalizedBuyerId = buyerId.trim();
  if (!normalizedBuyerId) return Promise.reject(new ApiError('买家 ID 不能为空。', 400, 'BUYER_ID_REQUIRED'));
  return request<unknown>(`/buyers/${encodeURIComponent(normalizedBuyerId)}/customer-data`, {
    method: 'DELETE',
    headers: workspaceHeaders(token),
  }, 200).then((payload) => normalizeCustomerDataDeletionResult(extractEntity<unknown>(payload, 'result')));
}

/** Synthetic/Mock-only inventory mutation used by Scenario Lab. */
export function updateDynamicFactInventory(
  token: string,
  shopId: string,
  productId: string,
  skuId: string,
  inventory: number,
): Promise<SyntheticDynamicFactAccepted> {
  if (!Number.isSafeInteger(inventory) || inventory < 0) {
    return Promise.reject(new ApiError('库存必须为非负整数。', 400, 'SKU_INVENTORY_INVALID'));
  }
  return request<unknown>(`/shops/${encodeURIComponent(shopId)}/dynamic-facts/products/${encodeURIComponent(productId)}/skus/${encodeURIComponent(skuId)}/inventory`, {
    method: 'PATCH',
    headers: jsonHeaders(token),
    body: JSON.stringify({ inventory } satisfies SyntheticDynamicFactInventoryInput),
  }).then(normalizeSyntheticDynamicFactAccepted);
}

/** Synthetic/Mock-only order status mutation used by Scenario Lab. */
export function updateDynamicFactOrderStatus(
  token: string,
  shopId: string,
  orderId: string,
  status: SyntheticDynamicFactOrderStatus,
): Promise<SyntheticDynamicFactAccepted> {
  if (!isSyntheticDynamicFactOrderStatus(status)) {
    return Promise.reject(new ApiError('订单状态不在演示白名单内。', 400, 'ORDER_STATUS_INVALID'));
  }
  return request<unknown>(`/shops/${encodeURIComponent(shopId)}/dynamic-facts/orders/${encodeURIComponent(orderId)}/status`, {
    method: 'PATCH',
    headers: jsonHeaders(token),
    body: JSON.stringify({ status } satisfies SyntheticDynamicFactOrderStatusInput),
  }).then(normalizeSyntheticDynamicFactAccepted);
}

export const changeConversationMode = setConversationMode;
export const takeOverConversation = takeoverConversation;
export const resumeAi = resumeConversationAi;
export const getMemories = getCustomerMemories;
