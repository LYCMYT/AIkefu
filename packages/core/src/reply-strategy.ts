import type { TaskRiskLevel, TaskStatus } from './intent-task-bundle';

export type ReplyStrategy = 'FAST_PATH' | 'COMPOSER';

export interface ReplyStrategyTask {
  id: string;
  riskLevel: TaskRiskLevel;
  status: TaskStatus;
  blocking: boolean;
  facts?: Record<string, unknown>;
}

export interface ReplyBuildInput {
  tasks: ReplyStrategyTask[];
}

export interface ReplyComposer {
  compose(input: ReplyBuildInput): Promise<string>;
}

export interface ForbiddenTermRule {
  term: string;
  replacement: string;
}

export interface ForbiddenTermCheck {
  allowed: boolean;
  text: string;
  violations: string[];
}

/** A deterministic path is allowed for one complete low-risk fact, or for a
 * canonical built-in/sanitized observation whose wording must not be changed
 * by the composer. Policy still decides AUTO versus human review afterwards. */
export function selectReplyStrategy(input: ReplyBuildInput): ReplyStrategy {
  if (input.tasks.length !== 1) return 'COMPOSER';
  const task = input.tasks[0]!;
  const deterministicSource = task.facts?.source === 'SYSTEM_SAFE_REPLY'
    || task.facts?.source === 'SANITIZED_IMAGE_ANALYSIS';
  return task.status === 'RESOLVED'
    && (task.riskLevel === 'LOW' || deterministicSource)
    && !task.blocking
    && typeof task.facts?.reply === 'string'
    && task.facts.reply.trim().length > 0
    ? 'FAST_PATH'
    : 'COMPOSER';
}

/** Always returns one finalized string; streaming belongs to an upper layer. */
export async function buildReply(input: ReplyBuildInput, composer: ReplyComposer): Promise<{ strategy: ReplyStrategy; text: string }> {
  const strategy = selectReplyStrategy(input);
  const text = strategy === 'FAST_PATH'
    ? String(input.tasks[0]!.facts!.reply).trim()
    : (await composer.compose(input)).trim();
  if (!text) throw new Error('Reply text must not be empty');
  return { strategy, text };
}

/** Replaces explicitly configured terms, and blocks ones without a safe replacement. */
export function checkForbiddenTerms(text: string, rules: ForbiddenTermRule[]): ForbiddenTermCheck {
  let sanitized = text;
  const violations: string[] = [];
  let allowed = true;
  for (const rule of rules) {
    const term = rule.term.trim();
    if (!term || !new RegExp(escapeRegExp(term), 'iu').test(sanitized)) continue;
    violations.push(term);
    const replacement = rule.replacement.trim();
    if (!replacement) {
      allowed = false;
      continue;
    }
    sanitized = sanitized.replace(new RegExp(escapeRegExp(term), 'giu'), replacement);
  }
  return { allowed, text: sanitized, violations };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
