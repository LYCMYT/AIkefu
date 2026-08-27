import type { IsoDateTime } from './workspace';
import type { Message } from './message';
import type { CustomerMemory, ReplyDraft, ReplyJob, SendOutbox, TaskBundle } from './reliability';

export type ConversationState = 'ACTIVE' | 'CLOSING' | 'CLOSED';
export type ConversationMode = 'AUTO' | 'ASSIST' | 'MANUAL' | 'HOLD';
export type ConversationSyncState =
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'RECONCILING'
  | 'DEGRADED'
  | 'DISCONNECTED';

export interface Buyer {
  id: string;
  workspaceId: string;
  tenantId: string;
  externalBuyerId?: string;
  displayName: string;
  avatar?: string | null;
  /** Alias for API clients that use URL-oriented naming. */
  avatarUrl?: string | null;
  tags: string[];
}

export interface Conversation {
  id: string;
  workspaceId: string;
  tenantId: string;
  shopId: string;
  buyerId: string;
  externalConversationId: string;
  state: ConversationState;
  /** Current configured mode before the optional per-conversation override. */
  mode: ConversationMode;
  overrideMode?: ConversationMode | null;
  effectiveMode: ConversationMode;
  syncState: ConversationSyncState;
  contextVersion: number;
  lastCommittedSequence: number;
  activeTopic?: string | null;
  currentProductId?: string | null;
  currentOrderId?: string | null;
  humanActive: boolean;
  needsReplan: boolean;
  /** Current coalesced job; at most one active job per conversation. */
  activeReplyJobId?: string | null;
  activeReplyJob?: ReplyJob | null;
  currentDraft?: ReplyDraft | null;
  sendOutbox?: SendOutbox | null;
  idleExpiresAt?: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type TurnBufferStatus =
  | 'BUFFERING'
  | 'FLUSHING'
  | 'FLUSHED'
  | 'CANCELLED'
  | 'RECOVERY_PENDING';

export interface TurnBuffer {
  key: string;
  workspaceId: string;
  tenantId: string;
  shopId: string;
  conversationId: string;
  buyerId: string;
  firstSequence: number;
  latestSequence: number;
  openedAt: IsoDateTime;
  lastMessageAt: IsoDateTime;
  idleDeadline: IsoDateTime;
  hardDeadline: IsoDateTime;
  generation: number;
  status: TurnBufferStatus;
}

export type UserTurnStatus =
  | 'OPEN'
  | 'PLANNED'
  | 'RESOLVED'
  | 'SUPERSEDED'
  | 'CANCELLED'
  | 'FAILED';

export interface UserTurn {
  id: string;
  workspaceId: string;
  tenantId: string;
  shopId: string;
  conversationId: string;
  buyerId: string;
  firstSequence: number;
  latestSequence: number;
  /** Persisted source message ids, retained even after a ReplyJob is stale. */
  sourceMessageIds: string[];
  /** Optional UI-friendly alias for clients that do not expose the persistence name. */
  messageIds?: string[];
  normalizedText?: string;
  generation: number;
  status: UserTurnStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Compact projection used by the conversation snapshot and Workbench list. */
export interface UserTurnSummary {
  id: string;
  sourceMessageIds: string[];
  normalizedText: string;
  firstSequence: number;
  lastSequence: number;
  generation: number;
  status?: UserTurnStatus;
  createdAt: IsoDateTime;
  updatedAt?: IsoDateTime;
}

export interface ConversationSummary extends Conversation {
  buyer: Buyer;
  unreadCount: number;
  lastMessage?: Message;
}

export interface ConversationSnapshot extends ConversationSummary {
  messages: Message[];
  turnBuffer?: TurnBuffer | null;
  userTurns?: UserTurnSummary[];
  taskBundle?: TaskBundle | null;
  customerMemories?: CustomerMemory[];
  currentProduct?: Record<string, unknown> | null;
  currentOrder?: Record<string, unknown> | null;
  summary?: Record<string, unknown> | null;
}
