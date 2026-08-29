import { projectShopAiReadiness } from '../src/shops/shop-ai-readiness';

describe('shop AI readiness', () => {
  it.each([
    ['MANUAL_ONLY', 'runtime:shop', true, undefined, 'OFF'],
    ['AUTO_ALLOWED', 'runtime:shop', false, 'SUCCEEDED', 'PREPARING'],
    ['AUTO_ALLOWED', 'runtime:shop', true, undefined, 'PREPARING'],
    ['AUTO_ALLOWED', 'runtime:shop', true, 'PENDING', 'PREPARING'],
    ['AUTO_ALLOWED', 'runtime:shop', true, 'RUNNING', 'PREPARING'],
    ['AUTO_ALLOWED', 'runtime:shop', true, 'SUCCEEDED', 'READY'],
    ['AUTO_ALLOWED', 'runtime:shop', true, 'PARTIAL_SUCCESS', 'DEGRADED'],
    ['AUTO_ALLOWED', 'runtime:shop', true, 'FAILED', 'FAILED'],
    // A seeded identifier is provenance only. It must never substitute for a
    // durable successful learning result when deciding whether auto send is
    // safe to enable.
    ['AUTO_ALLOWED', 'shop_mia_fashion', true, undefined, 'PREPARING'],
  ] as const)('maps %s/%s/confirmed=%s/%s to %s', (mode, seedKey, settingsConfirmed, learningStatus, expected) => {
    expect(projectShopAiReadiness({ aiMode: mode, seedKey, settingsConfirmed, learningStatus })).toBe(expected);
  });
});
