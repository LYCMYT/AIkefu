import type { IsoDateTime } from './workspace';
import type { Conversation, TurnBuffer, UserTurn } from './conversation';
import type { Message } from './message';
import type { AiUsageEntry } from './ai';
import type { KnowledgeIndexStatus, KnowledgeItem, ProductLearningStatus } from './knowledge';
import type {
  ReplyDraft,
  ReplyJob,
  ReplyJobStream,
  ReplySentPayload,
  SendOutbox,
  TaskBundle,
} from './reliability';
import type { Scenario, ScenarioKey, ScenarioStatus } from './scenario';
import type { WorkflowRun, NodeRun } from './workflow';
import type { ActionProposal } from './incident';
import type { QualityReview } from './quality';
import type { ReplyIncident } from './incident';

export interface WorkspaceHeartbeatRequest {
  /** Reserved for future reconnect cursors without changing the event name. */
  lastEventId?: string;
}

export interface WorkspaceHeartbeatAck {
  workspaceId: string;
  occurredAt: IsoDateTime;
}

export type WorkspaceEventType =
  | 'MESSAGE_RECEIVED'
  | 'MESSAGE_EDITED'
  | 'MESSAGE_RECALLED'
  | 'CONVERSATION_UPDATED'
  | 'TURN_BUFFER_UPDATED'
  | 'USER_TURN_CREATED'
  | 'REPLY_JOB_STARTED'
  | 'REPLY_JOB_STREAM'
  | 'REPLY_JOB_WAITING_HUMAN'
  | 'REPLY_JOB_STALE'
  | 'REPLY_JOB_EXPIRED'
  | 'REPLY_SENT'
  | 'WORKFLOW_RUN_UPDATED'
  | 'WORKFLOW_NODE_UPDATED'
  | 'ACTION_PROPOSAL_UPDATED'
  | 'PRODUCT_UPDATED'
  | 'ORDER_UPDATED'
  | 'KNOWLEDGE_UPDATED'
  | 'QUALITY_REVIEW_UPDATED'
  | 'REPLY_INCIDENT_UPDATED'
  | 'SHOP_CONNECTION_CHANGED'
  | 'USAGE_UPDATED'
  | 'SCENARIO_UPDATED';

export type WorkspaceEventEntityType =
  | 'MESSAGE'
  | 'CONVERSATION'
  | 'TURN_BUFFER'
  | 'USER_TURN'
  | 'REPLY_JOB'
  | 'REPLY'
  | 'WORKFLOW_RUN'
  | 'WORKFLOW_NODE'
  | 'ACTION_PROPOSAL'
  | 'PRODUCT'
  | 'ORDER'
  | 'KNOWLEDGE'
  | 'QUALITY_REVIEW'
  | 'REPLY_INCIDENT'
  | 'SHOP'
  | 'USAGE'
  | 'SCENARIO';

/** Every pushed event is self-scoping and can be deduplicated by eventId. */
export interface WebSocketEventEnvelope<TPayload = Record<string, unknown>> {
  eventId: string;
  eventType: WorkspaceEventType;
  workspaceId: string;
  /** Known values are documented above; string keeps the envelope extensible. */
  entityType: WorkspaceEventEntityType | (string & {});
  entityId: string;
  entityVersion: number;
  occurredAt: IsoDateTime;
  payload: TPayload;
  requestId?: string;
}

export type WorkspaceEventEnvelope<TPayload = Record<string, unknown>> =
  WebSocketEventEnvelope<TPayload>;

export type WorkspaceHeartbeatResponse = WorkspaceHeartbeatAck;

export interface MessageReceivedPayload {
  conversationId: string;
  message: Message;
}

export interface MessageEditedPayload {
  conversationId: string;
  message: Message;
  previousVersion?: number;
}

export interface MessageRecalledPayload {
  conversationId: string;
  message: Message;
  contextInvalidationRequired: true;
}

/**
 * A conversation update either carries the canonical snapshot or explicitly
 * asks clients to refresh it. The latter is used by command/runtime paths
 * that do not have a projection in hand at emit time.
 */
export type ConversationUpdatedPayload =
  | {
      conversationId: string;
      conversation: Conversation;
    }
  | {
      conversationId: string;
      refresh: true;
    };

export interface TurnBufferUpdatedPayload {
  conversationId: string;
  turnBuffer: TurnBuffer | null;
}

export interface UserTurnCreatedPayload {
  conversationId: string;
  userTurn: UserTurn;
}

