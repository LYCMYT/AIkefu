/** Public DTO and command types shared by all browser API modules. */

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

export interface WorkspaceResetResult {
  operationId?: string;
  status: 'ACCEPTED' | 'QUEUED' | 'READY';
  counts?: SeedCounts;
}

export interface ForbiddenTermRule {
  term: string;
  replacement: string;
}

export interface ShopSettings {
  shopId?: string;
  tone: string;
  logisticsPolicy: string;
  shippingPolicy: string;
  afterSalesPolicy: string;
  welcomeMessage: string;
  closingMessages: Record<string, string>;
  transferKeywords: string[];
  forbiddenTerms: ForbiddenTermRule[];
  settingsConfirmed?: boolean;
  settingsConfirmedAt?: string | null;
  updatedAt?: string;
}

export type ShopSettingsInput = Omit<ShopSettings, 'shopId' | 'settingsConfirmed' | 'settingsConfirmedAt' | 'updatedAt'>;

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
  userTurns?: Array<{
    id: string;
    sourceMessageIds: string[];
    normalizedText: string;
    firstSequence: number;
    lastSequence: number;
    generation: number;
    status?: string;
    createdAt: string;
    updatedAt?: string;
  }>;
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

export interface ExistingKnowledgeMatch {
  productId?: string | null;
  question: string;
  answer: string;
}

export interface KnowledgeFilters {
  shopId?: string;
  scope?: KnowledgeScope | 'ALL';
  sourceType?: string | 'ALL';
  businessStatus?: string | 'ALL';
  indexStatus?: string | 'ALL';
  query?: string;
}

export interface KnowledgeModerationFilters {
  shopId?: string;
  status?: string;
}

export interface ResolveKnowledgeConflictInput {
  shopId?: string;
  resolution: KnowledgeConflictResolution;
  customQuestion?: string;
  customAnswer?: string;
}

export interface ProductLearningInput {
  productIds?: string[];
  retryFailed?: boolean;
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

export type { BootstrapPayload, SeedCounts, ShopSummary };
