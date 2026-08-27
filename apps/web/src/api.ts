import type {
  ActionProposal as ActionProposalContract,
  ApproveActionProposalInput,
  Bootstrap as BootstrapPayload,
  ConversationMessageCommand as ConversationMessageCommandContract,
  ConversationModeCommand,
  ConversationControlResult as ConversationControlResultContract,
  CustomerMemory as CustomerMemoryContract,
  CustomerMemoryDisableCommand,
  CustomerMemoryStatusResult as CustomerMemoryStatusResultContract,
  CustomerDataDeletionResult as CustomerDataDeletionResultContract,
  CreateReplyIncidentInput,
  CreateWorkflowInput,
  CustomerMemoryInput,
  CorrectionInput,
  DeveloperTrace as DeveloperTraceContract,
  DynamicFactInventoryCommand,
  DynamicFactMutationAccepted,
  DynamicFactOrderStatus,
  DynamicFactOrderStatusCommand,
  HumanFinalAccepted as HumanFinalAcceptedContract,
  IncidentSeverity,
  IncidentStatus,
  Message as MessageContract,
  NodeRun as NodeRunContract,
  OperationAccepted as OperationAcceptedContract,
  QualityConclusionInput as QualityConclusionInputContract,
  QualityResult as QualityResultContract,
  QualityReview as QualityReviewContract,
  RejectActionProposalInput,
  ReplyIncident as ReplyIncidentContract,
  ReplyDraft as ReplyDraftContract,
  ReplyJob as ReplyJobContract,
  Scenario as ScenarioContract,
  ScenarioKey,
  SendOutbox as SendOutboxContract,
  TaskBundle,
  SeedCounts,
  Shop as ShopSummary,
  TraceEvent as TraceEventContract,
  WorkspaceSession,
  Workflow as WorkflowContract,
  WorkflowGraph as WorkflowGraphContract,
  WorkflowRun as WorkflowRunContract,
  WorkflowRunFilter,
  WorkflowVersion as WorkflowVersionContract,
} from '@ai-customer-service/contracts';

export const DEMO_TOKEN_STORAGE_KEY = 'ai-customer-service-demo.workspace-token';

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

export interface WorkspaceResetResult {
  operationId?: string;
  status: 'ACCEPTED' | 'QUEUED' | 'READY';
  counts?: SeedCounts;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/* Runtime guards stay local to the browser bundle; the shared package remains
 * the source of the DTO types while its CommonJS declarations are type-only
 * for this Vite entrypoint. Keep these allowlists in lockstep with contracts. */
const workflowNodeTypes = new Set(['TRIGGER', 'CONDITION', 'QUERY_PRODUCT', 'QUERY_ORDER', 'QUERY_LOGISTICS', 'AI_GENERATE', 'HUMAN_APPROVAL', 'END']);
const workflowBranchConditions = new Set(['true', 'false']);
const workflowRunStatuses = new Set(['PENDING', 'RUNNING', 'WAITING_APPROVAL', 'RECOVERING', 'COMPLETED', 'FAILED', 'STALE', 'CANCELLED']);
const workflowNodeRunStatuses = new Set(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'WAITING_APPROVAL', 'STALE', 'SKIPPED']);
const actionProposalTypes = new Set(['MARK_READ', 'CREATE_INTERNAL_TASK', 'TRANSFER_HUMAN', 'ADD_ORDER_REMARK', 'PROPOSE_COMPENSATION', 'REFUND', 'EXCHANGE']);
const actionRiskLevels = new Set(['READ', 'LOW_WRITE', 'MEDIUM_WRITE', 'HIGH_RISK']);
const actionProposalStatuses = new Set(['PROPOSED', 'POLICY_CHECKED', 'WAITING_APPROVAL', 'APPROVED', 'REVALIDATING', 'EXECUTING', 'SUCCEEDED', 'REJECTED', 'STALE', 'FAILED', 'UNCERTAIN', 'CANCELLED']);
const qualityReviewStatuses = new Set(['PENDING', 'RUNNING', 'AUTO_REVIEWED', 'PASS', 'FAIL', 'NEEDS_HUMAN']);
const qualityResults = new Set(['PASS', 'FAIL', 'NEEDS_HUMAN']);
const scenarioKeys = new Set(['continuous_messages', 'message_during_generation', 'two_buyers', 'two_shops', 'duplicate_and_reorder', 'ai_timeout_fallback', 'service_restart_recovery', 'realtime_state_change']);

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOperationAccepted(value: unknown): value is OperationAcceptedContract {
  return isRecord(value) && typeof value.operationId === 'string' && value.operationId.length > 0 && (value.status === 'ACCEPTED' || value.status === 'QUEUED');
}

