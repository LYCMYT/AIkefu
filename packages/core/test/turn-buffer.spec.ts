import {
  appendToTurnBuffer,
  createTurnBuffer,
  decideTurnFlush,
  recoverTurnBuffer,
} from '../src';

describe('TurnBuffer deadlines', () => {
  it('flushes after two seconds of idle time', () => {
    const buffer = createTurnBuffer({
      key: 'ws:shop:conversation',
      sequence: 10,
      now: 1_000,
    });

    expect(decideTurnFlush(buffer, { generation: 1, now: 2_999 })).toMatchObject({ kind: 'WAIT' });
    expect(decideTurnFlush(buffer, { generation: 1, now: 3_000 })).toMatchObject({
      kind: 'FLUSH_IDLE',
      flushAt: 3_000,
    });
  });

  it('resets the idle deadline and invalidates an old delayed job by generation', () => {
    const opened = createTurnBuffer({ key: 'ws:shop:conversation', sequence: 10, now: 0 });
    const appended = appendToTurnBuffer(opened, { sequence: 11, now: 1_500 });

    expect(appended.generation).toBe(2);
    expect(appended.idleDeadline).toBe(3_500);
    expect(decideTurnFlush(appended, { generation: 1, now: 2_000 })).toMatchObject({
      kind: 'STALE_GENERATION',
    });
    expect(decideTurnFlush(appended, { generation: 2, now: 3_500 })).toMatchObject({
      kind: 'FLUSH_IDLE',
    });
  });

  it('flushes at the five second hard deadline even while messages keep arriving', () => {
    let buffer = createTurnBuffer({ key: 'ws:shop:conversation', sequence: 1, now: 0 });
    buffer = appendToTurnBuffer(buffer, { sequence: 2, now: 1_500 });
    buffer = appendToTurnBuffer(buffer, { sequence: 3, now: 3_000 });
    buffer = appendToTurnBuffer(buffer, { sequence: 4, now: 4_900 });

    expect(buffer.idleDeadline).toBe(6_900);
    expect(buffer.hardDeadline).toBe(5_000);
    expect(decideTurnFlush(buffer, { generation: buffer.generation, now: 5_000 })).toMatchObject({
      kind: 'FLUSH_HARD_MAX',
      flushAt: 5_000,
    });
  });

  it('reschedules an unexpired buffer after restart and flushes an overdue one once', () => {
    const buffer = createTurnBuffer({ key: 'ws:shop:conversation', sequence: 1, now: 0 });

    expect(recoverTurnBuffer(buffer, 1_000)).toMatchObject({
      kind: 'RESCHEDULE',
      generation: 1,
      runAt: 2_000,
    });
    expect(recoverTurnBuffer(buffer, 2_000)).toMatchObject({
      kind: 'FLUSH_IDLE',
      generation: 1,
    });
  });
});
