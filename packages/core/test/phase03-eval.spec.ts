import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { retrieveHybridKnowledge, type KnowledgeDocument } from '../src/hybrid-rag';

type SeedKnowledge = {
  key: string;
  shopKey: string;
  productKey: string | null;
  scope: 'STORE' | 'PRODUCT';
  sourceType: 'MANUAL' | 'HUMAN_REVIEWED' | 'AUTO_LEARNED';
  businessStatus: KnowledgeDocument['businessStatus'];
  indexStatus: KnowledgeDocument['indexStatus'];
  question: string;
  answer: string;
};

const seed = JSON.parse(
  readFileSync(resolve(__dirname, '../../../seed/seed-data.json'), 'utf8'),
) as { knowledge: SeedKnowledge[] };

const documents: KnowledgeDocument[] = seed.knowledge.map((item) => ({
  itemId: item.key,
  versionId: `${item.key}:v1`,
  version: 1,
  workspaceId: 'eval-workspace',
  tenantId: 'eval-tenant',
  shopId: item.shopKey,
  productId: item.productKey,
  scope: item.scope,
  sourceType: item.sourceType,
  businessStatus: item.businessStatus,
  indexStatus: item.indexStatus,
  question: item.question,
  answer: item.answer,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
}));

describe('Phase 03 frozen eval cases', () => {
  it.each([
    ['E001', 'shop_mia_fashion', undefined, '多久发货？', 'k001', '24小时'],
    ['E002', 'shop_pixel_tech', undefined, '多久发货？', 'k016', '48小时'],
    ['E003', 'shop_mia_fashion', undefined, '新疆多久发货？', 'k002', '实际物流信息'],
    ['E004', 'shop_mia_fashion', 'fashion_hoodie', '这个可以烘干吗？', 'k033', '不建议使用烘干机'],
    ['E005', 'shop_pixel_tech', 'tech_silent_keyboard', '支持Mac吗？', 'k058', '支持Windows和macOS'],
  ])('%s retrieves the frozen scoped evidence', (_id, shopId, productId, query, expectedItemId, expectedFact) => {
    const result = retrieveHybridKnowledge(documents, {
      workspaceId: 'eval-workspace',
      tenantId: 'eval-tenant',
      shopId,
      ...(productId ? { productId } : {}),
      query,
      now: new Date('2026-08-27T00:00:00.000Z'),
    });

    expect(result.status).toBe('EVIDENCE');
    expect(result.evidence[0]).toMatchObject({ itemId: expectedItemId });
    expect(result.evidence[0]?.contentSnapshot.answer).toContain(expectedFact);
  });
});
