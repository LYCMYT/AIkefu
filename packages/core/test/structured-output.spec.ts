import { validateStructuredOutput } from '../src/structured-output';

describe('frozen structured output schemas', () => {
  it('accepts a bounded IntentPlan and rejects unknown fields or more than four tasks', () => {
    const task = {
      intent: 'PRODUCT_QUERY',
      riskLevel: 'LOW',
      requiredContext: ['PRODUCT'],
      requiredTools: ['GET_PRODUCT'],
    };
    expect(validateStructuredOutput('IntentPlan', { tasks: [task], summary: '商品咨询' })).toBe(true);
    expect(validateStructuredOutput('IntentPlan', { tasks: [task], prompt: 'leak' })).toBe(false);
    expect(validateStructuredOutput('IntentPlan', { tasks: Array.from({ length: 5 }, () => task) })).toBe(false);
  });

  it('enforces fail-closed ImageAnalysis and ConversationSummary source links', () => {
    expect(
      validateStructuredOutput('ImageAnalysis', {
        scene: 'SHIPPING_LABEL',
        observations: ['标签包含个人信息'],
        confidence: 0.9,
        containsPII: true,
        requiresHuman: true,
      }),
    ).toBe(true);
    expect(
      validateStructuredOutput('ImageAnalysis', {
        scene: 'SHIPPING_LABEL',
        observations: [],
        confidence: 2,
        requiresHuman: false,
      }),
    ).toBe(false);
    expect(
      validateStructuredOutput('ConversationSummary', {
        narrativeSummary: '咨询洗护方式',
        activeTopic: 'PRODUCT_QUERY',
        resolvedFacts: [{ key: 'care', value: '不烘干', sourceMessageId: 'm1' }],
        openQuestions: [],
        deprecatedFacts: [],
      }),
    ).toBe(true);
    expect(
      validateStructuredOutput('ConversationSummary', {
        narrativeSummary: 'missing source',
        activeTopic: 'PRODUCT_QUERY',
        resolvedFacts: [{ key: 'care', value: '不烘干' }],
        openQuestions: [],
        deprecatedFacts: [],
      }),
    ).toBe(false);
  });
});
