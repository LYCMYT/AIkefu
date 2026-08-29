import { describe, expect, it } from 'vitest';
import { projectedShopAiReadiness } from './view-models';

const shop = {
  id: 'shop-1',
  name: '服饰店',
  platform: 'DOUYIN_DEMO',
  aiMode: 'AUTO_ALLOWED',
  aiReadiness: 'PREPARING',
  connectionState: 'CONNECTED',
  syncComplete: true,
} as const;

describe('projectedShopAiReadiness', () => {
  it('projects READY from the latest successful learning job while bootstrap is stale', () => {
    expect(projectedShopAiReadiness(shop, { id: 'job-1', status: 'SUCCEEDED' })).toBe('READY');
  });

  it('keeps MANUAL_ONLY fail-closed even if a learning job succeeded', () => {
    expect(projectedShopAiReadiness({ ...shop, aiMode: 'MANUAL_ONLY', aiReadiness: 'OFF' }, { id: 'job-1', status: 'SUCCEEDED' })).toBe('OFF');
  });

  it('maps partial and failed learning jobs to degraded and failed readiness', () => {
    expect(projectedShopAiReadiness(shop, { id: 'job-1', status: 'PARTIAL_SUCCESS' })).toBe('DEGRADED');
    expect(projectedShopAiReadiness(shop, { id: 'job-1', status: 'FAILED' })).toBe('FAILED');
  });
});
