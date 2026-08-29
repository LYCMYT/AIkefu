import type { ShopAiReadiness } from '@ai-customer-service/contracts';

type ReadinessSource = {
  aiMode?: string | null;
  seedKey?: string | null;
  settingsConfirmed?: boolean | null;
  learningStatus?: string | null;
};

/**
 * Projects a fail-closed readiness value without adding mutable duplicate
 * state to Shop. Seed provenance is deliberately not a readiness signal:
 * every AUTO_ALLOWED shop must have a durable successful learning result.
 */
export function projectShopAiReadiness(source: ReadinessSource): ShopAiReadiness {
  if (source.aiMode === 'MANUAL_ONLY') return 'OFF';
  if (source.settingsConfirmed !== true) return 'PREPARING';
  if (source.learningStatus === 'SUCCEEDED') return 'READY';
  if (source.learningStatus === 'PARTIAL_SUCCESS') return 'DEGRADED';
  if (source.learningStatus === 'FAILED') return 'FAILED';
  if (source.learningStatus === 'PENDING' || source.learningStatus === 'RUNNING') return 'PREPARING';
  return 'PREPARING';
}

export function autoReplyReady(source: ReadinessSource): boolean {
  return source.aiMode === 'AUTO_ALLOWED' && projectShopAiReadiness(source) === 'READY';
}
