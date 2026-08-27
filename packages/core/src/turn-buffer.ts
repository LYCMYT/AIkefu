export const TURN_IDLE_WINDOW_MS = 2_000;
export const TURN_HARD_MAX_WINDOW_MS = 5_000;

export type TurnBufferStatus =
  | 'BUFFERING'
  | 'FLUSHING'
  | 'FLUSHED'
  | 'CANCELLED'
  | 'RECOVERY_PENDING';

export interface TurnBufferState {
  key: string;
  firstSequence: number;
  latestSequence: number;
  openedAt: number;
  lastMessageAt: number;
  idleDeadline: number;
  hardDeadline: number;
  generation: number;
  status: TurnBufferStatus;
}

export interface CreateTurnBufferInput {
  key: string;
  sequence: number;
  now: number;
  idleWindowMs?: number;
  hardMaxWindowMs?: number;
}

export interface AppendTurnBufferInput {
  sequence: number;
  now: number;
  idleWindowMs?: number;
}

export interface TurnFlushInput {
  generation: number;
  now: number;
}

export type TurnFlushDecision =
  | { kind: 'STALE_GENERATION'; generation: number; currentGeneration: number }
  | { kind: 'NOT_BUFFERING'; status: TurnBufferStatus; generation: number }
  | { kind: 'WAIT'; generation: number; runAt: number }
  | { kind: 'FLUSH_IDLE'; generation: number; flushAt: number }
  | { kind: 'FLUSH_HARD_MAX'; generation: number; flushAt: number };

export type TurnRecoveryDecision =
  | { kind: 'NOT_BUFFERING'; status: TurnBufferStatus; generation: number }
  | { kind: 'RESCHEDULE'; generation: number; runAt: number }
  | { kind: 'FLUSH_IDLE'; generation: number; flushAt: number }
  | { kind: 'FLUSH_HARD_MAX'; generation: number; flushAt: number };

/** Opens a durable turn buffer with the Phase 02 idle/hard deadlines. */
export function createTurnBuffer(input: CreateTurnBufferInput): TurnBufferState {
  validateKey(input.key);
  validatePositiveInteger(input.sequence, 'sequence');
  validateTimestamp(input.now, 'now');
  const idleWindowMs = validatePositiveDuration(input.idleWindowMs ?? TURN_IDLE_WINDOW_MS, 'idleWindowMs');
  const hardMaxWindowMs = validatePositiveDuration(
    input.hardMaxWindowMs ?? TURN_HARD_MAX_WINDOW_MS,
    'hardMaxWindowMs',
  );
  if (hardMaxWindowMs < idleWindowMs) {
    throw new RangeError('hardMaxWindowMs must be greater than or equal to idleWindowMs');
  }

  return {
    key: input.key,
    firstSequence: input.sequence,
    latestSequence: input.sequence,
    openedAt: input.now,
    lastMessageAt: input.now,
    idleDeadline: input.now + idleWindowMs,
    hardDeadline: input.now + hardMaxWindowMs,
    generation: 1,
    status: 'BUFFERING',
  };
}

/**
 * Appending always increments generation so delayed jobs scheduled before the
 * append are harmless no-ops. The hard deadline intentionally never moves.
 */
export function appendToTurnBuffer(
  state: TurnBufferState,
  input: AppendTurnBufferInput,
): TurnBufferState {
  assertBuffering(state);
  validatePositiveInteger(input.sequence, 'sequence');
  validateTimestamp(input.now, 'now');
  if (input.sequence < state.latestSequence) {
    throw new RangeError('sequence cannot move backwards inside a turn buffer');
  }
  if (input.now < state.openedAt) {
    throw new RangeError('now cannot precede the turn buffer opening time');
  }

  const idleWindowMs = validatePositiveDuration(input.idleWindowMs ?? TURN_IDLE_WINDOW_MS, 'idleWindowMs');
  return {
    ...state,
    latestSequence: input.sequence,
    lastMessageAt: input.now,
    idleDeadline: input.now + idleWindowMs,
    generation: state.generation + 1,
  };
}

export function nextTurnFlushAt(state: TurnBufferState): number {
  return Math.min(state.idleDeadline, state.hardDeadline);
}

/** Pure delayed-job decision. It does not claim or persist a flush. */
export function decideTurnFlush(state: TurnBufferState, input: TurnFlushInput): TurnFlushDecision {
  validatePositiveInteger(input.generation, 'generation');
  validateTimestamp(input.now, 'now');
  if (input.generation !== state.generation) {
    return { kind: 'STALE_GENERATION', generation: input.generation, currentGeneration: state.generation };
  }
  if (state.status !== 'BUFFERING') {
    return { kind: 'NOT_BUFFERING', status: state.status, generation: state.generation };
  }
  if (input.now >= state.hardDeadline) {
    return { kind: 'FLUSH_HARD_MAX', generation: state.generation, flushAt: state.hardDeadline };
  }
  if (input.now >= state.idleDeadline) {
    return { kind: 'FLUSH_IDLE', generation: state.generation, flushAt: state.idleDeadline };
  }
  return { kind: 'WAIT', generation: state.generation, runAt: nextTurnFlushAt(state) };
}

/** Restart-safe scheduling decision for a row that was BUFFERING at shutdown. */
export function recoverTurnBuffer(state: TurnBufferState, now: number): TurnRecoveryDecision {
  validateTimestamp(now, 'now');
  if (state.status !== 'BUFFERING' && state.status !== 'RECOVERY_PENDING') {
    return { kind: 'NOT_BUFFERING', status: state.status, generation: state.generation };
  }

  const recoverable = state.status === 'RECOVERY_PENDING' ? { ...state, status: 'BUFFERING' as const } : state;
  const decision = decideTurnFlush(recoverable, { generation: recoverable.generation, now });
  if (decision.kind === 'WAIT') {
    return { kind: 'RESCHEDULE', generation: decision.generation, runAt: decision.runAt };
  }
  if (decision.kind === 'FLUSH_IDLE' || decision.kind === 'FLUSH_HARD_MAX') return decision;
  // Generation cannot be stale because this function supplies the row's own generation.
  return { kind: 'NOT_BUFFERING', status: state.status, generation: state.generation };
}

export function markTurnBufferFlushing(state: TurnBufferState, generation: number): TurnBufferState {
  if (state.status !== 'BUFFERING' || generation !== state.generation) return state;
  return { ...state, status: 'FLUSHING' };
}

export function markTurnBufferFlushed(state: TurnBufferState): TurnBufferState {
  if (state.status !== 'FLUSHING') return state;
  return { ...state, status: 'FLUSHED' };
}

function assertBuffering(state: TurnBufferState): void {
  validateKey(state.key);
  validatePositiveInteger(state.firstSequence, 'firstSequence');
  validatePositiveInteger(state.latestSequence, 'latestSequence');
  validatePositiveInteger(state.generation, 'generation');
  validateTimestamp(state.openedAt, 'openedAt');
  validateTimestamp(state.lastMessageAt, 'lastMessageAt');
  validateTimestamp(state.idleDeadline, 'idleDeadline');
  validateTimestamp(state.hardDeadline, 'hardDeadline');
  if (state.status !== 'BUFFERING') throw new Error(`Turn buffer is ${state.status}, not BUFFERING`);
}

function validateKey(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('key must be a non-empty string');
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
}

function validateTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite timestamp`);
}

function validatePositiveDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive duration`);
  return value;
}
