/**
 * Capabilities understood by the V2 product evaluator. A capability appearing
 * in canonical input must be dispatched explicitly by the production port;
 * unknown or unavailable capabilities are never treated as a pass.
 */
export const PRODUCT_EVAL_CAPABILITIES = [
  'TEXT_TURN',
  'GOODS_CARD',
  'ORDER_CARD',
  'IMAGE_FIXTURE',
  'EDIT_PREVIOUS',
  'RECALL_PREVIOUS',
  'HUMAN_ACTIVE',
  'KNOWLEDGE_CONFLICT',
  'INVENTORY_CHANGE_BARRIER',
  'LOGISTICS_CHANGE_BARRIER',
  'CONTEXT_CHANGE_BARRIER',
  'PROVIDER_FAULT',
  'DUPLICATE_TRANSPORT',
  'OUT_OF_ORDER_TRANSPORT',
  'RESTART_GENERATING',
  'RESTART_SENDING',
  'RELIABILITY_HARNESS',
] as const;

export type ProductEvalCapability = (typeof PRODUCT_EVAL_CAPABILITIES)[number];

export function isProductEvalCapability(value: string): value is ProductEvalCapability {
  return (PRODUCT_EVAL_CAPABILITIES as readonly string[]).includes(value);
}
