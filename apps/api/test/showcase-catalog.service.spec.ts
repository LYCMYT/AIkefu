import { ShowcaseCatalogService } from '../src/showcase/showcase-catalog.service';
import { SeedCatalog } from '../src/seed/seed-catalog';

describe('ShowcaseCatalogService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads the four server-owned showcase scenarios without embedding reply outputs', async () => {
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
    ]);
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