export interface ReplyJobStartedPayload {
  conversationId: string;
  replyJob: ReplyJob;
}

export interface ReplyJobStreamPayload extends ReplyJobStream {
  conversationId: string;
}

export interface ReplyJobWaitingHumanPayload {
  conversationId: string;
  replyJobId: string;
  draft: ReplyDraft;
}

export interface ReplyJobStalePayload {
  conversationId: string;
  replyJobId: string;
  reason?: string;
  contextVersion?: number;
}

export interface ReplyJobExpiredPayload {
  conversationId: string;
  replyJobId: string;
  draftId?: string;
  expiresAt?: IsoDateTime;
}

export interface ReplySentEventPayload extends ReplySentPayload {
  sendOutbox?: SendOutbox;
}

export interface TaskBundleUpdatedPayload {
  conversationId: string;
  taskBundle: TaskBundle;
}

export interface ShopConnectionChangedPayload {
  shopId: string;
  connectionState: Conversation['syncState'];
  reason?: string;
}

export interface ProductUpdatedPayload {
  shopId: string;
  productId: string;
  product?: Record<string, unknown>;
  learningStatus?: ProductLearningStatus;
}

export interface KnowledgeUpdatedPayload {
  shopId: string;
  knowledgeId: string;
  knowledge?: KnowledgeItem;
  businessStatus?: KnowledgeItem['businessStatus'];
  indexStatus?: KnowledgeIndexStatus;
}

export interface UsageUpdatedPayload {
  workspaceId?: string;
  usage?: AiUsageEntry | AiUsageEntry[];
  summary?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OrderUpdatedPayload {
  shopId: string;
  orderId: string;
  order?: Record<string, unknown>;
  contextVersion?: number;
}

export interface WorkflowRunUpdatedPayload {
  workflowRun: WorkflowRun;
}

export interface WorkflowNodeUpdatedPayload {
  workflowRunId: string;
  nodeRun: NodeRun;
}

export interface ActionProposalUpdatedPayload {
  proposal: ActionProposal;
}

export interface QualityReviewUpdatedPayload {
  review: QualityReview;
}

export interface ReplyIncidentUpdatedPayload {
  incident: ReplyIncident;
}

export interface ScenarioUpdatedPayload {
  scenarioKey: ScenarioKey;
  status: ScenarioStatus;
  step?: string;
  traceId?: string;
  scenario?: Scenario;
}

export interface WorkspaceEventPayloadMap {
  MESSAGE_RECEIVED: MessageReceivedPayload;
  MESSAGE_EDITED: MessageEditedPayload;
  MESSAGE_RECALLED: MessageRecalledPayload;
  CONVERSATION_UPDATED: ConversationUpdatedPayload;
  TURN_BUFFER_UPDATED: TurnBufferUpdatedPayload;
  USER_TURN_CREATED: UserTurnCreatedPayload;
  REPLY_JOB_STARTED: ReplyJobStartedPayload;
  REPLY_JOB_STREAM: ReplyJobStreamPayload;
  REPLY_JOB_WAITING_HUMAN: ReplyJobWaitingHumanPayload;
  REPLY_JOB_STALE: ReplyJobStalePayload;
  REPLY_JOB_EXPIRED: ReplyJobExpiredPayload;
  REPLY_SENT: ReplySentEventPayload;
  SHOP_CONNECTION_CHANGED: ShopConnectionChangedPayload;
  PRODUCT_UPDATED: ProductUpdatedPayload;
  ORDER_UPDATED: OrderUpdatedPayload;
  KNOWLEDGE_UPDATED: KnowledgeUpdatedPayload;
  USAGE_UPDATED: UsageUpdatedPayload;
  WORKFLOW_RUN_UPDATED: WorkflowRunUpdatedPayload;
  WORKFLOW_NODE_UPDATED: WorkflowNodeUpdatedPayload;
  ACTION_PROPOSAL_UPDATED: ActionProposalUpdatedPayload;
  QUALITY_REVIEW_UPDATED: QualityReviewUpdatedPayload;
  REPLY_INCIDENT_UPDATED: ReplyIncidentUpdatedPayload;
  SCENARIO_UPDATED: ScenarioUpdatedPayload;
}

/** A narrower envelope for the Phase 02 event families with stable payloads. */
export type TypedWorkspaceEventEnvelope<TType extends keyof WorkspaceEventPayloadMap> =
  Omit<WebSocketEventEnvelope<WorkspaceEventPayloadMap[TType]>, 'eventType'> & {
    eventType: TType;
  };
