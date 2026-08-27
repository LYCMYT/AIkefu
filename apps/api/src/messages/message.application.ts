import type {
  BuyerMessageCommand,
  BuyerOrderCardCommand,
  BuyerProductCardCommand,
  ConversationSnapshot,
  ConversationSummary,
} from '@ai-customer-service/contracts';
import type { WorkspaceEventEnvelope } from '@ai-customer-service/contracts';
import type { WorkspaceScope } from '../workspaces/workspace.repository';

export const MESSAGE_APPLICATION = Symbol('MESSAGE_APPLICATION');

export type BuyerView = {
  id: string;
  workspaceId: string;
  tenantId: string;
  displayName: string;
  avatar: string | null;
  tags: string[];
};

export type ProductView = {
  id: string;
  shopId: string;
  title: string;
  description: string;
  status: string;
  recommendable: boolean;
  skus: Array<{
    id: string;
    externalSkuId: string;
    attributes: Record<string, string>;
    price: number;
    inventory: number;
  }>;
};

export type OrderView = {
  id: string;
  shopId: string;
  buyerId: string;
  productId: string;
  externalOrderId: string;
  status: string;
  amount: number;
  orderedAt: string;
  shippedAt: string | null;
  logistics: Record<string, unknown> | null;
};

export type OperationAccepted = {
  operationId: string;
  status: 'ACCEPTED';
};

export type MessageEventPublisher = {
  publish(event: WorkspaceEventEnvelope<unknown>): void;
};

export interface MessageApplication {
  listBuyers(scope: WorkspaceScope, shopId?: string): Promise<BuyerView[]>;
  listProducts(scope: WorkspaceScope, shopId: string): Promise<ProductView[]>;
  listOrders(scope: WorkspaceScope, shopId: string, buyerId?: string): Promise<OrderView[]>;
  listConversations(scope: WorkspaceScope, shopId: string): Promise<ConversationSummary[]>;
  getConversation(scope: WorkspaceScope, conversationId: string): Promise<ConversationSnapshot>;
  sendMessage(scope: WorkspaceScope, input: BuyerMessageCommand): Promise<OperationAccepted>;
  sendProductCard(scope: WorkspaceScope, input: BuyerProductCardCommand): Promise<OperationAccepted>;
  sendOrderCard(scope: WorkspaceScope, input: BuyerOrderCardCommand): Promise<OperationAccepted>;
  editMessage(scope: WorkspaceScope, messageId: string, text: string): Promise<OperationAccepted>;
  recallMessage(scope: WorkspaceScope, messageId: string): Promise<OperationAccepted>;
}
