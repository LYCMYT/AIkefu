import { evaluateSendGuard } from '../src';

describe('SendGuard', () => {
  const current = {
    lastMessageId: 'message-9', lastSequence: 9, contextVersion: 5,
    humanActive: false, conversationState: 'ACTIVE' as const, idempotencyKey: 'send:reply-a',
  };

  it.each([
    [{ ...current, expectedLastMessageId: 'message-8' }, 'SEND_CONFLICT'],
    [{ ...current, expectedSequence: 8 }, 'SEND_CONFLICT'],
    [{ ...current, expectedContextVersion: 4 }, 'CONTEXT_STALE'],
    [{ ...current, humanActive: true }, 'HUMAN_ACTIVE'],
    [{ ...current, duplicate: true }, 'DUPLICATE_ACTION'],
  ] as const)('blocks stale/duplicate send precondition: %s', (input, failureCode) => {
    expect(evaluateSendGuard(input)).toMatchObject({ allowed: false, failureCode, idempotencyKey: 'send:reply-a' });
  });

  it('blocks closed conversations and forbidden output, but allows a matching complete precondition set', () => {
    expect(evaluateSendGuard({ ...current, conversationState: 'CLOSED' })).toMatchObject({
      allowed: false, failureCode: 'CONVERSATION_CLOSED',
    });
    expect(evaluateSendGuard({ ...current, forbiddenTermBlocked: true })).toMatchObject({
      allowed: false, failureCode: 'FORBIDDEN_TERM',
    });
    expect(evaluateSendGuard({ ...current, expectedLastMessageId: 'message-9', expectedSequence: 9, expectedContextVersion: 5 }))
      .toEqual({ allowed: true, idempotencyKey: 'send:reply-a' });
  });
});
