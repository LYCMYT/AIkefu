/**
 * Synthetic dynamic-fact commands used by Scenario Lab and the demo adapter.
 * These are intentionally narrower than a production platform order model.
 */
export type DynamicFactOrderStatus = 'WAITING_SHIPMENT' | 'SHIPPED' | 'COMPLETED';

export interface DynamicFactInventoryCommand {
  inventory: number;
}

export interface DynamicFactOrderStatusCommand {
  status: DynamicFactOrderStatus;
}

/** Both mock-only mutation endpoints acknowledge work asynchronously. */
export interface DynamicFactMutationAccepted {
  status: 'ACCEPTED';
  operationId: string;
}