function isWorkflowGraph(value: unknown): value is WorkflowGraphContract {
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

function isActionProposal(value: unknown): value is ActionProposalContract {
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

function isQualityReview(value: unknown): value is QualityReviewContract {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.conversationId === 'string'
    && typeof value.status === 'string'
    && qualityReviewStatuses.has(value.status)
    && (value.sampleSize === undefined || (Number.isSafeInteger(value.sampleSize) && value.sampleSize >= 0));
}

function isScenarioKey(value: unknown): value is ScenarioKey {
  return typeof value === 'string' && scenarioKeys.has(value);
}

function isTraceEvent(value: unknown): value is TraceEventContract {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.traceId === 'string'
    && typeof value.stage === 'string'
    && typeof value.createdAt === 'string'
    && isRecord(value.payload);
}

export interface Buyer {
  id: string;
  displayName?: string;
  name?: string;
  externalBuyerId?: string;
  avatar?: string;
  tags?: string[];
  tagsJson?: unknown;
  shopId?: string;
}

export interface ProductSku {
  id?: string;
  externalSkuId?: string;
  attributes?: Record<string, string>;
  attributesJson?: unknown;
  price?: number | string;
  inventory?: number;
  status?: string;
}

export interface Product {
  id: string;
  title?: string;
  name?: string;
  externalProductId?: string;
  description?: string;
  status?: string;
  recommendable?: boolean;
  shopId?: string;
  skus?: ProductSku[];
  sku?: ProductSku;
  price?: number | string;
  inventory?: number;
  learning?: ProductLearningSummary;
  learningSummary?: ProductLearningSummary;
}

export interface Order {
  id: string;
  externalOrderId?: string;
  orderNo?: string;
  shopId?: string;
  buyerId?: string;
  productId?: string;
  product?: Product;
  sku?: ProductSku;
  status?: string;
  amount?: number | string;
  orderedAt?: string;
  shippedAt?: string;
  logistics?: Record<string, unknown> | null;
  logisticsSnapshotJson?: unknown;
}

export type ConversationMode = 'AUTO' | 'ASSIST' | 'MANUAL' | 'HOLD' | (string & {});

export interface Message {
  id: string;
  conversationId?: string;
  buyerId?: string;
  shopId?: string;
  role?: 'BUYER' | 'ASSISTANT' | 'AI' | 'HUMAN' | 'SYSTEM' | (string & {});
  kind?: 'TEXT' | 'IMAGE' | 'GOODS_CARD' | 'PRODUCT_CARD' | 'ORDER_CARD' | 'SYSTEM' | (string & {});
  status?: 'ACTIVE' | 'RECALLED' | 'EDITED' | 'DELETED' | (string & {});
  sequence?: number;
  text?: string;
  content?: unknown;
  contentJson?: unknown;
  sentAt?: string;
  receivedAt?: string;
  createdAt?: string;
  product?: Product;
  order?: Order;
  productId?: string;
  orderId?: string;
}

export type OperationAccepted = OperationAcceptedContract;

export type MutationResult = Message | OperationAccepted;

export interface Conversation {
  id: string;
  shopId?: string;
  buyerId?: string;
  externalConversationId?: string;
  state?: 'ACTIVE' | 'CLOSING' | 'CLOSED' | (string & {});
  mode?: ConversationMode;
  overrideMode?: ConversationMode;
  effectiveMode?: ConversationMode;
  syncState?: 'CONNECTED' | 'RECONNECTING' | 'RECONCILING' | 'DEGRADED' | 'DISCONNECTED' | (string & {});
  activeTopic?: string;
  currentProductId?: string;
  currentOrderId?: string;
  contextVersion?: number;
  humanActive?: boolean;
  needsReplan?: boolean;
  activeReplyJobId?: string | null;
  activeReplyJob?: ReplyJob | null;
  currentDraft?: ReplyDraft | null;
  sendOutbox?: SendOutbox | null;
  taskBundle?: TaskBundle | null;
  customerMemories?: CustomerMemory[];
  unreadCount?: number;
  lastMessageAt?: string;
  updatedAt?: string;
  createdAt?: string;
  buyer?: Buyer;
  currentProduct?: Product;
  currentOrder?: Order;
  lastMessage?: Message;
  messages?: Message[];
}

export type ReplyDraft = ReplyDraftContract;
export type ReplyJob = ReplyJobContract;
export type SendOutbox = SendOutboxContract;
export type CustomerMemory = CustomerMemoryContract;
export type CustomerDataDeletionResult = CustomerDataDeletionResultContract;
export type CustomerMemoryInputDto = CustomerMemoryInput;
export type CustomerMemoryDisableInput = CustomerMemoryDisableCommand;
export type CustomerMemoryStatusResult = CustomerMemoryStatusResultContract;
export type SyntheticDynamicFactInventoryInput = DynamicFactInventoryCommand;
export type SyntheticDynamicFactOrderStatus = DynamicFactOrderStatus;
export type SyntheticDynamicFactOrderStatusInput = DynamicFactOrderStatusCommand;
export type SyntheticDynamicFactAccepted = DynamicFactMutationAccepted;
/** Conversation message fields supplied by the composer; shop scope is explicit in the API function. */
export type ConversationMessageInput = Omit<ConversationMessageCommandContract, 'shopId'>;
export type ConversationControlResult = ConversationControlResultContract;
export type HumanFinalReceipt = HumanFinalAcceptedContract;
export type Workflow = WorkflowContract;
export type WorkflowVersion = WorkflowVersionContract;
export type WorkflowGraph = WorkflowGraphContract;
export type WorkflowRun = WorkflowRunContract;
export type NodeRun = NodeRunContract;
export type WorkflowRunQuery = WorkflowRunFilter;
export type ActionProposal = ActionProposalContract;
export type QualityReview = QualityReviewContract;
export type QualityResult = QualityResultContract;
export type QualityConclusionInput = QualityConclusionInputContract;
export type ReplyIncident = ReplyIncidentContract;
export type DeveloperTrace = DeveloperTraceContract;
export type TraceEvent = TraceEventContract;
export type Scenario = ScenarioContract;
export type UsageSummary = import('@ai-customer-service/contracts').UsageSummary;

export type KnowledgeScope = 'STORE' | 'PRODUCT';
export type KnowledgeSourceType = 'MANUAL' | 'HUMAN_REVIEWED' | 'AUTO_LEARNED' | (string & {});
export type KnowledgeBusinessStatus = 'DRAFT' | 'ENABLED' | 'DISABLED' | 'OUTDATED' | 'CONFLICTED' | 'DELETED' | (string & {});
export type KnowledgeIndexStatus = 'PENDING' | 'INDEXING' | 'READY' | 'FAILED' | (string & {});

export interface KnowledgeItem {
  id: string;
  shopId?: string;
  productId?: string | null;
  productTitle?: string;
  name?: string;
  question: string;
  answer: string;
  scope: KnowledgeScope;
  sourceType: KnowledgeSourceType;
  businessStatus: KnowledgeBusinessStatus;
  indexStatus: KnowledgeIndexStatus;
  activeVersion?: number | string | KnowledgeVersionSnapshot | null;
  activeVersionId?: string | null;
  version?: number | string;
  sourceVersion?: string;
  confidence?: number | null;
  updatedAt?: string;
  createdAt?: string;
}

export type KnowledgeCandidateStatus = 'PENDING' | 'APPROVED' | 'PUBLISHED' | 'REJECTED' | 'DUPLICATE' | 'CONFLICTED' | (string & {});

export interface KnowledgeCandidate {
  id: string;
  shopId?: string;
  productId?: string | null;
  source: string;
  proposedQuestion: string;
  proposedAnswer: string;
  status: KnowledgeCandidateStatus;
  duplicateOfId?: string | null;
  conflictWithId?: string | null;
  updatedAt?: string;
}

export interface KnowledgeConflictSideSnapshot {
  itemId?: string;
  versionId?: string;
  version?: number | string;
  question?: string;
  answer?: string;
  indexStatus?: KnowledgeIndexStatus;
}

export type KnowledgeConflictResolution = 'KEEP_LEFT' | 'KEEP_RIGHT' | 'MERGE' | 'CUSTOM';

export interface KnowledgeConflict {
  id: string;
  shopId?: string;
  leftItemId: string;
  rightItemId: string;
  leftVersionId: string;
  rightVersionId: string;
  left?: KnowledgeConflictSideSnapshot;
  right?: KnowledgeConflictSideSnapshot;
  status: 'OPEN' | 'RESOLVED' | 'IGNORED' | (string & {});
  resolution?: unknown;
  resolvedAt?: string | null;
  updatedAt?: string;
}

export interface KnowledgeVersionSnapshot {
  id?: string;
  version?: number | string;
  question?: string;
  answer?: string;
  indexStatus?: KnowledgeIndexStatus;
  effectiveFrom?: string;
  effectiveTo?: string;
}

export interface KnowledgeImportRowInput {
  rowNumber: number;
  productId: string;
  question: string;
  answer: string;
  parseError?: string;
}

export type KnowledgeImportRowStatus = 'READY' | 'DUPLICATE' | 'CONFLICT' | 'ERROR';

export interface KnowledgeImportRow extends KnowledgeImportRowInput {
  scope: KnowledgeScope;
  status: KnowledgeImportRowStatus;
  reason?: string;
}

export interface KnowledgeImportCounts {
  ready: number;
  duplicate: number;
  conflict: number;
  error: number;
  total: number;
}

export interface KnowledgeImportPreview {
  id: string;
  importId?: string;
  fileName?: string;
  rows: KnowledgeImportRow[];
  counts?: KnowledgeImportCounts;
  status?: string;
}

/** The commit endpoint returns the same row-level job snapshot as preview. */
export type KnowledgeImportCommitResult = KnowledgeImportPreview;

export interface ProductSyncResult {
  status: string;
  synthetic?: boolean;
  productsSynced?: number;
}

export type ProductLearningStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'OUTDATED' | (string & {});
export type ProductLearningJobStatus = 'PENDING' | 'RUNNING' | 'PARTIAL_SUCCESS' | 'SUCCEEDED' | 'FAILED' | (string & {});

export interface ProductLearningJob {
  id: string;
  shopId?: string;
  status: ProductLearningJobStatus;
  totals?: ProductLearningTotals;
  items?: ProductLearningJobItem[];
  total?: number;
  completed?: number;
  processing?: number;
  failed?: number;
  progress?: number;
  startedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
}

export interface ProductLearningTotals {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface ProductLearningJobItem {
  productId: string;
  status: ProductLearningStatus;
  reason?: string | null;
}

export interface ProductLearningSummary {
  status?: ProductLearningStatus;
  knowledgeCount?: number;
  lastLearnedAt?: string;
  contentHash?: string;
  sourceVersion?: string;
  error?: string;
}

function endpoint(path: string): string {
  return `${apiBaseUrl}${path}`;
}

async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    return undefined;
  }

  return response.json();
}

async function request<T>(path: string, init: RequestInit = {}, expectedStatus?: number): Promise<T> {
  let response: Response;

  try {
    response = await fetch(endpoint(path), {
      ...init,
      headers: {
        Accept: 'application/json',
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError('无法连接 Foundation API，请确认本地 API 已启动。', 0, 'NETWORK_ERROR');
  }

  const body = await parseResponse(response);

  if (!response.ok) {
    const errorPayload = body as { error?: { code?: string; message?: string } } | undefined;
    throw new ApiError(
      errorPayload?.error?.message ?? `请求失败（${response.status}）`,
      response.status,
      errorPayload?.error?.code,
    );
  }

  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new ApiError(`请求返回了非预期状态（${response.status}）。`, response.status, 'HTTP_STATUS_UNEXPECTED');
  }

  return body as T;
}

function workspaceHeaders(token: string): HeadersInit {
  return {
    'X-Demo-Workspace-Token': token,
  };
}

function jsonHeaders(token: string): HeadersInit {
  return {
    ...workspaceHeaders(token),
    'Content-Type': 'application/json',
  };
}

/** Accept both a bare array and the common `{ data/items/<resource>: [] }` snapshots. */
export function extractCollection<T>(payload: unknown, resourceKey: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!payload || typeof payload !== 'object') return [];

  const record = payload as Record<string, unknown>;
  const direct = record[resourceKey] ?? record.items;
  if (Array.isArray(direct)) return direct as T[];
  if (record.data && typeof record.data === 'object') {
    const nested = record.data as Record<string, unknown>;
    if (Array.isArray(nested[resourceKey])) return nested[resourceKey] as T[];
    if (Array.isArray(nested.items)) return nested.items as T[];
  }
  if (Array.isArray(record.data)) return record.data as T[];
  return [];
}

function extractEntity<T>(payload: unknown, resourceKey: string): T {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record[resourceKey] && typeof record[resourceKey] === 'object') {
      return record[resourceKey] as T;
    }
    if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
      const data = record.data as Record<string, unknown>;
      if (data[resourceKey] && typeof data[resourceKey] === 'object') return data[resourceKey] as T;
      return record.data as T;
    }
  }
  return payload as T;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readTextValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'body', 'message', 'value']) {
    const text = stringValue(record[key]);
    if (text) return text;
  }
  return undefined;
}

