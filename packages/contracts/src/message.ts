import type { IsoDateTime } from './workspace';

/** Persisted sender role. The platform only creates BUYER messages in Phase 02. */
export type MessageRole = 'BUYER' | 'AI' | 'HUMAN' | 'SYSTEM';

/**
 * `GOODS_CARD` is the normalized persisted name used by the domain model.
 * Buyer Simulator calls it a product card at its command boundary.
 */
export type MessageKind = 'TEXT' | 'IMAGE' | 'GOODS_CARD' | 'ORDER_CARD' | 'SYSTEM';

export type MessageStatus = 'ACTIVE' | 'EDITED' | 'RECALLED' | 'DELETED';

export interface TextMessageContent {
  text: string;
}

export interface ImageMessageContent {
  attachmentId: string;
  altText?: string;
}

export interface ProductCardContent {
  productId?: string;
  externalProductId: string;
  title?: string;
  skuId?: string;
}

export interface OrderCardContent {
  orderId?: string;
  externalOrderId: string;
  status?: string;
}

export interface SystemMessageContent {
  code: string;
  text?: string;
}

export type MessageContent =
  | TextMessageContent
  | ImageMessageContent
  | ProductCardContent
  | OrderCardContent
  | SystemMessageContent
  | Record<string, unknown>;

export interface Message {
  id: string;
  workspaceId: string;
  tenantId: string;
  platform: 'DOUYIN_DEMO' | (string & {});
  shopId: string;
  conversationId: string;
  buyerId: string;
  externalMessageId: string;
  sequence: number;
  role: MessageRole;
  kind: MessageKind;
  status: MessageStatus;
  content: MessageContent;
  sentAt: IsoDateTime;
  receivedAt: IsoDateTime;
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
  /** Incremented for edit/recall projections when the caller needs a version cursor. */
  entityVersion?: number;
}

/** Input accepted by POST /api/buyer/messages. */
export interface BuyerMessageCommand {
  shopId: string;
  buyerId: string;
  conversationId?: string;
  kind: 'TEXT' | 'IMAGE';
  text?: string;
  attachmentId?: string;
  sentAt?: IsoDateTime;
  /** Demo-only input used to exercise reorder and gap handling. */
  forcedSequence?: number;
  /** Demo-only input used to exercise durable deduplication. */
  duplicateExternalMessageId?: string;
}

export interface BuyerProductCardCommand {
  shopId: string;
  buyerId: string;
  productId: string;
  conversationId?: string;
  sentAt?: IsoDateTime;
  forcedSequence?: number;
}

export interface BuyerOrderCardCommand {
  shopId: string;
  buyerId: string;
  orderId: string;
  conversationId?: string;
  sentAt?: IsoDateTime;
  forcedSequence?: number;
}

export interface BuyerMessageEditCommand {
  messageId: string;
  text: string;
  editedAt?: IsoDateTime;
}

export interface BuyerMessageRecallCommand {
  messageId: string;
  recalledAt?: IsoDateTime;
}

/** Explicit aliases keep REST/controller code readable without duplicating contracts. */
export type CreateBuyerMessageInput = BuyerMessageCommand;
export type CreateBuyerProductCardInput = BuyerProductCardCommand;
export type CreateBuyerOrderCardInput = BuyerOrderCardCommand;
export type EditBuyerMessageInput = BuyerMessageEditCommand;
export type RecallBuyerMessageInput = BuyerMessageRecallCommand;
