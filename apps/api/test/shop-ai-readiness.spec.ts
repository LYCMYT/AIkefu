import { projectShopAiReadiness } from '../src/shops/shop-ai-readiness';

describe('shop AI readiness', () => {
  it.each([
    ['MANUAL_ONLY', 'runtime:shop', undefined, 'OFF'],
    ['AUTO_ALLOWED', 'runtime:shop', undefined, 'PREPARING'],
    ['AUTO_ALLOWED', 'runtime:shop', 'PENDING', 'PREPARING'],
    ['AUTO_ALLOWED', 'runtime:shop', 'RUNNING', 'PREPARING'],
    ['AUTO_ALLOWED', 'runtime:shop', 'SUCCEEDED', 'READY'],
    ['AUTO_ALLOWED', 'runtime:shop', 'PARTIAL_SUCCESS', 'DEGRADED'],
    ['AUTO_ALLOWED', 'runtime:shop', 'FAILED', 'FAILED'],
    // A seeded identifier is provenance only. It must never substitute for a
    // durable successful learning result when deciding whether auto send is
    // safe to enable.
    ['AUTO_ALLOWED', 'shop_mia_fashion', undefined, 'PREPARING'],
  ] as const)('maps %s/%s/%s to %s', (mode, seedKey, learningStatus, expected) => {
    expect(projectShopAiReadiness({ aiMode: mode, seedKey, learningStatus })).toBe(expected);
  });
});
