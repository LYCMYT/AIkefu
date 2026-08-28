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

export function getQualityReviews(token: string, conversationId?: string): Promise<QualityReview[]> {
  const suffix = conversationId ? `?${new URLSearchParams({ conversationId }).toString()}` : '';
  return request<unknown>(`/quality/reviews${suffix}`, { headers: workspaceHeaders(token) }).then((payload) =>
    extractCollection<unknown>(payload, 'reviews').map(normalizeQualityReview),
  );
}

export function getQualityReview(token: string, reviewId: string): Promise<QualityReview> {
  return request<unknown>(`/quality/reviews/${encodeURIComponent(reviewId)}`, {
    headers: workspaceHeaders(token),
  }).then((payload) => normalizeQualityReview(extractEntity<unknown>(payload, 'review')));
}

export function startQualityReview(token: string, conversationId: string): Promise<OperationAccepted> {
  return request<unknown>('/quality/reviews', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ conversationId }),
  }, 202).then(normalizeAcceptedOperation);
}

export function concludeQualityReview(
  token: string,
  reviewId: string,
  input: QualityResult | QualityConclusionInput,
): Promise<OperationAccepted> {
  const result = typeof input === 'string' ? input : input.result;
  if (!qualityResults.has(result)) return Promise.reject(new ApiError('Quality 人工结论不符合契约。', 400, 'QUALITY_RESULT_INVALID'));
  return request<unknown>(`/quality/reviews/${encodeURIComponent(reviewId)}/conclusion`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ result }),
  }, 202).then(normalizeAcceptedOperation);
}

export function getIncidents(token: string, filters: { status?: IncidentStatus; severity?: IncidentSeverity } = {}): Promise<ReplyIncident[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return request<unknown>(`/incidents${suffix}`, { headers: workspaceHeaders(token) }).then((payload) =>
    extractCollection<unknown>(payload, 'incidents').map(normalizeReplyIncident),
  );
}

export function createReplyIncident(token: string, replyId: string, input: CreateReplyIncidentInput): Promise<ReplyIncident> {
  return request<unknown>(`/replies/${encodeURIComponent(replyId)}/incidents`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  }, 201).then((payload) => normalizeReplyIncident(extractEntity<unknown>(payload, 'incident')));
}

export function saveIncidentCorrection(token: string, incidentId: string, input: CorrectionInput): Promise<OperationAccepted> {
  return request<unknown>(`/incidents/${encodeURIComponent(incidentId)}/correction`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  }, 202).then(normalizeAcceptedOperation);
}

export function saveIncidentRootCause(token: string, incidentId: string, rootCause: string): Promise<OperationAccepted> {
  const value = rootCause.trim();
  if (!value) return Promise.reject(new ApiError('根因说明不能为空。', 400, 'ROOT_CAUSE_REQUIRED'));
  return request<unknown>(`/incidents/${encodeURIComponent(incidentId)}/root-cause`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ rootCause: value }),
  }, 202).then(normalizeAcceptedOperation);
}

export function addIncidentRegression(token: string, incidentId: string, caseId?: string): Promise<OperationAccepted> {
  return request<unknown>(`/incidents/${encodeURIComponent(incidentId)}/add-regression`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(caseId ? { caseId } : {}),
  }, 202).then(normalizeAcceptedOperation);
}

export function resolveIncident(token: string, incidentId: string): Promise<OperationAccepted> {
  return request<unknown>(`/incidents/${encodeURIComponent(incidentId)}/resolve`, {
    method: 'POST',
    headers: workspaceHeaders(token),
  }, 202).then(normalizeAcceptedOperation);
}

export function getDeveloperTrace(token: string, replyId: string): Promise<DeveloperTrace> {
  return request<unknown>(`/replies/${encodeURIComponent(replyId)}/trace?trace=1`, {
    headers: workspaceHeaders(token),
  }).then((payload) => normalizeDeveloperTrace(extractEntity<unknown>(payload, 'trace')));
}

export function getConversationTrace(token: string, conversationId: string): Promise<DeveloperTrace> {
  return request<unknown>(`/conversations/${encodeURIComponent(conversationId)}/trace?trace=1`, {
    headers: workspaceHeaders(token),
  }).then((payload) => normalizeDeveloperTrace(extractEntity<unknown>(payload, 'trace')));
}

export function getUsageSummary(token: string): Promise<import('@ai-customer-service/contracts').UsageSummary> {
  return request<import('@ai-customer-service/contracts').UsageSummary>('/usage', {
    headers: workspaceHeaders(token),
  });
}

export function getScenarios(token: string): Promise<Scenario[]> {
  return request<unknown>('/scenarios', { headers: workspaceHeaders(token) }).then((payload) =>
    extractCollection<unknown>(payload, 'scenarios').map(normalizeScenario),
  );
}

export function runScenario(token: string, scenarioKey: ScenarioKey): Promise<OperationAccepted> {
  if (!isScenarioKey(scenarioKey)) {
    return Promise.reject(new ApiError('Scenario 不在 V1 固定白名单内。', 400, 'SCENARIO_KEY_INVALID'));
  }
  return request<unknown>(`/scenarios/${encodeURIComponent(scenarioKey)}/run`, {
    method: 'POST',
    headers: workspaceHeaders(token),
  }, 202).then(normalizeAcceptedOperation);
}

export function resetScenario(token: string, scenarioKey: ScenarioKey): Promise<OperationAccepted> {
  if (!isScenarioKey(scenarioKey)) {
    return Promise.reject(new ApiError('Scenario 不在 V1 固定白名单内。', 400, 'SCENARIO_KEY_INVALID'));
  }
  return request<unknown>(`/scenarios/${encodeURIComponent(scenarioKey)}/reset`, {
    method: 'POST',
    headers: workspaceHeaders(token),
  }, 202).then(normalizeAcceptedOperation);
}
