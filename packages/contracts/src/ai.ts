export type AiPurpose =
  | 'INTENT_PLANNER'
  | 'RISK_CLASSIFIER'
  | 'SUMMARY'
  | 'KNOWLEDGE_EXTRACT'
  | 'REPLY_GENERATION'
  | 'IMAGE_ANALYSIS'
  | 'QUALITY_JUDGE';

export type AiInvocationStatus = 'SUCCEEDED' | 'FAILED' | 'ABORTED';

export type AiUsageEntry = {
  id: string;
  purpose: AiPurpose;
  provider: string | null;
  model: string | null;
  promptVersion: string;
  ragStrategy: string | null;
  fallbackUsed: boolean;
  contextVersion: number | null;
  evidenceIds: string[];
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  status: AiInvocationStatus;
  includedDataClasses: string[];
  excludedPII: string[];
  createdAt: string;
};

export type UsagePurposeSummary = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failures: number;
  fallbacks: number;
};

export type UsageSummary = UsagePurposeSummary & {
  /** V1 reports zero when no server-side pricing table is configured. */
  estimatedCost: number;
  fastPathReplies: number;
  byPurpose: Record<string, UsagePurposeSummary>;
};

export type ConversationMemoryStatus = 'CLEAN' | 'DIRTY';
export type StructuredConversationFact = {
  key: string;
  value: unknown;
  sourceMessageId: string;
  status: 'ACTIVE' | 'SUPERSEDED';
};

export type ConversationMemorySnapshot = {
  conversationId: string;
  narrativeSummary: string;
  activeTopic: string;
  activeProductId: string | null;
  activeOrderId: string | null;
  resolvedFacts: StructuredConversationFact[];
  openQuestions: string[];
  deprecatedFacts: string[];
  summaryVersion: number;
  basedOnThroughSequence: number;
  status: ConversationMemoryStatus;
  updatedAt: string;
};

export type ImageAnalysis = {
  scene: 'PRODUCT_DAMAGE' | 'PRODUCT_APPEARANCE' | 'SHIPPING_LABEL' | 'ORDER_SCREENSHOT' | 'UNRELATED' | 'UNKNOWN';
  observations: string[];
  confidence: number;
  containsPII: boolean;
  recommendedIntent?: string;
  requiresHuman: boolean;
};
