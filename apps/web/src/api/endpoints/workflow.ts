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

export function getWorkflows(token: string): Promise<Workflow[]> {
  return request<unknown>('/workflows', { headers: workspaceHeaders(token) }).then((payload) =>
    extractCollection<unknown>(payload, 'workflows').map(normalizeWorkflow),
  );
}

export function getWorkflow(token: string, workflowId: string): Promise<Workflow> {
  return request<unknown>(`/workflows/${encodeURIComponent(workflowId)}`, {
    headers: workspaceHeaders(token),
  }).then((payload) => normalizeWorkflow(extractEntity<unknown>(payload, 'workflow')));
}

export function createWorkflow(token: string, input: CreateWorkflowInput): Promise<Workflow> {
  return request<unknown>('/workflows', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  }, 201).then((payload) => normalizeWorkflow(extractEntity<unknown>(payload, 'workflow')));
}

export function saveWorkflowDraft(token: string, workflowId: string, graph: WorkflowGraph): Promise<Workflow> {
  if (!isWorkflowGraph(graph)) {
    return Promise.reject(new ApiError('Workflow Graph 不符合 V1 节点与 settings 契约。', 400, 'WORKFLOW_GRAPH_INVALID'));
  }
  return request<unknown>(`/workflows/${encodeURIComponent(workflowId)}/draft`, {
    method: 'PUT',
    headers: jsonHeaders(token),
    body: JSON.stringify(graph),
  }).then((payload) => normalizeWorkflow(extractEntity<unknown>(payload, 'workflow')));
}

export function publishWorkflow(token: string, workflowId: string): Promise<WorkflowVersion> {
  return request<unknown>(`/workflows/${encodeURIComponent(workflowId)}/publish`, {
    method: 'POST',
    headers: workspaceHeaders(token),
  }, 201).then((payload) => normalizeWorkflowVersion(extractEntity<unknown>(payload, 'version')));
}

export function enableWorkflow(token: string, workflowId: string): Promise<OperationAccepted> {
  return request<unknown>(`/workflows/${encodeURIComponent(workflowId)}/enable`, {
    method: 'POST',
    headers: workspaceHeaders(token),
  }, 202).then(normalizeAcceptedOperation);
}

export function disableWorkflow(token: string, workflowId: string): Promise<OperationAccepted> {
  return request<unknown>(`/workflows/${encodeURIComponent(workflowId)}/disable`, {
    method: 'POST',
    headers: workspaceHeaders(token),
  }, 202).then(normalizeAcceptedOperation);
}

export function testWorkflow(token: string, workflowId: string, input: { conversationId: string }): Promise<OperationAccepted> {
  return request<unknown>(`/workflows/${encodeURIComponent(workflowId)}/test-run`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  }, 202).then(normalizeAcceptedOperation);
}

export function getWorkflowRuns(token: string, filters: WorkflowRunQuery = {}): Promise<WorkflowRun[]> {
  const params = new URLSearchParams();
  if (filters.workflowId) params.set('workflowId', filters.workflowId);
  if (filters.conversationId) params.set('conversationId', filters.conversationId);
  if (filters.status) params.set('status', filters.status);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return request<unknown>(`/workflow-runs${suffix}`, { headers: workspaceHeaders(token) }).then((payload) =>
    extractCollection<unknown>(payload, 'runs').map(normalizeWorkflowRun),
  );
}

export function getWorkflowRun(token: string, runId: string): Promise<WorkflowRun> {
  return request<unknown>(`/workflow-runs/${encodeURIComponent(runId)}`, {
    headers: workspaceHeaders(token),
  }).then((payload) => normalizeWorkflowRun(extractEntity<unknown>(payload, 'run')));
}

export function approveActionProposal(
  token: string,
  proposalId: string,
  input: ApproveActionProposalInput = {},
): Promise<OperationAccepted> {
  return request<unknown>(`/action-proposals/${encodeURIComponent(proposalId)}/approve`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  }, 202).then(normalizeAcceptedOperation);
}

export function rejectActionProposal(
  token: string,
  proposalId: string,
  input: RejectActionProposalInput = {},
): Promise<OperationAccepted> {
  return request<unknown>(`/action-proposals/${encodeURIComponent(proposalId)}/reject`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  }, 202).then(normalizeAcceptedOperation);
}
