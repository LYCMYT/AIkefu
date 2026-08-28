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

/* Runtime guards stay local to the browser bundle; the shared package remains
 * the source of the DTO types while its CommonJS declarations are type-only
 * for this Vite entrypoint. Keep these allowlists in lockstep with contracts. */
export const workflowNodeTypes = new Set(['TRIGGER', 'CONDITION', 'QUERY_PRODUCT', 'QUERY_ORDER', 'QUERY_LOGISTICS', 'AI_GENERATE', 'HUMAN_APPROVAL', 'END']);
export const workflowBranchConditions = new Set(['true', 'false']);
export const workflowRunStatuses = new Set(['PENDING', 'RUNNING', 'WAITING_APPROVAL', 'RECOVERING', 'COMPLETED', 'FAILED', 'STALE', 'CANCELLED']);
export const workflowNodeRunStatuses = new Set(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'WAITING_APPROVAL', 'STALE', 'SKIPPED']);
export const actionProposalTypes = new Set(['MARK_READ', 'CREATE_INTERNAL_TASK', 'TRANSFER_HUMAN', 'ADD_ORDER_REMARK', 'PROPOSE_COMPENSATION', 'REFUND', 'EXCHANGE']);
export const actionRiskLevels = new Set(['READ', 'LOW_WRITE', 'MEDIUM_WRITE', 'HIGH_RISK']);
export const actionProposalStatuses = new Set(['PROPOSED', 'POLICY_CHECKED', 'WAITING_APPROVAL', 'APPROVED', 'REVALIDATING', 'EXECUTING', 'SUCCEEDED', 'REJECTED', 'STALE', 'FAILED', 'UNCERTAIN', 'CANCELLED']);
const qualityReviewStatuses = new Set(['PENDING', 'RUNNING', 'AUTO_REVIEWED', 'PASS', 'FAIL', 'NEEDS_HUMAN']);
export const qualityResults = new Set(['PASS', 'FAIL', 'NEEDS_HUMAN']);
export const scenarioKeys = new Set(['continuous_messages', 'message_during_generation', 'two_buyers', 'two_shops', 'duplicate_and_reorder', 'ai_timeout_fallback', 'service_restart_recovery', 'realtime_state_change']);

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isOperationAccepted(value: unknown): value is OperationAcceptedContract {
  return isRecord(value) && typeof value.operationId === 'string' && value.operationId.length > 0 && (value.status === 'ACCEPTED' || value.status === 'QUEUED');
}

export function isWorkflowGraph(value: unknown): value is WorkflowGraphContract {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !isRecord(value.settings)) return false;
  if (!Number.isSafeInteger(value.settings.maxSteps) || value.settings.maxSteps < 1 || value.settings.maxSteps > 20) return false;
  if (!Number.isSafeInteger(value.settings.timeoutMs) || value.settings.timeoutMs < 1 || value.settings.timeoutMs > 30_000) return false;
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || !node.id || nodeIds.has(node.id) || typeof node.type !== 'string' || !workflowNodeTypes.has(node.type) || !isRecord(node.position) || typeof node.position.x !== 'number' || !Number.isFinite(node.position.x) || typeof node.position.y !== 'number' || !Number.isFinite(node.position.y) || !isRecord(node.config)) return false;
    nodeIds.add(node.id);
  }
  const conditionBranches = new Set<string>();
  return value.edges.every((edge) => {
    if (!isRecord(edge) || typeof edge.id !== 'string' || typeof edge.source !== 'string' || typeof edge.target !== 'string' || !nodeIds.has(edge.source) || !nodeIds.has(edge.target) || (edge.condition !== undefined && typeof edge.condition !== 'string')) return false;
    const source = value.nodes.find((node: Record<string, any>) => isRecord(node) && node.id === edge.source);
    if (!source || source.type !== 'CONDITION') return true;
    if (typeof edge.condition !== 'string' || !workflowBranchConditions.has(edge.condition)) return false;
    const branchKey = `${edge.source}:${edge.condition}`;
    if (conditionBranches.has(branchKey)) return false;
    conditionBranches.add(branchKey);
    return true;
  });
}

export function isActionProposal(value: unknown): value is ActionProposalContract {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.shopId === 'string'
    && typeof value.conversationId === 'string'
    && typeof value.type === 'string'
    && actionProposalTypes.has(value.type)
    && typeof value.riskLevel === 'string'
    && actionRiskLevels.has(value.riskLevel)
    && typeof value.targetEntityType === 'string'
    && typeof value.targetEntityId === 'string'
    && Number.isSafeInteger(value.contextVersion)
    && value.contextVersion >= 0
    && typeof value.status === 'string'
    && actionProposalStatuses.has(value.status)
    && (value.payload === undefined || isRecord(value.payload))
    && (value.evidenceIds === undefined || (Array.isArray(value.evidenceIds) && value.evidenceIds.every((item) => typeof item === 'string')));
}

export function isQualityReview(value: unknown): value is QualityReviewContract {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.conversationId === 'string'
    && typeof value.status === 'string'
    && qualityReviewStatuses.has(value.status)
    && (value.sampleSize === undefined || (Number.isSafeInteger(value.sampleSize) && value.sampleSize >= 0));
}

export function isScenarioKey(value: unknown): value is ScenarioKey {
  return typeof value === 'string' && scenarioKeys.has(value);
}

export function isTraceEvent(value: unknown): value is TraceEventContract {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.traceId === 'string'
    && typeof value.stage === 'string'
    && typeof value.createdAt === 'string'
    && isRecord(value.payload);
}

export const ASSIST_DRAFT_TTL_MS = 5 * 60 * 1000;

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function nullableStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function parseCsvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    const next = csv[index + 1];
    if (character === '"') {
      if (quoted && next === '"') { field += '"'; index += 1; } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field); field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(field); field = '';
      if (row.some((value) => value.trim())) records.push(row);
      row = [];
    } else field += character;
  }
  row.push(field);
  if (row.some((value) => value.trim())) records.push(row);
  return records;
}

export function normalizeCsvHeader(value: string): string {
  return value.replace(/^\ufeff/, '').trim().toLowerCase().replace(/[\s_-]/g, '');
}

/** Normalize a server draft so the Workbench can render every terminal state. */
