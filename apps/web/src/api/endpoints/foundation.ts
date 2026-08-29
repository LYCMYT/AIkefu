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
  CreateWorkspaceInput,
  ResetWorkspaceInput,
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

export async function createWorkspace(input?: CreateWorkspaceInput): Promise<WorkspaceSession> {
  const session = await request<WorkspaceSession>('/demo/workspaces', {
    method: 'POST',
    headers: input ? { 'Content-Type': 'application/json' } : undefined,
    body: input ? JSON.stringify(input) : undefined,
  });

  if (!session.token) {
    throw new ApiError('API 没有返回可用的 Workspace 凭据。', 500, 'WORKSPACE_TOKEN_MISSING');
  }

  return session;
}

export function getBootstrap(token: string): Promise<BootstrapPayload> {
  return request<BootstrapPayload>('/bootstrap', {
    headers: workspaceHeaders(token),
  });
}

export function resetCurrentWorkspace(token: string, input?: ResetWorkspaceInput): Promise<WorkspaceResetResult> {
  return request<WorkspaceResetResult>('/demo/workspaces/current/reset', {
    method: 'POST',
    headers: input ? jsonHeaders(token) : workspaceHeaders(token),
    body: input ? JSON.stringify(input) : undefined,
  });
}
