import { buildConversationMemory, invalidateConversationMemory } from '../src/conversation-memory';

describe('Conversation memory', () => {
  it('builds a versioned CLEAN summary only from active messages and source-linked stable facts', () => {
    const memory = buildConversationMemory({
      previousVersion: 2,
      messages: [
        { id: 'm1', sequence: 1, status: 'ACTIVE' },
        { id: 'm2', sequence: 2, status: 'RECALLED' },
        { id: 'm3', sequence: 3, status: 'EDITED' },
      ],
      output: {
        narrativeSummary: '用户正在咨询连帽卫衣的洗护方式。',
        activeTopic: 'PRODUCT_QUERY',
        activeProductId: 'p1',
        activeOrderId: null,
        resolvedFacts: [
          { key: 'care', value: '不建议烘干', sourceMessageId: 'm3', status: 'ACTIVE' },
          { key: 'inventory', value: 8, sourceMessageId: 'm1', status: 'ACTIVE' },
          { key: 'wrong', value: true, sourceMessageId: 'm2', status: 'ACTIVE' },
        ],
        openQuestions: ['适合什么尺码'],
        deprecatedFacts: [],
      },
    });

    expect(memory).toMatchObject({ summaryVersion: 3, basedOnThroughSequence: 3, status: 'CLEAN' });
    expect(memory.resolvedFacts).toEqual([
      { key: 'care', value: '不建议烘干', sourceMessageId: 'm3', status: 'ACTIVE' },
    ]);
  });

  it('marks the summary DIRTY only when an edit or recall affects its covered sequence', () => {
    const memory = {
      narrativeSummary: 'summary',
      activeTopic: 'FAQ_QUERY',
      activeProductId: null,
      activeOrderId: null,
      resolvedFacts: [],
      openQuestions: [],
      deprecatedFacts: [],
      summaryVersion: 1,
      basedOnThroughSequence: 10,
      status: 'CLEAN' as const,
    };

    expect(invalidateConversationMemory(memory, 11)).toBe(memory);
    expect(invalidateConversationMemory(memory, 10)).toEqual({ ...memory, status: 'DIRTY' });
  });
});
