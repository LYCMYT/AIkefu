import { retrieveHybridKnowledge, type KnowledgeDocument } from '../src/hybrid-rag';

const base: KnowledgeDocument = {
  itemId: 'k1',
  versionId: 'kv1',
  version: 1,
  workspaceId: 'w1',
  tenantId: 't1',
  shopId: 's1',
  productId: null,
  scope: 'STORE',
  sourceType: 'MANUAL',
  businessStatus: 'ENABLED',
  indexStatus: 'READY',
  question: '多久发货',
  answer: '普通现货商品通常24小时内发出',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  vector: [1, 0],
};

describe('Hybrid RAG', () => {
  it('hard-filters workspace, tenant, shop, product, status and effective time before ranking', () => {
    const documents: KnowledgeDocument[] = [
      base,
      { ...base, itemId: 'wrong-shop', versionId: 'wrong-shop-v1', shopId: 's2', answer: '48小时' },
      { ...base, itemId: 'wrong-workspace', versionId: 'wrong-workspace-v1', workspaceId: 'w2' },
      { ...base, itemId: 'disabled', versionId: 'disabled-v1', businessStatus: 'DISABLED' },
      { ...base, itemId: 'indexing', versionId: 'indexing-v1', indexStatus: 'INDEXING' },
      {
        ...base,
        itemId: 'product-a',
        versionId: 'product-a-v1',
        scope: 'PRODUCT',
        productId: 'p1',
        question: '可以烘干吗',
        answer: '不建议使用烘干机',
      },
      {
        ...base,
        itemId: 'product-b',
        versionId: 'product-b-v1',
        scope: 'PRODUCT',
        productId: 'p2',
      },
    ];

    const result = retrieveHybridKnowledge(documents, {
      workspaceId: 'w1',
      tenantId: 't1',
      shopId: 's1',
      productId: 'p1',
      query: '可以烘干吗',
      queryVector: [1, 0],
      now: new Date('2026-08-27T00:00:00.000Z'),
    });

    expect(result.status).toBe('EVIDENCE');
    expect(result.evidence.map((item) => item.itemId)).toEqual(['product-a', 'k1']);
    expect(result.evidence.every((item) => item.contentSnapshot.answer !== '48小时')).toBe(true);
  });

  it('returns CONFLICTED instead of choosing one side', () => {
    const result = retrieveHybridKnowledge(
      [
        { ...base, itemId: 'left', versionId: 'left-v1', businessStatus: 'CONFLICTED', answer: '24小时发货' },
        { ...base, itemId: 'right', versionId: 'right-v1', businessStatus: 'CONFLICTED', answer: '48小时发货' },
      ],
      {
        workspaceId: 'w1',
        tenantId: 't1',
        shopId: 's1',
        query: '多久发货',
        queryVector: [1, 0],
        now: new Date('2026-08-27T00:00:00.000Z'),
      },
    );

    expect(result).toMatchObject({ status: 'CONFLICTED', evidence: [] });
    expect(result.conflictItemIds).toEqual(['left', 'right']);
  });

  it('refuses dynamic inventory/order/logistics facts and does not consult RAG', () => {
    const result = retrieveHybridKnowledge([base], {
      workspaceId: 'w1',
      tenantId: 't1',
      shopId: 's1',
      query: '黑色 XL 还有库存吗',
      factClass: 'INVENTORY',
      now: new Date('2026-08-27T00:00:00.000Z'),
    });

    expect(result).toEqual({ status: 'DYNAMIC_FACT_REQUIRED', evidence: [], conflictItemIds: [] });
  });

  it('returns an immutable evidence snapshot and at most Top K 3', () => {
    const result = retrieveHybridKnowledge(
      Array.from({ length: 5 }, (_, index) => ({
        ...base,
        itemId: `k${index}`,
        versionId: `kv${index}`,
        answer: `answer ${index}`,
      })),
      {
        workspaceId: 'w1',
        tenantId: 't1',
        shopId: 's1',
        query: '多久发货',
        queryVector: [1, 0],
        now: new Date('2026-08-27T00:00:00.000Z'),
      },
    );

    expect(result.evidence).toHaveLength(3);
    expect(result.evidence[0]).toMatchObject({
      version: 1,
      source: 'MANUAL',
      scope: 'STORE',
      contentSnapshot: { question: '多久发货', answer: 'answer 0' },
    });
  });
});
