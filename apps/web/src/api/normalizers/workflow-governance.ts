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

export function normalizeWorkflowGraphValue(value: unknown): WorkflowGraph {
  if (!isWorkflowGraph(value)) {
    throw new ApiError('Workflow Graph 不符合 V1 节点与 settings 契约。', 502, 'WORKFLOW_GRAPH_INVALID');
  }
  return value;
}

export function normalizeWorkflowVersion(value: unknown): WorkflowVersion {
  const record = objectRecord(value) ?? {};
  return {
    id: String(record.id ?? ''),
    workspaceId: stringValue(record.workspaceId),
    tenantId: stringValue(record.tenantId),
    workflowId: String(record.workflowId ?? ''),
    version: numberValue(record.version) ?? 0,
    graph: normalizeWorkflowGraphValue(record.graph ?? record.graphJson),
    publishedAt: stringValue(record.publishedAt),
    createdAt: stringValue(record.createdAt),
  };
}

export function normalizeWorkflow(value: unknown): Workflow {
  const record = objectRecord(value) ?? {};
  const draft = record.draftVersion ?? record.draft;
  const active = record.activeVersion;
  return {
    id: String(record.id ?? ''),
    workspaceId: stringValue(record.workspaceId),
    tenantId: stringValue(record.tenantId),
    shopId: stringValue(record.shopId),
    name: String(record.name ?? ''),
    type: String(record.type ?? ''),
    priority: numberValue(record.priority) ?? 50,
    status: String(record.status ?? 'DRAFT') as Workflow['status'],
    activeVersionId: stringValue(record.activeVersionId),
    ...(draft ? { draftVersion: normalizeWorkflowVersion(draft) } : {}),
    ...(active ? { activeVersion: normalizeWorkflowVersion(active) } : {}),
    createdAt: stringValue(record.createdAt),
    updatedAt: stringValue(record.updatedAt),
  };
}

export function normalizeNodeRun(value: unknown): NodeRun {
  const record = objectRecord(value) ?? {};
  return {
    id: String(record.id ?? ''),
    workflowRunId: String(record.workflowRunId ?? ''),
    nodeId: String(record.nodeId ?? ''),
    status: String(record.status ?? 'PENDING') as NodeRun['status'],
    input: objectRecord(record.input ?? record.inputJson),
    output: objectRecord(record.output ?? record.outputJson),
    errorCode: stringValue(record.errorCode),
    retryCount: numberValue(record.retryCount) ?? 0,
    startedAt: stringValue(record.startedAt),
    finishedAt: stringValue(record.finishedAt),
    durationMs: numberValue(record.durationMs),
  };
}

export function normalizeWorkflowRun(value: unknown): WorkflowRun {
  const record = objectRecord(value) ?? {};
  const rawTaskIds = Array.isArray(record.taskIds) ? record.taskIds.filter((item): item is string => typeof item === 'string') : [];
  const rawCompleted = record.completedNodeIds ?? record.completedNodeIdsJson;
  const completedNodeIds = Array.isArray(rawCompleted) ? rawCompleted.filter((item): item is string => typeof item === 'string') : [];
  const rawNodeRuns = Array.isArray(record.nodeRuns) ? record.nodeRuns.map(normalizeNodeRun) : undefined;
  const rawProposals = Array.isArray(record.proposals) ? record.proposals : undefined;
  return {
    id: String(record.id ?? ''),
    workspaceId: stringValue(record.workspaceId),
    tenantId: stringValue(record.tenantId),
    shopId: String(record.shopId ?? ''),
    conversationId: String(record.conversationId ?? ''),
    workflowVersionId: String(record.workflowVersionId ?? record.versionId ?? ''),
    taskIds: rawTaskIds,
    contextVersion: numberValue(record.contextVersion) ?? 0,
    currentNodeId: stringValue(record.currentNodeId),
    completedNodeIds,
    status: String(record.status ?? 'RUNNING') as WorkflowRun['status'],
    startedAt: String(record.startedAt ?? ''),
    finishedAt: stringValue(record.finishedAt),
    updatedAt: stringValue(record.updatedAt),
    ...(rawNodeRuns ? { nodeRuns: rawNodeRuns } : {}),
    ...(rawProposals ? { proposals: rawProposals.map(normalizeActionProposal) } : {}),
  };
}

