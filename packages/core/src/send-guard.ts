export type SendGuardFailureCode =
  | 'SEND_CONFLICT'
  | 'HUMAN_ACTIVE'
  | 'CONTEXT_STALE'
  | 'DUPLICATE_ACTION'
  | 'FORBIDDEN_TERM'
  | 'CONVERSATION_CLOSED';

export interface SendGuardInput {
  lastMessageId?: string | null;
  lastSequence: number;
  contextVersion: number;
  humanActive: boolean;
  conversationState: 'ACTIVE' | 'CLOSING' | 'CLOSED';
  idempotencyKey: string;
  expectedLastMessageId?: string | null;
  expectedSequence?: number | null;
  expectedContextVersion?: number | null;
  duplicate?: boolean;
  forbiddenTermBlocked?: boolean;
}

export type SendGuardResult =
  | { allowed: true; idempotencyKey: string }
  | { allowed: false; idempotencyKey: string; failureCode: SendGuardFailureCode };

/** Pure, ordered fail-closed check used immediately before an adapter send. */
export function evaluateSendGuard(input: SendGuardInput): SendGuardResult {
  const deny = (failureCode: SendGuardFailureCode): SendGuardResult => ({
    allowed: false,
    idempotencyKey: input.idempotencyKey,
    failureCode,
  });
  if (!input.idempotencyKey.trim() || input.duplicate) return deny('DUPLICATE_ACTION');
  if (input.conversationState !== 'ACTIVE') return deny('CONVERSATION_CLOSED');
  if (input.humanActive) return deny('HUMAN_ACTIVE');
  if (input.forbiddenTermBlocked) return deny('FORBIDDEN_TERM');
  if (input.expectedContextVersion !== undefined && input.expectedContextVersion !== null
    && input.expectedContextVersion !== input.contextVersion) return deny('CONTEXT_STALE');
  if ((input.expectedLastMessageId !== undefined && input.expectedLastMessageId !== input.lastMessageId)
    || (input.expectedSequence !== undefined && input.expectedSequence !== null && input.expectedSequence !== input.lastSequence)) {
    return deny('SEND_CONFLICT');
  }
  return { allowed: true, idempotencyKey: input.idempotencyKey };
}
