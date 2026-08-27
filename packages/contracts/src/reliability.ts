import type { IsoDateTime } from './workspace';
import type { ConversationMode } from './conversation';
import type { Message } from './message';

/**
 * Phase 04 runtime states. These are deliberately string unions rather than
 * Prisma enums so REST and WebSocket clients can safely render a state while
 * a newer server is rolling out an additional terminal reason.
 */
export type ReplyJobStatus =
  | 'PENDING'
  | 'GENERATING'
  | 'FAST_PATH_READY'
  | 'WAITING_HUMAN'
  | 'SENT'
  | 'CANCELLING'
  | 'STALE'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'FAILED'
  | 'RECOVERY_PENDING';

export type ReplyDraftStatus =
  | 'GENERATING'
  | 'WAITING_HUMAN'
  | 'STALE'
  | 'EXPIRED'
  | 'FAILED'
  | 'SENT'
  | 'CANCELLED';

export type ReplyDraftEditType =
  | 'STYLE_EDIT'
  | 'FACTUAL_CORRECTION'
  | 'KNOWLEDGE_ENRICHMENT';

export interface ReplyDraft {
  id: string;
  replyJobId: string;
  aiDraft: string;
  humanFinal: string | null;
  editType: ReplyDraftEditType | null;
  status: ReplyDraftStatus;
  /** Context cursor captured when this draft was generated. */
  sourceContextVersion: number;
  sourceLastMessageId?: string | null;
  sourceSequence?: number | null;
  generatedAt?: IsoDateTime;
  expiresAt?: IsoDateTime | null;
  staleReason?: string | null;
  updatedAt?: IsoDateTime;
}

export interface ReplyJob {
  id: string;
  workspaceId?: string;
  tenantId?: string;
  shopId?: string;
  conversationId: string;
  userTurnId?: string | null;
  status: ReplyJobStatus;
  mode: ConversationMode;
  sourceLastMessageId?: string | null;
  sourceSequence?: number | null;
  sourceContextVersion?: number | null;
  needsReplanReason?: string | null;
  staleReason?: string | null;
  abortReason?: string | null;
  expiresAt?: IsoDateTime | null;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  ragStrategy?: string | null;
  tokenUsage?: { inputTokens: number; outputTokens: number } | null;
  fallbackUsed?: boolean;
  draft?: ReplyDraft | null;
  /** Alias used by conversation snapshot projections. */
  currentDraft?: ReplyDraft | null;
  sendOutbox?: SendOutbox | null;
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
}

export type SendOutboxStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'UNCERTAIN' | 'CANCELLED';

export interface SendReceipt {
  id?: string;
  externalMessageId?: string;
  platformMessageId?: string;
  sentAt?: IsoDateTime;
  acceptedAt?: IsoDateTime;
  raw?: Record<string, unknown>;
}

export interface SendOutbox {
  id: string;
  workspaceId?: string;
  tenantId?: string;
  shopId?: string;
  conversationId?: string;
  replyJobId?: string | null;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  expectedLastMessageId?: string | null;
  expectedSequence?: number | null;
  expectedContextVersion?: number | null;
  status: SendOutboxStatus;
  receipt?: SendReceipt | null;
  failureCode?: string | null;
  failureReason?: string | null;
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
}

export type SendGuardFailureCode =
  | 'SEND_CONFLICT'
  | 'HUMAN_ACTIVE'
  | 'CONTEXT_STALE'
  | 'DUPLICATE_ACTION'
  | 'FORBIDDEN_TERM'
  | 'CONVERSATION_CLOSED';

export interface SendGuardInput {
  expectedLastMessageId?: string | null;
  expectedSequence?: number | null;
  expectedContextVersion?: number | null;
  humanActive: boolean;
  idempotencyKey: string;
}