export function normalizeActionProposal(value: unknown): ActionProposal {
  const record = objectRecord(value) ?? {};
  const proposal: ActionProposal = {
    id: String(record.id ?? ''),
    workspaceId: stringValue(record.workspaceId),
    tenantId: stringValue(record.tenantId),
    shopId: String(record.shopId ?? ''),
    conversationId: String(record.conversationId ?? ''),
    workflowRunId: stringValue(record.workflowRunId),
    type: String(record.type ?? 'PROPOSE_COMPENSATION') as ActionProposal['type'],
    riskLevel: String(record.riskLevel ?? 'HIGH_RISK') as ActionProposal['riskLevel'],
    targetEntityType: String(record.targetEntityType ?? ''),
    targetEntityId: String(record.targetEntityId ?? ''),
    payload: objectRecord(record.payload ?? record.payloadJson),
    evidenceIds: Array.isArray(record.evidenceIds)
      ? record.evidenceIds.filter((item): item is string => typeof item === 'string')
      : undefined,
    contextVersion: numberValue(record.contextVersion) ?? 0,
    status: String(record.status ?? 'PROPOSED') as ActionProposal['status'],
    approvedBy: stringValue(record.approvedBy),
    approvedAt: stringValue(record.approvedAt),
    receipt: objectRecord(record.receipt ?? record.receiptJson),
    createdAt: stringValue(record.createdAt),
    updatedAt: stringValue(record.updatedAt),
  };
  if (!isActionProposal(proposal)) throw new ApiError('ActionProposal 响应不符合契约。', 502, 'ACTION_PROPOSAL_INVALID');
  return proposal;
}

export function normalizeQualityReview(value: unknown): QualityReview {
  const record = objectRecord(value) ?? {};
  const review: QualityReview = {
    id: String(record.id ?? ''),
    workspaceId: stringValue(record.workspaceId),
    tenantId: stringValue(record.tenantId),
    conversationId: String(record.conversationId ?? ''),
    status: String(record.status ?? 'PENDING') as QualityReview['status'],
    deterministicResult: objectRecord(record.deterministicResult ?? record.deterministicResultJson) as QualityReview['deterministicResult'],
    judgeResult: objectRecord(record.judgeResult ?? record.judgeResultJson) as QualityReview['judgeResult'],
    humanResult: stringValue(record.humanResult) as QualityReview['humanResult'],
    sampleSize: numberValue(record.sampleSize),
    metrics: objectRecord(record.metrics) as QualityReview['metrics'],
    createdBy: stringValue(record.createdBy),
    createdAt: stringValue(record.createdAt),
    completedAt: stringValue(record.completedAt),
  };
  if (!isQualityReview(review)) throw new ApiError('QualityReview 响应不符合契约。', 502, 'QUALITY_REVIEW_INVALID');
  return review;
}

export function normalizeReplyIncident(value: unknown): ReplyIncident {
  const record = objectRecord(value) ?? {};
  return {
    id: String(record.id ?? ''),
    workspaceId: stringValue(record.workspaceId),
    tenantId: stringValue(record.tenantId),
    conversationId: stringValue(record.conversationId),
    replyId: String(record.replyId ?? record.replyMessageId ?? record.replyJobId ?? ''),
    replyJobId: stringValue(record.replyJobId),
    errorType: String(record.errorType ?? ''),
    severity: String(record.severity ?? 'MEDIUM') as IncidentSeverity,
    sourceType: stringValue(record.sourceType),
    originalAnswer: String(record.originalAnswer ?? record.originalAnswerSnapshot ?? ''),
    correctedAnswer: stringValue(record.correctedAnswer),
    rootCause: stringValue(record.rootCause),
    status: String(record.status ?? 'OPEN') as IncidentStatus,
    regressionCaseId: stringValue(record.regressionCaseId),
    createdAt: stringValue(record.createdAt),
    resolvedAt: stringValue(record.resolvedAt),
  };
}

export function normalizeTraceEvent(value: unknown): TraceEvent | null {
  const record = objectRecord(value);
  if (!record) return null;
  const event: TraceEvent = {
    id: String(record.id ?? ''),
    workspaceId: stringValue(record.workspaceId),
    tenantId: stringValue(record.tenantId),
    shopId: stringValue(record.shopId),
    conversationId: stringValue(record.conversationId),
    replyJobId: stringValue(record.replyJobId),
    traceId: String(record.traceId ?? ''),
    stage: String(record.stage ?? ''),
    payload: objectRecord(record.payload ?? record.payloadJson) ?? {},
    createdAt: String(record.createdAt ?? record.occurredAt ?? ''),
  };
  return isTraceEvent(event) ? event : null;
}

/**
 * Trace raw messages are an optional diagnostic projection. Normalize the
 * legacy/flattened Web shape into the durable contract rather than weakening
 * the shared Message DTO with UI-only optional fields.
 */
