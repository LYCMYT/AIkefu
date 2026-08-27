import {
  ReorderBuffer,
  type SequencedMessage,
} from '../src';

interface Message extends SequencedMessage {
  body: string;
}

const message = (sequence: number, externalMessageId = `m-${sequence}`): Message => ({
  sequence,
  externalMessageId,
  body: `message ${sequence}`,
});

describe('ReorderBuffer', () => {
  it('commits contiguous messages and drains a recovered future gap in sequence order', () => {
    const buffer = new ReorderBuffer<Message>({ now: () => 1_000 });

    expect(buffer.receive(message(1), 1_000)).toMatchObject({
      kind: 'CONTIGUOUS',
      committed: [message(1)],
      expectedSequence: 2,
    });
    expect(buffer.receive(message(3), 1_100)).toMatchObject({
      kind: 'FUTURE_GAP',
      expectedSequence: 2,
      gap: { receivedSequence: 3, deadlineAt: 2_100 },
    });

    const resolved = buffer.receive(message(2), 1_200);
    expect(resolved.kind).toBe('CONTIGUOUS');
    expect(resolved.committed.map((item) => item.sequence)).toEqual([2, 3]);
    expect(resolved.expectedSequence).toBe(4);
    expect(resolved.buffered).toEqual([]);
  });

  it('classifies repeated external ids or buffered sequences as duplicates', () => {
    const buffer = new ReorderBuffer<Message>();

    buffer.receive(message(1));
    expect(buffer.receive(message(1))).toMatchObject({ kind: 'DUPLICATE', expectedSequence: 2 });

    buffer.receive(message(3, 'future-a'));
    expect(buffer.receive(message(3, 'future-b'))).toMatchObject({
      kind: 'DUPLICATE',
      expectedSequence: 2,
    });
  });

  it('keeps an unseen sequence behind the committed cursor as a late message', () => {
    const buffer = new ReorderBuffer<Message>();
    buffer.receive(message(1));
    buffer.receive(message(2));

    const late = buffer.receive(message(1, 'late-original'));
    expect(late).toMatchObject({
      kind: 'LATE',
      expectedSequence: 3,
      late: { sequence: 1, contextInvalidationRequired: true },
    });
    expect(buffer.receive(message(1, 'late-original'))).toMatchObject({ kind: 'DUPLICATE' });
  });

  it('requests one reconciliation after a gap and degrades if it still cannot be closed', () => {
    const buffer = new ReorderBuffer<Message>({ gapWaitMs: 1_000, now: () => 0 });
    buffer.receive(message(1), 0);
    buffer.receive(message(3), 100);

    expect(buffer.onGapDeadline(1_099)).toMatchObject({ kind: 'WAITING_FOR_GAP' });
    expect(buffer.onGapDeadline(1_100)).toMatchObject({
      kind: 'RECONCILE',
      expectedSequence: 2,
      missingSequences: [2],
    });

    expect(buffer.completeReconciliation([], 1_101)).toMatchObject({
      kind: 'DEGRADED',
      expectedSequence: 2,
      missingSequences: [2],
    });
  });
});
