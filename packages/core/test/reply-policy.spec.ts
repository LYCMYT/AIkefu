import { decideReplyPolicy } from '../src';

describe('ReplyPolicy', () => {
  const automatic = {
    shopMode: 'AUTO_ALLOWED' as const,
    syncState: 'CONNECTED' as const,
    humanActive: false,
    taskRisks: ['LOW' as const],
    contextStatus: 'RESOLVED' as const,
    contextManualRequired: false,
    hasEvidence: true,
    hasBlockingFailure: false,
    userRequestedHuman: false,
  };

  it('permits AUTO only for complete, evidenced low-risk work', () => {
    expect(decideReplyPolicy(automatic)).toMatchObject({ mode: 'AUTO' });
    expect(decideReplyPolicy({ ...automatic, hasEvidence: false })).toMatchObject({ mode: 'ASSIST' });
  });

  it('applies shop mode and conversation override solely as conservative ceilings', () => {
    expect(decideReplyPolicy({ ...automatic, shopMode: 'ASSIST_ONLY', conversationOverride: 'AUTO' })).toMatchObject({ mode: 'ASSIST' });
    expect(decideReplyPolicy({ ...automatic, conversationOverride: 'MANUAL' })).toMatchObject({ mode: 'MANUAL' });
    expect(decideReplyPolicy({ ...automatic, shopMode: 'MANUAL_ONLY', conversationOverride: 'AUTO' })).toMatchObject({ mode: 'MANUAL' });
  });

  it('requires MANUAL for degraded/disconnected, human-active, and high-risk work', () => {
    expect(decideReplyPolicy({ ...automatic, syncState: 'DEGRADED' })).toMatchObject({ mode: 'MANUAL' });
    expect(decideReplyPolicy({ ...automatic, humanActive: true })).toMatchObject({ mode: 'MANUAL' });
    expect(decideReplyPolicy({ ...automatic, syncState: 'DISCONNECTED' })).toMatchObject({ mode: 'MANUAL' });
    expect(decideReplyPolicy({ ...automatic, taskRisks: ['HIGH'] })).toMatchObject({ mode: 'MANUAL' });
    expect(decideReplyPolicy({ ...automatic, hasBlockingFailure: true })).toMatchObject({ mode: 'ASSIST' });
    expect(decideReplyPolicy({ ...automatic, hasPartialFailure: true })).toMatchObject({
      mode: 'ASSIST', reasons: expect.arrayContaining(['PARTIAL_TASK_RESULT']),
    });
  });

  it('keeps early ambiguity in ASSIST but requires MANUAL after the resolver exhausts two rounds', () => {
    expect(decideReplyPolicy({ ...automatic, contextStatus: 'AMBIGUOUS' })).toMatchObject({ mode: 'ASSIST' });
    expect(decideReplyPolicy({ ...automatic, contextStatus: 'AMBIGUOUS', contextManualRequired: true })).toMatchObject({
      mode: 'MANUAL',
    });
  });
});