function normalizeTraceMessage(value: unknown): MessageContract | null {
  const record = objectRecord(value);
  if (!record) return null;
  const rawContent = record.content ?? record.contentJson;
  let content = objectRecord(rawContent);
  if (!content && typeof rawContent === 'string') {
    try {
      content = objectRecord(JSON.parse(rawContent));
    } catch {
      // Keep the flattened text fallback below.
    }
  }
  if (!content) content = { text: readTextValue(rawContent) ?? '' };
  const rawRole = String(record.role ?? 'SYSTEM');
  const role: MessageContract['role'] = rawRole === 'ASSISTANT' ? 'AI' : ['BUYER', 'AI', 'HUMAN', 'SYSTEM'].includes(rawRole)
    ? rawRole as MessageContract['role']
    : 'SYSTEM';
  const rawKind = String(record.kind ?? 'TEXT');
  const kind: MessageContract['kind'] = rawKind === 'PRODUCT_CARD' ? 'GOODS_CARD' : ['TEXT', 'IMAGE', 'GOODS_CARD', 'ORDER_CARD', 'SYSTEM'].includes(rawKind)
    ? rawKind as MessageContract['kind']
    : 'TEXT';
  const rawStatus = String(record.status ?? 'ACTIVE');
  const status: MessageContract['status'] = ['ACTIVE', 'EDITED', 'RECALLED', 'DELETED'].includes(rawStatus)
    ? rawStatus as MessageContract['status']
    : 'ACTIVE';
  const fallbackTime = new Date(0).toISOString();
  return {
    id: String(record.id ?? ''),
    workspaceId: String(record.workspaceId ?? 'unknown-workspace'),
    tenantId: String(record.tenantId ?? 'unknown-tenant'),
    platform: String(record.platform ?? 'DOUYIN_DEMO'),
    shopId: String(record.shopId ?? ''),
    conversationId: String(record.conversationId ?? ''),
    buyerId: String(record.buyerId ?? ''),
    externalMessageId: String(record.externalMessageId ?? record.id ?? ''),
    sequence: numberValue(record.sequence) ?? 0,
    role,
    kind,
    status,
    content,
    sentAt: String(record.sentAt ?? record.createdAt ?? fallbackTime),
    receivedAt: String(record.receivedAt ?? record.sentAt ?? record.createdAt ?? fallbackTime),
    createdAt: stringValue(record.createdAt),
    updatedAt: stringValue(record.updatedAt),
    entityVersion: numberValue(record.entityVersion),
  };
}

export function normalizeDeveloperTrace(value: unknown): DeveloperTrace {
  const record = objectRecord(value) ?? {};
  const rawEvents = Array.isArray(record.events) ? record.events : Array.isArray(record.traceEvents) ? record.traceEvents : [];
  const trace: DeveloperTrace = {
    traceId: String(record.traceId ?? ''),
    workspaceId: stringValue(record.workspaceId),
    conversationId: stringValue(record.conversationId),
    replyId: stringValue(record.replyId),
    events: rawEvents.map(normalizeTraceEvent).filter((item): item is TraceEvent => Boolean(item)),
    rawMessages: Array.isArray(record.rawMessages)
      ? record.rawMessages.map(normalizeTraceMessage).filter((item): item is MessageContract => Boolean(item))
      : undefined,
    userTurn: objectRecord(record.userTurn),
    taskBundle: objectRecord(record.taskBundle),
    contextResolver: objectRecord(record.contextResolver),
    factContext: objectRecord(record.factContext),
    evidence: Array.isArray(record.evidence) ? record.evidence.filter((item): item is Record<string, unknown> => Boolean(objectRecord(item))) as Record<string, unknown>[] : undefined,
    replyPolicy: objectRecord(record.replyPolicy),
    workflow: objectRecord(record.workflow),
    sendGuard: objectRecord(record.sendGuard),
    aiRuntime: objectRecord(record.aiRuntime),
    quality: objectRecord(record.quality),
  };
  if (!trace.traceId) throw new ApiError('Trace 响应缺少 traceId。', 502, 'TRACE_INVALID');
  return trace;
}

export function normalizeScenario(value: unknown): Scenario {
  const record = objectRecord(value) ?? {};
  if (!isScenarioKey(record.key)) throw new ApiError('Scenario 不在 V1 固定白名单内。', 502, 'SCENARIO_KEY_INVALID');
  if (record.synthetic !== true) throw new ApiError('Scenario 仅允许 synthetic demo 数据。', 502, 'SCENARIO_NOT_SYNTHETIC');
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  return {
    key: record.key,
    name: String(record.name ?? record.key),
    status: String(record.status ?? 'READY') as Scenario['status'],
    synthetic: true,
    description: stringValue(record.description),
    expectedResult: stringValue(record.expectedResult),
    steps: rawSteps as Scenario['steps'],
    traceId: stringValue(record.traceId),
    lastRunAt: stringValue(record.lastRunAt),
    updatedAt: stringValue(record.updatedAt),
  };
}

export function normalizeAcceptedOperation(value: unknown): OperationAccepted {
  const operation = extractEntity<unknown>(value, 'operation');
  if (!isOperationAccepted(operation)) {
    throw new ApiError('异步命令未返回有效的 202 回执。', 502, 'OPERATION_RECEIPT_INVALID');
  }
  return operation;
}
