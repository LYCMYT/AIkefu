import type { IsoDateTime } from './workspace';
import type { Message } from './message';

export interface TraceEvent {
  id: string;
  workspaceId?: string;
  tenantId?: string;
  shopId?: string | null;
  conversationId?: string | null;
  replyJobId?: string | null;
  traceId: string;
  stage: string;
  /** Structured, redacted metadata only; never a prompt or private chain of thought. */
  payload: Record<string, unknown>;
  createdAt: IsoDateTime;
}

export interface DeveloperTrace {
  traceId: string;
  workspaceId?: string;
  conversationId?: string;
  replyId?: string;
  events: TraceEvent[];
  rawMessages?: Message[];
  userTurn?: Record<string, unknown>;
  taskBundle?: Record<string, unknown>;
  contextResolver?: Record<string, unknown>;
  factContext?: Record<string, unknown>;
  evidence?: Record<string, unknown>[];
  replyPolicy?: Record<string, unknown>;
  workflow?: Record<string, unknown>;
  sendGuard?: Record<string, unknown>;
  aiRuntime?: Record<string, unknown>;
  quality?: Record<string, unknown>;
}

export function isTraceEvent(value: unknown): value is TraceEvent {
  if (!plainObject(value)
    || typeof value.id !== 'string'
    || typeof value.traceId !== 'string'
    || typeof value.stage !== 'string'
    || typeof value.createdAt !== 'string'
    || !plainObject(value.payload)) return false;
  return true;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
