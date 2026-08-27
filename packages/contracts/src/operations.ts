/** Durable command acceptance returned by an asynchronous V1 mutation. */
export type OperationAcceptedStatus = 'ACCEPTED' | 'QUEUED';

export interface OperationAccepted {
  operationId: string;
  status: OperationAcceptedStatus;
}

export function isOperationAccepted(value: unknown): value is OperationAccepted {
  if (!plainObject(value)) return false;
  return typeof value.operationId === 'string'
    && value.operationId.length > 0
    && (value.status === 'ACCEPTED' || value.status === 'QUEUED');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
