/** The smallest sequence-bearing shape required by the pure reorder domain. */
export interface SequencedMessage {
  sequence: number;
  externalMessageId: string;
}

export type ReorderDecisionKind = 'DUPLICATE' | 'CONTIGUOUS' | 'FUTURE_GAP' | 'LATE';

export interface ReorderGap {
  expectedSequence: number;
  receivedSequence: number;
  openedAt: number;
  deadlineAt: number;
}

export interface LateMessageNotice {
  sequence: number;
  /** A late message must invalidate derived context and unsent work. */
  contextInvalidationRequired: true;
}

export interface ReorderDecision<T extends SequencedMessage> {
  kind: ReorderDecisionKind;
  expectedSequence: number;
  committed: readonly T[];
  buffered: readonly T[];
  gap?: ReorderGap;
  late?: LateMessageNotice;
}

export interface ReorderBufferSnapshot<T extends SequencedMessage> {
  lastCommittedSequence: number;
  buffered: readonly T[];
  gapOpenedAt?: number;
  reconciliationAttempted?: boolean;
}

export interface ReorderBufferOptions {
  /** The frozen design waits one second before performing a single reconciliation. */
  gapWaitMs?: number;
  now?: () => number;
  /**
   * Usually populated from durable message deduplication on recovery. The
   * in-memory buffer also remembers ids received during its own lifetime.
   */
  knownExternalMessageIds?: Iterable<string>;
}

export type ReorderGapDecision =
  | { kind: 'NO_GAP'; expectedSequence: number }
  | { kind: 'WAITING_FOR_GAP'; expectedSequence: number; deadlineAt: number; missingSequences: number[] }
  | { kind: 'RECONCILE'; expectedSequence: number; deadlineAt: number; missingSequences: number[] }
  | { kind: 'AWAITING_RECONCILIATION'; expectedSequence: number; missingSequences: number[] }
  | { kind: 'RESOLVED'; expectedSequence: number; committed: readonly SequencedMessage[] }
  | { kind: 'DEGRADED'; expectedSequence: number; missingSequences: number[] };

const DEFAULT_GAP_WAIT_MS = 1_000;
const MAX_REPORTED_MISSING_SEQUENCES = 1_000;

/**
 * A deliberately storage-agnostic, per-conversation reorder buffer.
 *
 * It only decides what is contiguous, future, duplicate, or late. The caller
 * owns persistence, durable deduplication and the actual reconciliation I/O.
 */
export class ReorderBuffer<T extends SequencedMessage> {
  private readonly bufferedBySequence = new Map<number, T>();
  private readonly seenExternalMessageIds = new Set<string>();
  private readonly gapWaitMs: number;
  private readonly now: () => number;
  private lastCommittedSequence: number;
  private gapOpenedAt?: number;
  private reconciliationAttempted: boolean;

  constructor(options: ReorderBufferOptions = {}, snapshot?: ReorderBufferSnapshot<T>) {
    this.gapWaitMs = validatePositiveDuration(options.gapWaitMs ?? DEFAULT_GAP_WAIT_MS, 'gapWaitMs');
    this.now = options.now ?? Date.now;
    this.lastCommittedSequence = snapshot?.lastCommittedSequence ?? 0;
    validateSequence(this.lastCommittedSequence, 'lastCommittedSequence', true);
    this.gapOpenedAt = snapshot?.gapOpenedAt;
    this.reconciliationAttempted = snapshot?.reconciliationAttempted ?? false;

    for (const id of options.knownExternalMessageIds ?? []) {
      this.seenExternalMessageIds.add(validateExternalMessageId(id));
    }
    for (const message of snapshot?.buffered ?? []) {
      this.assertMessage(message);
      if (message.sequence <= this.lastCommittedSequence || this.bufferedBySequence.has(message.sequence)) {
        throw new RangeError('Invalid reorder snapshot: buffered sequence is not unique and future');
      }
      this.bufferedBySequence.set(message.sequence, message);
      this.seenExternalMessageIds.add(message.externalMessageId);
    }
    if (this.bufferedBySequence.size > 0 && this.gapOpenedAt === undefined) {
      this.gapOpenedAt = this.now();
    }
  }

  get expectedSequence(): number {
    return this.lastCommittedSequence + 1;
  }

  get snapshot(): ReorderBufferSnapshot<T> {
    return {
      lastCommittedSequence: this.lastCommittedSequence,
      buffered: this.buffered(),
      ...(this.gapOpenedAt === undefined ? {} : { gapOpenedAt: this.gapOpenedAt }),
      ...(this.reconciliationAttempted ? { reconciliationAttempted: true } : {}),
    };
  }