export interface SendGuardResult {
  allowed: boolean;
  failureCode?: SendGuardFailureCode;
  reason?: string;
  idempotencyKey: string;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type TaskStatus = 'OPEN' | 'RUNNING' | 'RESOLVED' | 'AMBIGUOUS' | 'FAILED' | 'SUPERSEDED' | 'CANCELLED';
export type TaskBundleStatus = 'ALL_RESOLVED' | 'PARTIAL_RESOLVED' | 'NEEDS_CLARIFICATION' | 'HIGH_RISK' | 'FAILED';

export interface TaskResult {
  status: TaskStatus;
  facts?: Record<string, unknown>;
  evidence?: Record<string, unknown>[];
  errorCode?: string | null;
  blocking: boolean;
}

export interface Task {
  id: string;
  userTurnId: string;
  intent: string;
  riskLevel: RiskLevel;
  requiredContext: string[];
  requiredKnowledge?: string[];
  requiredTools?: string[];
  ownerWorkflowRunId?: string | null;
  status: TaskStatus;
  result?: TaskResult | null;
  blocking: boolean;
}

export interface TaskBundle {
  id: string;
  userTurnId: string;
  status: TaskBundleStatus;
  tasks: Task[];
  /** The planner hard cap is four; omitted by compact server projections. */
  maxTasks?: 4;
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
}

export type ContextResolutionStatus = 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND' | 'STALE';

export interface ContextCandidate {
  id: string;
  label?: string;
  type: 'PRODUCT' | 'SKU' | 'ORDER';
  metadata?: Record<string, unknown>;
}

export interface ClarificationBundle {
  id?: string;
  round: number;
  maxRounds?: 2;
  question: string;
  candidates: ContextCandidate[];
}

export interface ContextResolution {
  status: ContextResolutionStatus;
  entityType?: 'PRODUCT' | 'SKU' | 'ORDER';
  entityId?: string | null;
  candidates: ContextCandidate[];
  clarification?: ClarificationBundle | null;
  contextVersion?: number;
}

export type ReplyPolicyDecision = 'AUTO' | 'ASSIST' | 'MANUAL';

export interface ReplyPolicyResult {
  decision: ReplyPolicyDecision;
  reasons: string[];
  shopMode?: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY';
  conversationOverride?: ConversationMode | null;
  humanActive: boolean;
  degraded: boolean;
}

export interface ConversationModeCommand {
  /** Shop scope is carried in the command body for conversation controls. */
  shopId: string;
  mode: ConversationMode;
}

export interface ConversationMessageCommand {
  /** Shop scope is carried in the command body for human finals. */
  shopId: string;
  text: string;
  sourceDraftId?: string;
  editType?: ReplyDraftEditType;
}

/** Bare control response returned by the current command endpoints. */
export interface ConversationControlResult {
  id: string;
  overrideMode?: ConversationMode | null;
  humanActive?: boolean;
  resumed?: boolean;
}

/** Durable Human Final acceptance; the visible Message arrives later by snapshot/event. */
export interface HumanFinalAccepted {
  sendOutboxId: string;
  candidateId?: string;
  status?: 'ACCEPTED' | 'QUEUED';
}

export interface CustomerMemoryInput {
  shopId: string;
  type: 'PREFERENCE' | 'PRODUCT_PREFERENCE' | 'ONGOING_CASE';
  key: string;
  value: Record<string, unknown>;
  expiresAt?: IsoDateTime;
}

export type CustomerMemoryStatus = 'ACTIVE' | 'DISABLED' | 'DELETED';

export interface CustomerMemory extends CustomerMemoryInput {
  id: string;
  workspaceId?: string;
  tenantId?: string;
  buyerId: string;
  status: CustomerMemoryStatus;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
}

export interface CustomerMemoryDisableCommand {
  /** Shop scope is required even for a state-only mutation. */
  shopId: string;
  reason?: string;
}

/** Minimal response allowed from a disable mutation; clients merge it into the loaded card. */
export interface CustomerMemoryStatusResult {
  id: string;
  status: CustomerMemoryStatus;
}

export type CustomerMemoryType = CustomerMemoryInput['type'];
export type ReplyDraftEditKind = ReplyDraftEditType;
export type ReplyDecision = ReplyPolicyDecision;

export interface ReplyJobStream {
  replyJobId: string;
  conversationId?: string;
  chunk: string;
  sequence: number;
  draft?: Partial<ReplyDraft>;
}

export interface ReplyJobEventPayload {
  conversationId: string;
  replyJob?: ReplyJob;
  draft?: ReplyDraft | null;
  reason?: string;
}

export interface ReplySentPayload {
  conversationId: string;
  replyJobId?: string;
  sendOutboxId?: string;
  message?: Message;
  receipt?: SendReceipt;
}
