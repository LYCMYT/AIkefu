import { ShowcaseCatalogService } from '../src/showcase/showcase-catalog.service';
import { SeedCatalog } from '../src/seed/seed-catalog';

describe('ShowcaseCatalogService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads all six server-owned showcase scenarios without embedding reply outputs', async () => {
    process.env.AI_OFFLINE_MODE = '1';
    delete process.env.AI_PROVIDER;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_API_KEY_FILE;
    const catalog = await new ShowcaseCatalogService(new SeedCatalog()).catalog();

    expect(catalog.providerMode).toBe('OFFLINE');
    expect(catalog.multimodalMode).toBe('FIXTURE');
    expect(catalog.resources.products).toContainEqual({ key: 'fashion_hoodie', externalProductId: 'P-F-001' });
    expect(catalog.scenarios.map((scenario: { id: string }) => scenario.id)).toEqual([
      'SC-01-PRODUCT-CARE',
      'SC-02-MULTI-TURN',
      'SC-03-STALE-REPLAN',
      'SC-04-IMAGE-HUMAN',
      'SC-05-SAFE-GREETING',
      'SC-06-SHOP-AI-OFF',
    ]);
    expect(catalog.scenarios.find((scenario) => scenario.id === 'SC-05-SAFE-GREETING')).toMatchObject({
      aiMode: 'AUTO_ALLOWED',
      expected: expect.objectContaining({ mustContainSemantic: ['您好，我在的'], noKnowledgeEvidence: true }),
    });
    expect(catalog.scenarios.find((scenario) => scenario.id === 'SC-06-SHOP-AI-OFF')).toMatchObject({
      aiMode: 'AUTO_ALLOWED',
      steps: expect.arrayContaining([
        expect.objectContaining({ action: 'SET_SHOP_AI_MODE', mode: 'MANUAL_ONLY' }),
        expect.objectContaining({ action: 'WAIT_FOR_NO_AI_ARTIFACTS' }),
        expect.objectContaining({ action: 'SET_SHOP_AI_MODE', mode: 'AUTO_ALLOWED' }),
      ]),
    });
    expect(catalog.scenarios.find((scenario) => scenario.id === 'SC-01-PRODUCT-CARE')).toMatchObject({
      expected: expect.objectContaining({
        context: { productKey: 'fashion_hoodie' },
        terminalMode: 'AUTO',
        evidence: {
          minimumCount: 1,
          mustIncludeScopes: ['PRODUCT'],
          productKey: 'fashion_hoodie',
        },
        mustIncludeTraceStages: [
          'USER_TURN', 'TASKS', 'CONTEXT', 'EVIDENCE', 'REPLY_POLICY', 'SEND_GUARD', 'SEND_RECEIPT',
        ],
      }),
    });
    expect(catalog.scenarios.find((scenario) => scenario.id === 'SC-02-MULTI-TURN')).toMatchObject({
      objective: '证明短消息聚合、实时库存、尺码知识缺口安全降级和后续指代继承。',
      expected: expect.objectContaining({
        context: { productKey: 'fashion_hoodie' },
        noKnowledgeEvidence: true,
        terminalMode: 'ASSIST',
      }),
    });
    expect(catalog.scenarios.find((scenario) => scenario.id === 'SC-02-MULTI-TURN')?.expected).not.toHaveProperty('evidence');
    expect(JSON.stringify(catalog.scenarios)).not.toContain('hardcodedReply');
  });

  it('reports unavailable rather than pretending an unconfigured production model is real', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AI_OFFLINE_MODE;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_API_KEY_FILE;

    await expect(new ShowcaseCatalogService(new SeedCatalog()).catalog()).resolves.toMatchObject({ providerMode: 'UNAVAILABLE' });
  });
});