/** Render a message regardless of whether the API exposes contentJson or a flattened content field. */
export function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as Record<string, unknown>;
  const direct = readTextValue(record.text);
  if (direct) return direct;
  const content = typeof record.content === 'string' ? record.content : readTextValue(record.content);
  if (content) return content;
  const contentJson = record.contentJson;
  if (typeof contentJson === 'string') {
    try {
      return readTextValue(JSON.parse(contentJson)) ?? contentJson;
    } catch {
      return contentJson;
    }
  }
  const jsonText = readTextValue(contentJson);
  if (jsonText) return jsonText;
  return '';
}

export const ASSIST_DRAFT_TTL_MS = 5 * 60 * 1000;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Normalize a server draft so the Workbench can render every terminal state. */
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

function normalizeWorkflowGraphValue(value: unknown): WorkflowGraph {
  if (!isWorkflowGraph(value)) {
    throw new ApiError('Workflow Graph 不符合 V1 节点与 settings 契约。', 502, 'WORKFLOW_GRAPH_INVALID');
  }
  return value;
}

function normalizeWorkflowVersion(value: unknown): WorkflowVersion {
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

function normalizeWorkflow(value: unknown): Workflow {
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

function normalizeNodeRun(value: unknown): NodeRun {
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

function normalizeWorkflowRun(value: unknown): WorkflowRun {
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

function normalizeActionProposal(value: unknown): ActionProposal {
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

function normalizeQualityReview(value: unknown): QualityReview {
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

function normalizeReplyIncident(value: unknown): ReplyIncident {
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

function normalizeTraceEvent(value: unknown): TraceEvent | null {
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

function normalizeDeveloperTrace(value: unknown): DeveloperTrace {
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

function normalizeScenario(value: unknown): Scenario {
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

function normalizeAcceptedOperation(value: unknown): OperationAccepted {
  const operation = extractEntity<unknown>(value, 'operation');
  if (!isOperationAccepted(operation)) {
    throw new ApiError('异步命令未返回有效的 202 回执。', 502, 'OPERATION_RECEIPT_INVALID');
  }
  return operation;
}

function parseCsvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    const next = csv[index + 1];
    if (character === '"') {
      if (quoted && next === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value.trim())) records.push(row);
      row = [];
    } else {
      field += character;
    }
  }

  row.push(field);
  if (row.some((value) => value.trim())) records.push(row);
  return records;
}

function normalizeCsvHeader(value: string): string {
  return value.replace(/^\ufeff/, '').trim().toLowerCase().replace(/[\s_-]/g, '');
}

/** Parse the frozen three-column CSV template on the client for instant preview feedback. */
export function parseKnowledgeCsv(csv: string): KnowledgeImportRowInput[] {
  const records = parseCsvRecords(csv);
  const header = records[0]?.map(normalizeCsvHeader) ?? [];
  const acceptedProductHeaders = new Set(['商品id（可选）', '商品id(可选)', '商品id', 'productid', 'product']);
  const acceptedQuestionHeaders = new Set(['问题', 'question', 'q']);
  const acceptedAnswerHeaders = new Set(['答案', 'answer', 'a']);
  const hasExpectedHeader = acceptedProductHeaders.has(header[0] ?? '') && acceptedQuestionHeaders.has(header[1] ?? '') && acceptedAnswerHeaders.has(header[2] ?? '');
  const sourceRows = hasExpectedHeader ? records.slice(1) : records;
  if (!hasExpectedHeader) {
    return [{ rowNumber: 1, productId: '', question: '', answer: '', parseError: '表头必须为：商品ID（可选）、问题、答案' }];
  }

  return sourceRows.map((values, index) => ({
    rowNumber: index + 2,
    productId: (values[0] ?? '').trim(),
    question: (values[1] ?? '').trim(),
    answer: values.slice(2).join(',').trim(),
    ...(values.length !== 3 ? { parseError: '每行必须包含三列' } : {}),
  }));
}

function importKey(productId: string, question: string): string {
  return `${productId.trim().toLowerCase() || 'store'}::${question.trim().toLowerCase()}`;
}

export interface ExistingKnowledgeMatch {
  productId?: string | null;
  question: string;
  answer: string;
}

export function classifyImportRows(
  rows: KnowledgeImportRowInput[],
  existing: ExistingKnowledgeMatch[] = [],
): KnowledgeImportRow[] {
  const existingByKey = new Map(existing.map((item) => [importKey(item.productId ?? '', item.question), item]));
  const seen = new Map<string, KnowledgeImportRow>();
  return rows.map((row) => {
    const scope: KnowledgeScope = row.productId ? 'PRODUCT' : 'STORE';
    if (row.parseError || !row.question || !row.answer) {
      const result: KnowledgeImportRow = { ...row, scope, status: 'ERROR', reason: row.parseError ?? '问题和答案不能为空' };
      seen.set(importKey(row.productId, row.question), result);
      return result;
    }

    const key = importKey(row.productId, row.question);
    const previous = seen.get(key);
    const existingMatch = existingByKey.get(key);
    let status: KnowledgeImportRowStatus = 'READY';
    let reason: string | undefined;
    if ((previous && previous.answer !== row.answer) || (existingMatch && existingMatch.answer !== row.answer)) {
      status = 'CONFLICT';
      reason = '相同问题已有不同答案';
    } else if (previous || existingMatch) {
      status = 'DUPLICATE';
      reason = '与已有知识或本文件重复';
    }
    const result: KnowledgeImportRow = { ...row, scope, status, ...(reason ? { reason } : {}) };
    seen.set(key, result);
    return result;
  });
}

function normalizeImportPreview(payload: unknown): KnowledgeImportPreview {
  const preview = extractEntity<Partial<KnowledgeImportPreview>>(payload, 'preview');
  const rawPreview = preview as Partial<KnowledgeImportPreview> & Record<string, unknown>;
  const sourceRows = Array.isArray(preview?.rows) ? preview.rows : [];
  const rows = sourceRows.map((row, index) => {
    const rawRow = row as KnowledgeImportRow & { result?: string; error?: string };
    const result = String(rawRow.status ?? rawRow.result ?? (rawRow.error ? 'ERROR' : 'READY')).toUpperCase();
    const status: KnowledgeImportRowStatus = result === 'NORMAL' || result === 'VALID' || result === 'READY' || result === 'COMMITTED'
      ? 'READY'
      : result === 'DUPLICATE'
        ? 'DUPLICATE'
        : result === 'CONFLICT' || result === 'CONFLICTED'
          ? 'CONFLICT'
          : 'ERROR';
    return {
      rowNumber: typeof rawRow.rowNumber === 'number' ? rawRow.rowNumber : index + 1,
      productId: String(rawRow.productId ?? ''),
      question: String(rawRow.question ?? ''),
      answer: String(rawRow.answer ?? ''),
      scope: rawRow.scope === 'PRODUCT' || rawRow.productId ? 'PRODUCT' : 'STORE',
      status,
      ...((rawRow.reason ?? rawRow.error) ? { reason: String(rawRow.reason ?? rawRow.error) } : {}),
    } satisfies KnowledgeImportRow;
  });
  const numberValue = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const totals = rawPreview.totals && typeof rawPreview.totals === 'object' && !Array.isArray(rawPreview.totals)
    ? rawPreview.totals as Record<string, unknown>
    : {};
  const counts = preview?.counts ?? (() => {
    const ready = numberValue(rawPreview.validRows) ?? numberValue(totals.valid);
    const duplicate = numberValue(rawPreview.duplicateRows) ?? numberValue(totals.duplicate);
    const conflict = numberValue(rawPreview.conflictRows) ?? numberValue(totals.conflict);
    const error = numberValue(rawPreview.invalidRows) ?? numberValue(totals.error);
    if (ready === undefined && duplicate === undefined && conflict === undefined && error === undefined) return undefined;
    return {
      ready: ready ?? 0,
      duplicate: duplicate ?? 0,
      conflict: conflict ?? 0,
      error: error ?? 0,
      total: numberValue(rawPreview.totalRows) ?? numberValue(totals.total) ?? rows.length,
    };
  })();
  const id = String(preview?.id ?? preview?.importId ?? '');
  return { ...preview, id, rows, ...(counts ? { counts } : {}), ...(preview?.importId ? { importId: preview.importId } : {}) };
}

function normalizeKnowledgeItem(value: unknown): KnowledgeItem {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const activeVersion = record.activeVersion && typeof record.activeVersion === 'object' && !Array.isArray(record.activeVersion)
    ? record.activeVersion as Record<string, unknown>
    : undefined;
  const product = record.product && typeof record.product === 'object' && !Array.isArray(record.product)
    ? record.product as Record<string, unknown>
    : undefined;
  const productId = stringValue(record.productId) ?? stringValue(product?.id) ?? null;
  const activeVersionValue = activeVersion
    ? {
        id: stringValue(activeVersion.id),
        version: typeof activeVersion.version === 'number' || typeof activeVersion.version === 'string' ? activeVersion.version : undefined,
        question: stringValue(activeVersion.question),
        answer: stringValue(activeVersion.answer),
        indexStatus: String(activeVersion.indexStatus ?? 'PENDING') as KnowledgeIndexStatus,
        effectiveFrom: stringValue(activeVersion.effectiveFrom),
        effectiveTo: stringValue(activeVersion.effectiveTo),
      } satisfies KnowledgeVersionSnapshot
    : record.activeVersion as number | string | null | undefined;
  const activeVersionNumber = activeVersion && (typeof activeVersion.version === 'number' || typeof activeVersion.version === 'string')
    ? activeVersion.version
    : typeof record.activeVersion === 'number' || typeof record.activeVersion === 'string' ? record.activeVersion : undefined;
  return {
    id: String(record.id ?? ''),
    shopId: stringValue(record.shopId),
    productId,
    productTitle: stringValue(record.productTitle) ?? stringValue(product?.title) ?? stringValue(product?.name),
    name: stringValue(record.name),
    question: stringValue(record.question) ?? stringValue(activeVersion?.question) ?? '',
    answer: stringValue(record.answer) ?? stringValue(activeVersion?.answer) ?? '',
    scope: record.scope === 'PRODUCT' || productId ? 'PRODUCT' : 'STORE',
    sourceType: String(record.sourceType ?? 'MANUAL') as KnowledgeSourceType,
    businessStatus: String(record.businessStatus ?? record.status ?? 'DRAFT') as KnowledgeBusinessStatus,
    indexStatus: String(record.indexStatus ?? activeVersion?.indexStatus ?? 'PENDING') as KnowledgeIndexStatus,
    activeVersion: activeVersionValue,
    activeVersionId: stringValue(record.activeVersionId) ?? stringValue(activeVersion?.id),
    version: typeof record.version === 'number' || typeof record.version === 'string' ? record.version : activeVersionNumber,
    sourceVersion: stringValue(record.sourceVersion),
    confidence: typeof record.confidence === 'number' ? record.confidence : null,
    updatedAt: stringValue(record.updatedAt),
    createdAt: stringValue(record.createdAt),
  };
}

export async function createWorkspace(): Promise<WorkspaceSession> {
  const session = await request<WorkspaceSession>('/demo/workspaces', { method: 'POST' });

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

export function resetCurrentWorkspace(token: string): Promise<WorkspaceResetResult> {
  return request<WorkspaceResetResult>('/demo/workspaces/current/reset', {
    method: 'POST',
    headers: workspaceHeaders(token),
  });
}

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

function normalizeCustomerDataDeletionResult(value: unknown): CustomerDataDeletionResult {
  const record = objectRecord(value);
  const deleted = objectRecord(record?.deleted);
  const anonymized = objectRecord(record?.anonymized);
  const preserved = objectRecord(record?.preserved);
  const count = (source: Record<string, unknown> | undefined, key: string): number | undefined => {
    const value = source?.[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const result: CustomerDataDeletionResult = {
    buyerId: typeof record?.buyerId === 'string' ? record.buyerId : '',
    status: 'COMPLETED',
    deleted: {
      conversations: count(deleted, 'conversations') ?? -1,
      messages: count(deleted, 'messages') ?? -1,
      attachments: count(deleted, 'attachments') ?? -1,
      customerMemories: count(deleted, 'customerMemories') ?? -1,
      knowledgeCandidates: count(deleted, 'knowledgeCandidates') ?? -1,
    },
    anonymized: {
      buyers: count(anonymized, 'buyers') ?? -1,
      orders: count(anonymized, 'orders') ?? -1,
    },
    preserved: {
      anonymousAggregates: count(preserved, 'anonymousAggregates') ?? -1,
      auditFacts: count(preserved, 'auditFacts') ?? -1,
    },
    completedAt: typeof record?.completedAt === 'string' ? record.completedAt : '',
  };
  if (!result.buyerId || !result.completedAt || Object.values(result.deleted).some((item) => item < 0) || Object.values(result.anonymized).some((item) => item < 0) || Object.values(result.preserved).some((item) => item < 0)) {
    throw new ApiError('客户数据删除接口未返回有效结果。', 502, 'CUSTOMER_DATA_DELETION_RESULT_INVALID');
  }
  return result;
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

const syntheticDynamicFactOrderStatuses = new Set<SyntheticDynamicFactOrderStatus>([
  'WAITING_SHIPMENT',
  'SHIPPED',
  'COMPLETED',
]);

export function isSyntheticDynamicFactOrderStatus(value: string): value is SyntheticDynamicFactOrderStatus {
  return syntheticDynamicFactOrderStatuses.has(value as SyntheticDynamicFactOrderStatus);
}

function normalizeSyntheticDynamicFactAccepted(value: unknown): SyntheticDynamicFactAccepted {
  const record = objectRecord(extractEntity<unknown>(value, 'operation')) ?? {};
  if (record.status !== 'ACCEPTED' || typeof record.operationId !== 'string' || !record.operationId) {
    throw new ApiError('动态事实变更未返回有效的 202 回执。', 502, 'DYNAMIC_FACT_RECEIPT_INVALID');
  }
  return { status: 'ACCEPTED', operationId: record.operationId };
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

export interface KnowledgeFilters {
  shopId?: string;
  scope?: KnowledgeScope | 'ALL';
  sourceType?: string | 'ALL';
  businessStatus?: string | 'ALL';
  indexStatus?: string | 'ALL';
  query?: string;
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

export interface KnowledgeModerationFilters {
  shopId?: string;
  status?: string;
}

function querySuffix(filters: KnowledgeModerationFilters): string {
  const params = new URLSearchParams();
  if (filters.shopId) params.set('shopId', filters.shopId);
  if (filters.status) params.set('status', filters.status);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function normalizeKnowledgeCandidate(value: unknown): KnowledgeCandidate {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    id: String(record.id ?? ''),
    shopId: stringValue(record.shopId),
    productId: stringValue(record.productId) ?? null,
    source: String(record.source ?? 'UNKNOWN'),
    proposedQuestion: String(record.proposedQuestion ?? record.question ?? ''),
    proposedAnswer: String(record.proposedAnswer ?? record.answer ?? ''),
    status: String(record.status ?? 'PENDING') as KnowledgeCandidateStatus,
    duplicateOfId: stringValue(record.duplicateOfId) ?? null,
    conflictWithId: stringValue(record.conflictWithId) ?? null,
    updatedAt: stringValue(record.updatedAt),
  };
}

function normalizeKnowledgeConflict(value: unknown): KnowledgeConflict {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const normalizeSide = (name: 'left' | 'right'): KnowledgeConflictSideSnapshot => {
    const side = record[name] && typeof record[name] === 'object' && !Array.isArray(record[name])
      ? record[name] as Record<string, unknown>
      : {};
    return {
      itemId: stringValue(side.itemId) ?? stringValue(record[`${name}ItemId`]),
      versionId: stringValue(side.versionId) ?? stringValue(record[`${name}VersionId`]),
      version: typeof side.version === 'number' || typeof side.version === 'string' ? side.version : undefined,
      question: stringValue(side.question) ?? stringValue(record[`${name}Question`]),
      answer: stringValue(side.answer) ?? stringValue(record[`${name}Answer`]),
      indexStatus: String(side.indexStatus ?? record[`${name}IndexStatus`] ?? '') as KnowledgeIndexStatus,
    };
  };
  const left = normalizeSide('left');
  const right = normalizeSide('right');
  return {
    id: String(record.id ?? ''),
    shopId: stringValue(record.shopId),
    leftItemId: left.itemId ?? '',
    rightItemId: right.itemId ?? '',
    leftVersionId: left.versionId ?? '',
    rightVersionId: right.versionId ?? '',
    left,
    right,
    status: String(record.status ?? 'OPEN') as KnowledgeConflict['status'],
    resolution: record.resolution,
    resolvedAt: stringValue(record.resolvedAt) ?? null,
    updatedAt: stringValue(record.updatedAt),
  };
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

export interface ResolveKnowledgeConflictInput {
  shopId?: string;
  resolution: KnowledgeConflictResolution;
  customQuestion?: string;
  customAnswer?: string;
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

export interface ProductLearningInput {
  productIds?: string[];
  retryFailed?: boolean;
}

function normalizeProductLearningJob(value: unknown): ProductLearningJob {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const totals = record.totals && typeof record.totals === 'object' && !Array.isArray(record.totals)
    ? record.totals as Record<string, unknown>
    : {};
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items = rawItems.map((value) => {
    const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
      productId: String(item.productId ?? ''),
      status: String(item.status ?? 'PENDING') as ProductLearningStatus,
      reason: typeof item.reason === 'string' ? item.reason : null,
    } satisfies ProductLearningJobItem;
  }).filter((item) => item.productId);
  const numeric = (...values: unknown[]): number | undefined => {
    const value = values.find((candidate) => typeof candidate === 'number' && Number.isFinite(candidate));
    return typeof value === 'number' ? value : undefined;
  };
  const total = numeric(record.total, record.totalProducts, totals.total) ?? items.length;
  const completed = numeric(record.completed, record.completedProducts, totals.completed)
    ?? items.filter((item) => item.status === 'SUCCEEDED').length;
  const processing = numeric(record.processing, record.processingProducts, totals.processing)
    ?? items.filter((item) => item.status === 'PROCESSING' || item.status === 'PENDING').length;
  const failed = numeric(record.failed, record.failedProducts, totals.failed)
    ?? items.filter((item) => item.status === 'FAILED').length;
  const created = numeric(totals.created, record.createdProducts) ?? 0;
  const updated = numeric(totals.updated, record.updatedProducts) ?? 0;
  const skipped = numeric(totals.skipped, record.skippedProducts) ?? Math.max(0, completed - created - updated);
  const progressValue = numeric(record.progress);
  const progress = progressValue === undefined
    ? total > 0 ? Math.round((completed / total) * 100) : 0
    : progressValue <= 1 ? progressValue * 100 : progressValue;
  const operationStatus = String(record.status ?? 'ACCEPTED');
  return {
    id: String(record.id ?? record.operationId ?? ''),
    shopId: stringValue(record.shopId),
    status: operationStatus as ProductLearningJobStatus,
    totals: { total, created, updated, skipped, failed },
    items,
    total,
    completed,
    processing,
    failed,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    startedAt: stringValue(record.startedAt),
    finishedAt: stringValue(record.finishedAt ?? record.completedAt),
    updatedAt: stringValue(record.updatedAt),
  };
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

export interface BuyerMessageInput {
  shopId: string;
  buyerId: string;
  text: string;
  conversationId?: string;
}

export interface BuyerCardInput {
  shopId: string;
  buyerId: string;
  conversationId?: string;
  productId?: string;
  orderId?: string;
}

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

export type { BootstrapPayload, SeedCounts, ShopSummary };
