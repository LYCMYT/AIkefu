import { buildReply, checkForbiddenTerms, selectReplyStrategy } from '../src';

describe('Reply Strategy', () => {
  const lowResolved = {
    id: 'task-a', intent: 'SHIPPING_POLICY_QUERY', operation: 'READ' as const, riskLevel: 'LOW' as const,
    requiredContext: [], requiredTools: [], blocking: false, status: 'RESOLVED' as const,
    facts: { reply: '现货商品通常 48 小时内发货。' },
  };

  it('uses Fast Path only for one low-risk resolved fact and never invokes the composer', async () => {
    const composer = jest.fn();
    expect(selectReplyStrategy({ tasks: [lowResolved] })).toBe('FAST_PATH');
    await expect(buildReply({ tasks: [lowResolved] }, { compose: composer })).resolves.toEqual({
      strategy: 'FAST_PATH', text: '现货商品通常 48 小时内发货。',
    });
    expect(composer).not.toHaveBeenCalled();
  });

  it('uses the composer for multi-task or non-low-risk work and returns exactly one complete reply', async () => {
    const composer = jest.fn().mockResolvedValue('商品现货，尺码建议稍后由人工确认。');
    const tasks = [
      lowResolved,
      { ...lowResolved, id: 'task-b', intent: 'SIZE_RECOMMENDATION', riskLevel: 'MEDIUM' as const },
    ];
    expect(selectReplyStrategy({ tasks })).toBe('COMPOSER');
    await expect(buildReply({ tasks }, { compose: composer })).resolves.toEqual({
      strategy: 'COMPOSER', text: '商品现货，尺码建议稍后由人工确认。',
    });
    expect(composer).toHaveBeenCalledTimes(1);
  });

  it('applies configured forbidden-term replacements and blocks terms without a safe replacement', () => {
    expect(checkForbiddenTerms('我们绝对不会掉色。', [{ term: '绝对', replacement: '尽量' }])).toEqual({
      allowed: true, text: '我们尽量不会掉色。', violations: ['绝对'],
    });
    expect(checkForbiddenTerms('保证明天送达。', [{ term: '保证', replacement: '' }])).toEqual({
      allowed: false, text: '保证明天送达。', violations: ['保证'],
    });
  });
});
