export type StructuredOutputSchemaName =
  | 'IntentPlan'
  | 'RiskResult'
  | 'ImageAnalysis'
  | 'KnowledgeCandidate'
  | 'ReplyGeneration'
  | 'ConversationSummary'
  | 'ActionProposal'
  | 'QualityReview';

const INTENTS = [
  'FAQ_QUERY', 'PRODUCT_QUERY', 'INVENTORY_QUERY', 'SIZE_RECOMMENDATION', 'SHIPPING_POLICY',
  'ORDER_QUERY', 'LOGISTICS_QUERY', 'AFTER_SALES_QUERY', 'REFUND_REQUEST', 'EXCHANGE_REQUEST',
  'PRODUCT_RECOMMENDATION', 'HUMAN_REQUEST', 'COMPLAINT', 'UNKNOWN',
] as const;
const RISKS = ['LOW', 'MEDIUM', 'HIGH'] as const;
const MODES = ['AUTO', 'ASSIST', 'MANUAL'] as const;
const CONTEXTS = ['PRODUCT', 'SKU', 'ORDER', 'LOGISTICS', 'AFTER_SALES', 'CUSTOMER_MEMORY'] as const;
const TOOLS = [
  'GET_PRODUCT', 'GET_INVENTORY', 'GET_ORDER', 'GET_LOGISTICS', 'GET_AFTER_SALES',
  'TRANSFER_HUMAN', 'ADD_ORDER_REMARK', 'PROPOSE_COMPENSATION',
] as const;

export function validateStructuredOutput(schema: StructuredOutputSchemaName, value: unknown): boolean {
  switch (schema) {
    case 'IntentPlan':
      return validateIntentPlan(value);
    case 'RiskResult':
      return validateRiskResult(value);
    case 'ImageAnalysis':
      return validateImageAnalysis(value);
    case 'KnowledgeCandidate':
      return validateKnowledgeCandidate(value);
    case 'ReplyGeneration':
      return validateReplyGeneration(value);
    case 'ConversationSummary':
      return validateConversationSummary(value);
    case 'ActionProposal':
      return validateActionProposal(value);
    case 'QualityReview':
      return validateQualityReview(value);
  }
}

function validateReplyGeneration(value: unknown): boolean {
  return strictObject(value, ['text', 'requiresHuman'], ['text', 'requiresHuman'])
    && boundedString(value.text, 0, 2_000)
    && typeof value.requiresHuman === 'boolean';
}

function validateIntentPlan(value: unknown): boolean {
  if (!strictObject(value, ['tasks', 'summary'], ['tasks'])) return false;
  const tasks = value.tasks;
  return (
    Array.isArray(tasks) &&
    tasks.length >= 1 &&
    tasks.length <= 4 &&
    tasks.every(validateIntentTask) &&
    optionalString(value.summary, 500)
  );
}

function validateIntentTask(value: unknown): boolean {
  if (
    !strictObject(
      value,
      ['intent', 'riskLevel', 'requiredContext', 'requiredKnowledge', 'requiredTools', 'dependsOnTaskIndex'],
      ['intent', 'riskLevel', 'requiredContext', 'requiredTools'],
    )
  ) return false;
  return (
    member(value.intent, INTENTS) &&
    member(value.riskLevel, RISKS) &&
    enumArray(value.requiredContext, CONTEXTS, 6) &&
    (value.requiredKnowledge === undefined || enumArray(value.requiredKnowledge, ['STORE', 'PRODUCT'] as const)) &&
    enumArray(value.requiredTools, TOOLS) &&
    (value.dependsOnTaskIndex === undefined || nonNegativeInteger(value.dependsOnTaskIndex))
  );
}

function validateRiskResult(value: unknown): boolean {
  if (!strictObject(value, ['riskLevel', 'reasons', 'recommendedMode', 'sensitiveIntent'], ['riskLevel', 'reasons', 'recommendedMode'])) return false;
  return (
    member(value.riskLevel, RISKS) &&
    stringArray(value.reasons, 8) &&
    member(value.recommendedMode, MODES) &&
    (value.sensitiveIntent === undefined || typeof value.sensitiveIntent === 'boolean')
  );
}

function validateImageAnalysis(value: unknown): boolean {
  if (!strictObject(value, ['scene', 'observations', 'confidence', 'containsPII', 'recommendedIntent', 'requiresHuman'], ['scene', 'observations', 'confidence', 'requiresHuman'])) return false;
  return (
    member(value.scene, ['PRODUCT_DAMAGE', 'PRODUCT_APPEARANCE', 'SHIPPING_LABEL', 'ORDER_SCREENSHOT', 'UNRELATED', 'UNKNOWN'] as const) &&
    stringArray(value.observations, 12) &&
    unitNumber(value.confidence) &&
    (value.containsPII === undefined || typeof value.containsPII === 'boolean') &&
    optionalString(value.recommendedIntent) &&
    typeof value.requiresHuman === 'boolean'
  );
}

