export type SummaryMessageReference = {
  id: string;
  sequence: number;
  status: 'ACTIVE' | 'EDITED' | 'RECALLED' | 'DELETED';
};

export type StructuredSummaryFact = {
  key: string;
  value: unknown;
  sourceMessageId: string;
  status: 'ACTIVE' | 'SUPERSEDED';
};

export type GeneratedConversationSummary = {
  narrativeSummary: string;
  activeTopic: string;
  activeProductId: string | null;
  activeOrderId: string | null;
  resolvedFacts: StructuredSummaryFact[];
  openQuestions: string[];
  deprecatedFacts: string[];
};

export type ConversationMemory = GeneratedConversationSummary & {
  summaryVersion: number;
  basedOnThroughSequence: number;
  status: 'CLEAN' | 'DIRTY';
};

const DYNAMIC_FACT_KEY = /(?:inventory|stock|price|order.?status|logistics|tracking|refund.?status|库存|价格|订单状态|物流)/i;

export function buildConversationMemory(input: {
  messages: readonly SummaryMessageReference[];
  output: GeneratedConversationSummary;
  previousVersion?: number;
}): ConversationMemory {
  const activeMessageIds = new Set(
    input.messages.filter((message) => message.status === 'ACTIVE' || message.status === 'EDITED').map((message) => message.id),
  );
  const basedOnThroughSequence = input.messages.reduce(
    (maximum, message) => Math.max(maximum, message.sequence),
    0,
  );
  const resolvedFacts = input.output.resolvedFacts
    .filter((fact) => activeMessageIds.has(fact.sourceMessageId) && !DYNAMIC_FACT_KEY.test(fact.key))
    .slice(0, 30)
    .map((fact) => ({ ...fact }));
  return {
    narrativeSummary: input.output.narrativeSummary.slice(0, 1_500),
    activeTopic: input.output.activeTopic,
    activeProductId: input.output.activeProductId,
    activeOrderId: input.output.activeOrderId,
    resolvedFacts,
    openQuestions: input.output.openQuestions.slice(0, 12),
    deprecatedFacts: input.output.deprecatedFacts.slice(0, 20),
    summaryVersion: (input.previousVersion ?? 0) + 1,
    basedOnThroughSequence,
    status: 'CLEAN',
  };
}

export function invalidateConversationMemory<T extends ConversationMemory>(memory: T, affectedSequence: number): T {
  if (affectedSequence > memory.basedOnThroughSequence || memory.status === 'DIRTY') return memory;
  return { ...memory, status: 'DIRTY' };
}
