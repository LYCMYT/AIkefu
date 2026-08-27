import type { TaskRiskLevel } from './intent-task-bundle';

export type ContextKind = 'PRODUCT' | 'SKU' | 'ORDER';
export type ContextResolutionStatus = 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND' | 'STALE';

export interface ContextCandidate {
  id: string;
  kind: ContextKind;
  label: string;
}

export interface ContextCardRef {
  id: string;
  kind: ContextKind;
}

export interface ClarificationRequest {
  kind: ContextKind;
  question: string;
  choices: Array<Pick<ContextCandidate, 'id' | 'label'>>;
}

export interface ClarificationBundle {
  round: 1 | 2;
  requests: ClarificationRequest[];
  choices: Array<Pick<ContextCandidate, 'id' | 'label'>>;
}

export type ContextResolution = {
  status: ContextResolutionStatus;
  entity: ContextCandidate | null;
  source: 'CARD' | 'CANDIDATE' | null;
  manualRequired: boolean;
  clarification: ClarificationBundle | null;
};

export interface ResolveContextInput {
  kind: ContextKind;
  riskLevel: TaskRiskLevel;
  candidates: ContextCandidate[];
  card?: ContextCardRef;
  clarificationRounds?: number;
  /** The plan's input context snapshot. A mismatch means this work is stale. */
  contextVersion?: number;
  currentContextVersion?: number;
}

export function resolveContext(input: ResolveContextInput): ContextResolution {
  validateInput(input);
  if (input.contextVersion !== undefined && input.currentContextVersion !== undefined
    && input.contextVersion !== input.currentContextVersion) {
    return unresolved('STALE');
  }

  const candidates = deduplicateCandidates(input.candidates.filter((candidate) => candidate.kind === input.kind));
  if (input.card) {
    const cardCandidate = candidates.find((candidate) => candidate.id === input.card!.id && candidate.kind === input.card!.kind);
    if (input.card.kind !== input.kind || !cardCandidate) return unresolved('STALE');
    return { status: 'RESOLVED', entity: cardCandidate, source: 'CARD', manualRequired: false, clarification: null };
  }
  if (candidates.length === 0) return unresolved('NOT_FOUND');
  if (candidates.length === 1) {
    return { status: 'RESOLVED', entity: candidates[0]!, source: 'CANDIDATE', manualRequired: false, clarification: null };
  }

  const rounds = input.clarificationRounds ?? 0;
  if (input.riskLevel === 'HIGH' || rounds >= 2) {
    return { status: 'AMBIGUOUS', entity: null, source: null, manualRequired: true, clarification: null };
  }
  const clarification = createClarificationBundle([
    { kind: input.kind, candidates },
  ], rounds + 1);
  return { status: 'AMBIGUOUS', entity: null, source: null, manualRequired: false, clarification };
}

/** Combines independent ambiguities into the single buyer-facing clarification turn. */
export function createClarificationBundle(
  unresolvedContexts: Array<{ kind: ContextKind; candidates: ContextCandidate[] }>,
  round: number,
): ClarificationBundle {
  if (round !== 1 && round !== 2) throw new RangeError('Clarification round must be 1 or 2');
  const requests = unresolvedContexts.map(({ kind, candidates }) => ({
    kind,
    question: clarificationQuestion(kind),
    choices: deduplicateCandidates(candidates)
      .map(({ id, label }) => ({ id, label })),
  }));
  const choices = requests.flatMap((request) => request.choices)
    .filter((choice, index, all) => all.findIndex((item) => item.id === choice.id) === index);
  return { round, requests, choices };
}

function unresolved(status: Exclude<ContextResolutionStatus, 'RESOLVED'>): ContextResolution {
  return { status, entity: null, source: null, manualRequired: false, clarification: null };
}

function deduplicateCandidates(candidates: ContextCandidate[]): ContextCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function clarificationQuestion(kind: ContextKind): string {
  if (kind === 'PRODUCT') return '请问您咨询的是哪件商品？';
  if (kind === 'SKU') return '请问您需要哪个规格？';
  return '请问您咨询的是哪笔订单？';
}

function validateInput(input: ResolveContextInput): void {
  if (!['PRODUCT', 'SKU', 'ORDER'].includes(input.kind)) throw new TypeError('Context kind is invalid');
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(input.riskLevel)) throw new TypeError('Context riskLevel is invalid');
  if (!Array.isArray(input.candidates)) throw new TypeError('Context candidates are required');
  const rounds = input.clarificationRounds ?? 0;
  if (!Number.isSafeInteger(rounds) || rounds < 0) throw new RangeError('clarificationRounds must be a non-negative integer');
}