function validateKnowledgeCandidate(value: unknown): boolean {
  if (!strictObject(value, ['question', 'answer', 'scope', 'productId', 'candidateType', 'shouldCreate', 'rejectionReason', 'containsTemporaryCommitment', 'containsPII'], ['question', 'answer', 'scope', 'candidateType', 'shouldCreate'])) return false;
  return (
    boundedString(value.question, 1, 500) &&
    boundedString(value.answer, 1, 2_000) &&
    member(value.scope, ['STORE', 'PRODUCT'] as const) &&
    (value.productId === undefined || value.productId === null || typeof value.productId === 'string') &&
    member(value.candidateType, ['NEW_KNOWLEDGE', 'FACTUAL_CORRECTION', 'KNOWLEDGE_ENRICHMENT'] as const) &&
    typeof value.shouldCreate === 'boolean' &&
    (value.rejectionReason === undefined || value.rejectionReason === null || typeof value.rejectionReason === 'string') &&
    (value.containsTemporaryCommitment === undefined || typeof value.containsTemporaryCommitment === 'boolean') &&
    (value.containsPII === undefined || typeof value.containsPII === 'boolean')
  );
}

function validateConversationSummary(value: unknown): boolean {
  if (!strictObject(value, ['narrativeSummary', 'activeTopic', 'activeProductId', 'activeOrderId', 'resolvedFacts', 'openQuestions', 'deprecatedFacts'], ['narrativeSummary', 'activeTopic', 'resolvedFacts', 'openQuestions', 'deprecatedFacts'])) return false;
  const facts = value.resolvedFacts;
  return (
    boundedString(value.narrativeSummary, 0, 1_500) &&
    typeof value.activeTopic === 'string' &&
    nullableOptionalString(value.activeProductId) &&
    nullableOptionalString(value.activeOrderId) &&
    Array.isArray(facts) && facts.length <= 30 && facts.every(validateSummaryFact) &&
    stringArray(value.openQuestions, 12) &&
    stringArray(value.deprecatedFacts, 20)
  );
}

function validateSummaryFact(value: unknown): boolean {
  return (
    strictObject(value, ['key', 'value', 'sourceMessageId', 'status'], ['key', 'value', 'sourceMessageId']) &&
    typeof value.key === 'string' &&
    typeof value.sourceMessageId === 'string' &&
    (value.status === undefined || member(value.status, ['ACTIVE', 'SUPERSEDED'] as const))
  );
}

function validateActionProposal(value: unknown): boolean {
  if (!strictObject(value, ['type', 'riskLevel', 'targetEntityType', 'targetEntityId', 'payload', 'reason', 'evidenceIds'], ['type', 'riskLevel', 'targetEntityType', 'targetEntityId', 'reason'])) return false;
  return (
    member(value.type, ['MARK_READ', 'CREATE_INTERNAL_TASK', 'TRANSFER_HUMAN', 'ADD_ORDER_REMARK', 'PROPOSE_COMPENSATION', 'REFUND', 'EXCHANGE'] as const) &&
    member(value.riskLevel, ['READ', 'LOW_WRITE', 'MEDIUM_WRITE', 'HIGH_RISK'] as const) &&
    typeof value.targetEntityType === 'string' &&
    typeof value.targetEntityId === 'string' &&
    (value.payload === undefined || plainObject(value.payload)) &&
    typeof value.reason === 'string' &&
    (value.evidenceIds === undefined || stringArray(value.evidenceIds))
  );
}

function validateQualityReview(value: unknown): boolean {
  if (!strictObject(value, ['relevance', 'completeness', 'groundedness', 'tone', 'risk', 'result', 'reasons'], ['relevance', 'completeness', 'groundedness', 'tone', 'risk', 'result'])) return false;
  return (
    unitNumber(value.relevance) && unitNumber(value.completeness) && unitNumber(value.groundedness) &&
    unitNumber(value.tone) && member(value.risk, RISKS) &&
    member(value.result, ['PASS', 'FAIL', 'NEEDS_HUMAN'] as const) &&
    (value.reasons === undefined || stringArray(value.reasons, 12))
  );
}

function strictObject<TRequired extends string>(
  value: unknown,
  allowed: readonly string[],
  required: readonly TRequired[],
): value is Record<TRequired, unknown> & Record<string, unknown> {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function enumArray<T extends string>(value: unknown, values: readonly T[], max = Number.POSITIVE_INFINITY): boolean {
  return Array.isArray(value) && value.length <= max && value.every((item) => member(item, values));
}

function stringArray(value: unknown, max = Number.POSITIVE_INFINITY): boolean {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === 'string');
}

function optionalString(value: unknown, max = Number.POSITIVE_INFINITY): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

function nullableOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function boundedString(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function unitNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
