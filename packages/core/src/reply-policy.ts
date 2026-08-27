import type { TaskRiskLevel } from './intent-task-bundle';
import type { ContextResolutionStatus } from './context-resolver';

export type ReplyMode = 'AUTO' | 'ASSIST' | 'MANUAL';
export type ShopAIMode = 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY';
export type ConversationModeOverride = ReplyMode | 'HOLD';
export type ConversationConnectionState = 'CONNECTED' | 'RECONNECTING' | 'RECONCILING' | 'DEGRADED' | 'DISCONNECTED';

export interface ReplyPolicyInput {
  shopMode: ShopAIMode;
  conversationOverride?: ConversationModeOverride;
  syncState: ConversationConnectionState;
  humanActive: boolean;
  taskRisks: TaskRiskLevel[];
  contextStatus: ContextResolutionStatus;
  /** Resolver exhausted its two low/medium-risk clarification rounds. */
  contextManualRequired?: boolean;
  hasEvidence: boolean;
  hasBlockingFailure: boolean;
  /** A non-blocking task still failed/needs clarification: never hide it in AUTO. */
  hasPartialFailure?: boolean;
  userRequestedHuman: boolean;
  /** Model may only request a stricter mode; it can never relax policy. */
  recommendedMode?: ReplyMode;
  hasConflict?: boolean;
}

export interface ReplyPolicyDecision {
  mode: ReplyMode;
  reasons: string[];
}

/**
 * Calculates an outcome first, then applies shop and conversation ceilings.
 * Neither a configured shop nor an override can make a reply less conservative.
 */
export function decideReplyPolicy(input: ReplyPolicyInput): ReplyPolicyDecision {
  const reasons: string[] = [];
  let mode: ReplyMode;
  if (input.humanActive) {
    mode = 'MANUAL'; reasons.push('HUMAN_ACTIVE');
  } else if (input.syncState === 'DISCONNECTED' || input.syncState === 'DEGRADED') {
    // A degraded platform cannot safely confirm the current conversation
    // cursor/receipt.  Docs §16 therefore makes both states manual-only.
    mode = 'MANUAL'; reasons.push('CONNECTION_DEGRADED');
  } else if (input.userRequestedHuman) {
    mode = 'MANUAL'; reasons.push('USER_REQUESTED_HUMAN');
  } else if (input.hasConflict) {
    mode = 'MANUAL'; reasons.push('CONTEXT_CONFLICT');
  } else if (input.taskRisks.includes('HIGH')) {
    mode = 'MANUAL'; reasons.push('HIGH_RISK_TASK');
  } else if (input.contextManualRequired) {
    mode = 'MANUAL'; reasons.push('CONTEXT_MANUAL_REQUIRED');
  } else if (input.hasBlockingFailure) {
    mode = 'ASSIST'; reasons.push('BLOCKING_TASK_FAILURE');
  } else if (input.hasPartialFailure) {
    mode = 'ASSIST'; reasons.push('PARTIAL_TASK_RESULT');
  } else if (input.contextStatus !== 'RESOLVED') {
    mode = 'ASSIST'; reasons.push(`CONTEXT_${input.contextStatus}`);
  } else if (!input.hasEvidence) {
    mode = 'ASSIST'; reasons.push('INSUFFICIENT_EVIDENCE');
  } else if (input.taskRisks.includes('MEDIUM')) {
    mode = 'ASSIST'; reasons.push('MEDIUM_RISK_TASK');
  } else {
    mode = 'AUTO'; reasons.push('LOW_RISK_EVIDENCED_CONTEXT');
  }

  const shopCeiling: ReplyMode = input.shopMode === 'AUTO_ALLOWED'
    ? 'AUTO'
    : input.shopMode === 'ASSIST_ONLY' ? 'ASSIST' : 'MANUAL';
  const overrideCeiling: ReplyMode | undefined = input.conversationOverride === 'HOLD'
    ? 'MANUAL'
    : input.conversationOverride;
  const capped = moreConservative(mode, shopCeiling, overrideCeiling, input.recommendedMode);
  if (capped !== mode) reasons.push('MODE_CEILING');
  return { mode: capped, reasons };
}

function moreConservative(mode: ReplyMode, ...ceilings: Array<ReplyMode | undefined>): ReplyMode {
  const rank: Record<ReplyMode, number> = { AUTO: 0, ASSIST: 1, MANUAL: 2 };
  let result = mode;
  for (const ceiling of ceilings) {
    if (ceiling !== undefined && rank[ceiling] > rank[result]) result = ceiling;
  }
  return result;
}
