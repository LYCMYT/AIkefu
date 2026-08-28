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

export function getProducts(token: string, shopId: string): Promise<Product[]> {
  return request<unknown>(`/shops/${encodeURIComponent(shopId)}/products`, {
    headers: workspaceHeaders(token),
  }).then((payload) => extractCollection<Product>(payload, 'products'));
}

export function getOrders(token: string, shopId: string, buyerId?: string): Promise<Order[]> {
  const params = new URLSearchParams();
  if (buyerId) params.set('buyerId', buyerId);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return request<unknown>(`/shops/${encodeURIComponent(shopId)}/orders${suffix}`, {
    headers: workspaceHeaders(token),
  }).then((payload) => extractCollection<Order>(payload, 'orders'));
}

export function getKnowledge(token: string, filters: KnowledgeFilters = {}): Promise<KnowledgeItem[]> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value && value !== 'ALL') params.set(key, value);
  });
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return request<unknown>(`/knowledge${suffix}`, { headers: workspaceHeaders(token) }).then((payload) =>
    extractCollection<unknown>(payload, 'knowledge').map(normalizeKnowledgeItem),
  );
}

function querySuffix(filters: KnowledgeModerationFilters): string {
  const params = new URLSearchParams();
  if (filters.shopId) params.set('shopId', filters.shopId);
  if (filters.status) params.set('status', filters.status);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function getKnowledgeCandidates(token: string, filters: KnowledgeModerationFilters = {}): Promise<KnowledgeCandidate[]> {
  return request<unknown>(`/knowledge/candidates${querySuffix(filters)}`, { headers: workspaceHeaders(token) }).then((payload) =>
    extractCollection<unknown>(payload, 'candidates').map(normalizeKnowledgeCandidate),
  );
}

export function approveKnowledgeCandidate(token: string, candidateId: string, shopId?: string): Promise<OperationAccepted> {
  const suffix = shopId ? `?${new URLSearchParams({ shopId }).toString()}` : '';
  return request<OperationAccepted>(`/knowledge/candidates/${encodeURIComponent(candidateId)}/approve${suffix}`, {
    method: 'POST',
    headers: workspaceHeaders(token),
  });
}

export function rejectKnowledgeCandidate(token: string, candidateId: string, shopId?: string): Promise<void> {
  const suffix = shopId ? `?${new URLSearchParams({ shopId }).toString()}` : '';
  return request<unknown>(`/knowledge/candidates/${encodeURIComponent(candidateId)}/reject${suffix}`, {
    method: 'POST',
    headers: workspaceHeaders(token),
  }).then(() => undefined);
}

export function getKnowledgeConflicts(token: string, filters: KnowledgeModerationFilters = {}): Promise<KnowledgeConflict[]> {
  return request<unknown>(`/knowledge/conflicts${querySuffix(filters)}`, { headers: workspaceHeaders(token) }).then((payload) =>
    extractCollection<unknown>(payload, 'conflicts').map(normalizeKnowledgeConflict),
  );
}

export function resolveKnowledgeConflict(token: string, conflictId: string, input: ResolveKnowledgeConflictInput): Promise<OperationAccepted> {
  const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  return request<OperationAccepted>(`/knowledge/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  });
}

export function previewKnowledgeImport(token: string, file: File, shopId?: string): Promise<KnowledgeImportPreview> {
  const buildForm = () => {
    const form = new FormData();
    if (shopId) form.append('shopId', shopId);
    form.append('file', file, file.name);
    return form;
  };

  // The frozen contract accepts the upload asynchronously. Only fall back to
  // the older preview endpoint when the upload route itself is unavailable;
  // a 404 from the subsequent job snapshot must preserve the accepted job id.
  return request<unknown>('/knowledge/imports', {
    method: 'POST',
    headers: workspaceHeaders(token),
    body: buildForm(),
  }).catch((error: unknown) => {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return request<unknown>('/knowledge/imports/preview', {
      method: 'POST',
      headers: workspaceHeaders(token),
      body: buildForm(),
    });
  }).then(async (payload) => {
    const accepted = extractEntity<Record<string, unknown>>(payload, 'job');
    const jobId = String(accepted?.jobId ?? accepted?.importId ?? accepted?.operationId ?? accepted?.id ?? '');
    if (!jobId) return normalizeImportPreview(payload);
    try {
      return await getKnowledgeImport(token, jobId);
    } catch (error: unknown) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      return {
        id: jobId,
        importId: jobId,
        fileName: file.name,
        rows: [],
        status: String(accepted?.status ?? 'PENDING'),
      };
    }
  });
}

export function getKnowledgeImport(token: string, jobId: string): Promise<KnowledgeImportPreview> {
  return request<unknown>(`/knowledge/imports/${encodeURIComponent(jobId)}`, {
    headers: workspaceHeaders(token),
  }).then((payload) => {
    const preview = normalizeImportPreview(payload);
    return preview.id ? preview : { ...preview, id: jobId, importId: jobId };
  });
}

export function commitKnowledgeImport(token: string, importId: string, shopId?: string): Promise<KnowledgeImportCommitResult> {
  return request<unknown>(`/knowledge/imports/${encodeURIComponent(importId)}/commit`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(shopId ? { shopId } : {}),
  }).then(normalizeImportPreview);
}

export function reindexKnowledge(token: string, knowledgeId: string, shopId?: string): Promise<KnowledgeVersionSnapshot> {
  const suffix = shopId ? `?${new URLSearchParams({ shopId }).toString()}` : '';
  return request<KnowledgeVersionSnapshot>(`/knowledge/${encodeURIComponent(knowledgeId)}/reindex${suffix}`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({}),
  });
}

export function deleteKnowledge(token: string, knowledgeId: string, shopId?: string): Promise<OperationAccepted> {
  const suffix = shopId ? `?${new URLSearchParams({ shopId }).toString()}` : '';
  return request<OperationAccepted>(`/knowledge/${encodeURIComponent(knowledgeId)}${suffix}`, {
    method: 'DELETE',
    headers: workspaceHeaders(token),
  });
}

export function syncProducts(token: string, shopId: string): Promise<ProductSyncResult> {
  return request<ProductSyncResult>(`/shops/${encodeURIComponent(shopId)}/products/sync`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({}),
  });
}

export function startProductLearning(token: string, shopId: string, input: ProductLearningInput = {}): Promise<ProductLearningJob> {
  // Selected products and retries intentionally use the same shop-scoped
  // batch command. This keeps retryFailed semantics and job item accounting
  // consistent with the list/progress snapshot returned by the API.
  return request<unknown>(`/shops/${encodeURIComponent(shopId)}/product-learning-jobs`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  }).then(normalizeProductLearningJob);
}

export function getProductLearningJobs(token: string, shopId: string): Promise<ProductLearningJob[]> {
  const primaryPath = `/shops/${encodeURIComponent(shopId)}/product-learning-jobs`;
  return request<unknown>(primaryPath, { headers: workspaceHeaders(token) }).then((payload) =>
    extractCollection<unknown>(payload, 'jobs').map(normalizeProductLearningJob),
  ).catch((error: unknown) => {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const params = new URLSearchParams({ shopId });
    return request<unknown>(`/product-learning-jobs?${params.toString()}`, { headers: workspaceHeaders(token) }).then((payload) =>
      extractCollection<unknown>(payload, 'jobs').map(normalizeProductLearningJob),
    );
  });
}
