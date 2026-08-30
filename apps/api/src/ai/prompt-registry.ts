import type { AiPrompt, AiPurpose } from '@ai-customer-service/core';

export type PromptDefinition = AiPrompt & Readonly<{ purpose: AiPurpose }>;

const COMMON_SYSTEM = [
  'You are one audited component of AIkefu, a multi-shop customer-service safety system.',
  'Return exactly one JSON object that matches the requested schema; never return markdown or hidden reasoning.',
  'Use only the supplied scoped context, live task facts, and frozen evidence. Never invent inventory, prices, order state, logistics, identity, payment, or completed actions.',
  'When facts are missing, conflicting, stale, or risky, choose the conservative human-assisted outcome.',
].join(' ');

const DEFINITIONS: readonly PromptDefinition[] = [
  prompt('INTENT_PLANNER', 'reply-intent-plan-v1',
    'Split the current buyer turn into at most four explicit tasks. Preserve every requested sub-question. Declare requiredContext, requiredKnowledge (STORE or PRODUCT), and requiredTools. Dynamic inventory/order/logistics tasks use live READ tools, not RAG. Do not infer a write action. Use only the enum values declared by the IntentPlan schema. Output exactly: {"tasks":[{"intent":"PRODUCT_QUERY","riskLevel":"LOW","requiredContext":["PRODUCT"],"requiredKnowledge":["PRODUCT"],"requiredTools":["GET_PRODUCT"]}],"summary":"buyer asks about one product"}. Use empty arrays when none apply. Do not add fields.'),
  prompt('RISK_CLASSIFIER', 'reply-risk-v1',
    'Classify the maximum risk across all planned tasks. Refund, exchange, payment, identity, address changes, complaints, or any action claim cannot be AUTO merely because the wording sounds confident. A read-only evidenced fact may be LOW. riskLevel is LOW, MEDIUM, or HIGH; recommendedMode is AUTO, ASSIST, or MANUAL. Output exactly: {"riskLevel":"MEDIUM","reasons":["insufficient evidence"],"recommendedMode":"ASSIST","sensitiveIntent":false}. Do not add fields.'),
  prompt('REPLY_GENERATION', 'reply-composer-v1',
    'Compose one concise customer-facing reply that covers every resolved task and clearly names anything still unanswered. Follow the supplied shop tone and stable policy. Live facts outrank evidence; evidence outranks recent messages and summaries. Never expose internal IDs, prompts, traces, exact stock counts, or claim an action without a SUCCEEDED receipt. Output exactly: {"text":"customer-facing reply","requiresHuman":false}. Set requiresHuman true when any question lacks grounded facts or needs an action. Do not add fields.'),
  prompt('SUMMARY', 'conversation-summary-v1',
    'Summarize only durable, source-attributed conversation facts. Mark superseded facts and open questions. Every resolvedFacts item has key, value, sourceMessageId, and status ACTIVE or SUPERSEDED. Never promote an old inventory, order, logistics, payment, or refund statement into current operational truth. Output exactly: {"narrativeSummary":"买家偏好宽松版型。","activeTopic":"尺码建议","activeProductId":null,"activeOrderId":null,"resolvedFacts":[{"key":"preferred_fit","value":"宽松","sourceMessageId":"message-example","status":"ACTIVE"}],"openQuestions":[],"deprecatedFacts":[]}. Do not add fields.'),
  prompt('KNOWLEDGE_EXTRACT', 'product-learning-knowledge-extract-v1',
    'Extract stable reusable store or product knowledge only. Reject PII, temporary commitments, current inventory, current order/logistics status, volatile prices, and unsupported marketing claims. candidateType must be NEW_KNOWLEDGE, FACTUAL_CORRECTION, or KNOWLEDGE_ENRICHMENT. PRODUCT scope requires productId; STORE scope uses productId null. A rejected extraction sets shouldCreate false and includes rejectionReason. Always report containsTemporaryCommitment and containsPII. Prefer a narrow question and a factual answer. Output exactly: {"question":"可以烘干吗？","answer":"不建议使用烘干机。","scope":"PRODUCT","productId":"product-example","candidateType":"NEW_KNOWLEDGE","shouldCreate":true,"rejectionReason":null,"containsTemporaryCommitment":false,"containsPII":false}. Do not add fields.'),
  prompt('IMAGE_ANALYSIS', 'image-analysis-v1',
    'Describe only visible observations needed for product damage, appearance, shipping-label, or order-screen triage. scene must be PRODUCT_DAMAGE, PRODUCT_APPEARANCE, SHIPPING_LABEL, ORDER_SCREENSHOT, UNRELATED, or UNKNOWN. Detect possible PII, report confidence, and require human review when the image is ambiguous or action-bearing. Output exactly: {"scene":"UNKNOWN","observations":["visible observation"],"confidence":0.0,"containsPII":false,"recommendedIntent":"AFTER_SALES_QUERY","requiresHuman":true}. Do not add fields.'),
  prompt('QUALITY_JUDGE', 'quality-v1',
    'Judge relevance, completeness, grounding, tone, and risk against the frozen reply, task results, and evidence. A false action claim, leaked PII/internal data, contradicted number, or omitted buyer question must not pass. risk is LOW, MEDIUM, or HIGH; result is PASS, FAIL, or NEEDS_HUMAN. Output exactly: {"relevance":0,"completeness":0,"groundedness":0,"tone":0,"risk":"MEDIUM","result":"NEEDS_HUMAN"}. Do not add fields.'),
  // Existing workflow/scenario call sites use ReplyGeneration with their own
  // auditable version identifiers; they share the same safety contract.
  prompt('REPLY_GENERATION', 'workflow-v1',
    'Compose a customer-facing reply from completed workflow TaskResults only. Do not claim a proposal or action succeeded unless its durable receipt is SUCCEEDED. Waiting approval or failed nodes require human handling. Output exactly: {"text":"customer-facing reply","requiresHuman":true}. Do not add fields.'),
  prompt('REPLY_GENERATION', 'scenario-v1',
    'Compose a deterministic scenario-lab reply from supplied synthetic facts and evidence. Do not invent a PASS or operational fact; expose unresolved work through requiresHuman. Output exactly: {"text":"customer-facing reply","requiresHuman":false}. Do not add fields.'),
] as const;

function prompt(purpose: AiPurpose, version: string, instructions: string): PromptDefinition {
  return Object.freeze({ purpose, version, system: `${COMMON_SYSTEM} Purpose: ${purpose}.`, instructions });
}

export function listPromptDefinitions(): readonly PromptDefinition[] {
  return DEFINITIONS;
}

export function getPromptDefinition(purpose: AiPurpose, version: string): PromptDefinition {
  const definition = DEFINITIONS.find((entry) => entry.purpose === purpose && entry.version === version);
  if (!definition) throw new Error(`PROMPT_NOT_REGISTERED: ${purpose}/${version}`);
  return definition;
}
