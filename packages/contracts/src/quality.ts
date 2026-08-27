import type { IsoDateTime } from './workspace';

export const QUALITY_REVIEW_STATUSES = ['PENDING', 'RUNNING', 'AUTO_REVIEWED', 'PASS', 'FAIL', 'NEEDS_HUMAN'] as const;
export type QualityReviewStatus = typeof QUALITY_REVIEW_STATUSES[number];
export const QUALITY_RESULTS = ['PASS', 'FAIL', 'NEEDS_HUMAN'] as const;
export type QualityResult = typeof QUALITY_RESULTS[number];
export type QualityRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface QualityDeterministicCheck {
  key: string;
  passed: boolean;
  reason?: string;
}

export interface QualityDeterministicResult {
  passed: boolean;
  checks: QualityDeterministicCheck[];
}

export interface QualityJudgeResult {
  relevance: number;
  completeness: number;
  groundedness: number;
  tone: number;
  risk: QualityRisk;
  result: QualityResult;
  reasons?: string[];
}

export interface QualityReview {
  id: string;
  workspaceId?: string;
  tenantId?: string;
  conversationId: string;
  status: QualityReviewStatus;
  deterministicResult?: QualityDeterministicResult | null;
  judgeResult?: QualityJudgeResult | null;
  humanResult?: QualityResult | null;
  sampleSize?: number;
  metrics?: Record<string, number>;
  createdBy?: string;
  createdAt?: IsoDateTime;
  completedAt?: IsoDateTime | null;
}

export interface StartQualityReviewInput {
  conversationId: string;
}

/** Human conclusion is intentionally scoped by the review resource on the server. */
export interface QualityConclusionInput {
  result: QualityResult;
}

export function isQualityReview(value: unknown): value is QualityReview {
  if (!plainObject(value)
    || typeof value.id !== 'string'
    || typeof value.conversationId !== 'string'
    || !isQualityReviewStatus(value.status)) return false;
  if (value.sampleSize !== undefined && (typeof value.sampleSize !== 'number' || !Number.isSafeInteger(value.sampleSize) || value.sampleSize < 0)) return false;
  return true;
}

export function isQualityReviewStatus(value: unknown): value is QualityReviewStatus {
  return typeof value === 'string' && (QUALITY_REVIEW_STATUSES as readonly string[]).includes(value);
}

export function isQualityConclusionInput(value: unknown): value is QualityConclusionInput {
  return plainObject(value) && typeof value.result === 'string' && (QUALITY_RESULTS as readonly string[]).includes(value.result);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