  receive(message: T, receivedAt = this.now()): ReorderDecision<T> {
    this.assertMessage(message);
    validateTimestamp(receivedAt, 'receivedAt');

    if (this.seenExternalMessageIds.has(message.externalMessageId)) {
      return this.decision('DUPLICATE');
    }

    if (this.bufferedBySequence.has(message.sequence)) {
      // Different platform ids for the same sequence are still not safe to
      // commit twice; durable reconciliation can surface the conflict later.
      this.seenExternalMessageIds.add(message.externalMessageId);
      return this.decision('DUPLICATE');
    }

    this.seenExternalMessageIds.add(message.externalMessageId);
    if (message.sequence <= this.lastCommittedSequence) {
      return this.decision('LATE', { late: { sequence: message.sequence, contextInvalidationRequired: true } });
    }

    if (message.sequence > this.expectedSequence) {
      this.bufferedBySequence.set(message.sequence, message);
      this.openGap(receivedAt);
      return this.decision('FUTURE_GAP', {
        gap: {
          expectedSequence: this.expectedSequence,
          receivedSequence: message.sequence,
          openedAt: this.gapOpenedAt!,
          deadlineAt: this.gapOpenedAt! + this.gapWaitMs,
        },
      });
    }

    const committed = this.commitContiguous(message, receivedAt);
    return this.decision('CONTIGUOUS', { committed });
  }

  /** Returns the one-shot action to take when the future-gap timer runs. */
  onGapDeadline(now = this.now()): ReorderGapDecision {
    validateTimestamp(now, 'now');
    if (this.bufferedBySequence.size === 0 || this.gapOpenedAt === undefined) {
      return { kind: 'NO_GAP', expectedSequence: this.expectedSequence };
    }

    const deadlineAt = this.gapOpenedAt + this.gapWaitMs;
    const missingSequences = this.missingSequences();
    if (now < deadlineAt) {
      return { kind: 'WAITING_FOR_GAP', expectedSequence: this.expectedSequence, deadlineAt, missingSequences };
    }
    if (this.reconciliationAttempted) {
      return { kind: 'AWAITING_RECONCILIATION', expectedSequence: this.expectedSequence, missingSequences };
    }

    this.reconciliationAttempted = true;
    return { kind: 'RECONCILE', expectedSequence: this.expectedSequence, deadlineAt, missingSequences };
  }

  /**
   * Feed the result of the single history reconciliation back into the buffer.
   * A remaining gap is precisely the condition that makes a conversation
   * DEGRADED and therefore ineligible for AUTO mode.
   */
  completeReconciliation(messages: readonly T[], receivedAt = this.now()): ReorderGapDecision {
    validateTimestamp(receivedAt, 'receivedAt');
    const committed: T[] = [];
    for (const message of [...messages].sort((left, right) => left.sequence - right.sequence)) {
      const result = this.receive(message, receivedAt);
      committed.push(...result.committed);
    }

    if (this.bufferedBySequence.size === 0) {
      return { kind: 'RESOLVED', expectedSequence: this.expectedSequence, committed };
    }
    return { kind: 'DEGRADED', expectedSequence: this.expectedSequence, missingSequences: this.missingSequences() };
  }

  private commitContiguous(message: T, receivedAt: number): T[] {
    const committed: T[] = [message];
    this.lastCommittedSequence = message.sequence;
    while (this.bufferedBySequence.has(this.expectedSequence)) {
      const next = this.bufferedBySequence.get(this.expectedSequence)!;
      this.bufferedBySequence.delete(next.sequence);
      this.lastCommittedSequence = next.sequence;
      committed.push(next);
    }

    if (this.bufferedBySequence.size === 0) {
      this.gapOpenedAt = undefined;
      this.reconciliationAttempted = false;
    } else {
      // Example: receiving 102 while 104 is buffered opens a new 103 gap.
      this.gapOpenedAt = receivedAt;
      this.reconciliationAttempted = false;
    }
    return committed;
  }

  private decision(
    kind: ReorderDecisionKind,
    details: Partial<Pick<ReorderDecision<T>, 'committed' | 'gap' | 'late'>> = {},
  ): ReorderDecision<T> {
    return {
      kind,
      expectedSequence: this.expectedSequence,
      committed: details.committed ?? [],
      buffered: this.buffered(),
      ...(details.gap ? { gap: details.gap } : {}),
      ...(details.late ? { late: details.late } : {}),
    };
  }

  private buffered(): T[] {
    return [...this.bufferedBySequence.values()].sort((left, right) => left.sequence - right.sequence);
  }

  private openGap(receivedAt: number): void {
    if (this.gapOpenedAt === undefined) {
      this.gapOpenedAt = receivedAt;
      this.reconciliationAttempted = false;
    }
  }

  private missingSequences(): number[] {
    const firstBuffered = this.buffered()[0];
    if (!firstBuffered || firstBuffered.sequence <= this.expectedSequence) return [];
    const count = Math.min(firstBuffered.sequence - this.expectedSequence, MAX_REPORTED_MISSING_SEQUENCES);
    return Array.from({ length: count }, (_, offset) => this.expectedSequence + offset);
  }

  private assertMessage(message: T): void {
    validateSequence(message.sequence, 'message.sequence');
    validateExternalMessageId(message.externalMessageId);
  }
}

function validateSequence(value: number, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
  return value;
}

function validateExternalMessageId(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('externalMessageId must be a non-empty string');
  }
  return value;
}

function validateTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite timestamp`);
  return value;
}

function validatePositiveDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive duration`);
  return value;
}
