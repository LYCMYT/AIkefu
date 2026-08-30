import {
  buildProductKnowledgeSource,
  classifyImportRow,
  decideRagResult,
  inferKnowledgeScope,
  parseKnowledgeCsv,
  rankKnowledgeCandidates,
  requiresDynamicFactLookup,
  versionSwitchDecision,
} from '../src/knowledge/knowledge.policy';

describe('Phase 03 knowledge policy', () => {
  it('parses quoted CSV records and keeps product identity out of SKU fields', () => {
    const parsed = parseKnowledgeCsv(
      'product_id,question,answer\nprod-1,"可以机洗吗？","可以，建议轻柔模式"\n,门店发货时间,48小时内发货',
    );

    expect(parsed.headers).toEqual(['product_id', 'question', 'answer']);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ productExternalId: 'prod-1', scope: 'PRODUCT' });
    expect(parsed.rows[1]).toMatchObject({ productExternalId: null, scope: 'STORE' });
  });

  it('rejects dynamic price, inventory and SKU facts before they become knowledge text', () => {
    expect(
      classifyImportRow({
        rowNumber: 2,
        scope: 'PRODUCT',
        productExternalId: 'p-1',
        question: '这款现在多少钱？',
        answer: '今天价格是 99 元，库存 2 件，SKU A-01',
      }),
    ).toMatchObject({ status: 'ERROR', reason: 'DYNAMIC_COMMERCE_FACT_FORBIDDEN' });

    const source = buildProductKnowledgeSource({
      title: '轻羽保温杯',
      description: '316L 不锈钢内胆。价格 99 元；库存 2 件；SKU CUP-01。建议手洗。',
    });
    expect(source).toContain('316L 不锈钢内胆');
    expect(source).toContain('建议手洗');
    expect(source).not.toMatch(/价格|库存|SKU|99|CUP-01/i);

    expect(
      classifyImportRow({
        rowNumber: 3,
        scope: 'STORE',
        productExternalId: null,
        question: '多久发货？',
        answer: '普通现货商品通常在 24 小时内发出。',
      }),
    ).toMatchObject({ status: 'VALID' });
    expect(
      classifyImportRow({
        rowNumber: 3,
        scope: 'STORE',
        productExternalId: null,
        question: '什么时候发货？',
        answer: '偏远地区通常 72 小时内发货。',
      }),
    ).toMatchObject({ status: 'VALID' });

    expect(
      classifyImportRow({
        rowNumber: 4,
        scope: 'STORE',
        productExternalId: null,
        question: '我的订单状态如何？',
        answer: '订单 123 已发货，物流单号 123456789。',
      }),
    ).toMatchObject({ status: 'ERROR', reason: 'DYNAMIC_COMMERCE_FACT_FORBIDDEN' });
    expect(
      classifyImportRow({
        rowNumber: 5,
        scope: 'STORE',
        productExternalId: null,
        question: '物流什么时候到？',
        answer: '物流预计明天到达。',
      }),
    ).toMatchObject({ status: 'ERROR', reason: 'DYNAMIC_COMMERCE_FACT_FORBIDDEN' });
    const sourceWithoutEta = buildProductKnowledgeSource({
      title: '轻羽保温杯',
      description: '316L 不锈钢内胆。物流预计明天到达。建议手洗。',
    });
    expect(sourceWithoutEta).toContain('316L 不锈钢内胆');
    expect(sourceWithoutEta).toContain('建议手洗');
    expect(sourceWithoutEta).not.toMatch(/物流|明天到达/);
    expect(
      classifyImportRow({
        rowNumber: 6,
        scope: 'STORE',
        productExternalId: null,
        question: '退款规则是什么？',
        answer: '符合退换政策的订单可在售后入口提交退款申请。',
      }),
    ).toMatchObject({ status: 'VALID' });
  });

  it('enforces workspace/tenant/shop and exact PRODUCT id before ranking', () => {
    const ranked = rankKnowledgeCandidates(
      [
        candidate('a-store', { scope: 'STORE', scoreText: '保温杯 材质' }),
        candidate('a-product', { scope: 'PRODUCT', productId: 'product-a', scoreText: '保温杯 材质 316l' }),
        candidate('b-product', {
          workspaceId: 'workspace-b',
          scope: 'PRODUCT',
          productId: 'product-a',
          scoreText: '保温杯 材质 316l',
        }),
        candidate('wrong-product', { scope: 'PRODUCT', productId: 'product-b', scoreText: '保温杯 材质 316l' }),
        candidate('not-ready', { indexStatus: 'INDEXING', scoreText: '保温杯 材质 316l' }),
      ],
      {
        workspaceId: 'workspace-a',
        tenantId: 'tenant-a',
        shopId: 'shop-a',
        productId: 'product-a',
        query: '保温杯材质',
      },
    );

    expect(ranked.map((entry) => entry.id)).toEqual(['a-product', 'a-store']);
  });

  it('fuses a scoped vector-only candidate with keyword retrieval without weakening metadata filters', () => {
    const ranked = rankKnowledgeCandidates(
      [
        candidate('semantic-hit', {
          scope: 'PRODUCT',
          productId: 'product-a',
          scoreText: '七天无理由退换规则',
          vectorScore: 0.96,
        }),
        candidate('other-workspace-semantic', {
          workspaceId: 'workspace-b',
          scope: 'PRODUCT',
          productId: 'product-a',
          scoreText: '七天无理由退换规则',
          vectorScore: 1,
        }),
      ],
      {
        workspaceId: 'workspace-a',
        tenantId: 'tenant-a',
        shopId: 'shop-a',
        productId: 'product-a',
        query: '售后问题',
      },
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ id: 'semantic-hit', lexicalScore: 0, vectorScore: 0.96 });
  });

  it('uses corpus BM25 with a small synonym expansion while preserving metadata isolation', () => {
    const ranked = rankKnowledgeCandidates(
      [
        candidate('return-policy', { scoreText: '支持七天无理由退换政策', vectorScore: 0 }),
        candidate('other-shop', { shopId: 'shop-b', scoreText: '退货退货退货', vectorScore: 1 }),
      ],
      {
        workspaceId: 'workspace-a',
        tenantId: 'tenant-a',
        shopId: 'shop-a',
        query: '可以退货吗',
      },
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ id: 'return-policy' });
    expect(ranked[0]!.bm25Score).toBeGreaterThan(0);
    // The excluded shop must not affect IDF/corpus length or be returned.
    expect(ranked.map((entry) => entry.shopId)).toEqual(['shop-a']);
  });

  it('caps topK at the frozen maximum of three even when a caller requests more', () => {
    const ranked = rankKnowledgeCandidates(
      Array.from({ length: 5 }, (_, index) => candidate(`item-${index}`, { scoreText: '保温杯材质' })),
      { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', query: '保温杯材质', topK: 99 },
    );
    expect(ranked).toHaveLength(3);
  });

  it('routes live inventory, price and order questions away from static knowledge', () => {
    expect(requiresDynamicFactLookup('现在有货吗？')).toBe(true);
    expect(requiresDynamicFactLookup('我的订单物流到哪里了？')).toBe(true);
    expect(requiresDynamicFactLookup('物流什么时候到？')).toBe(true);
    expect(requiresDynamicFactLookup('退款进度怎么样？')).toBe(true);
    expect(requiresDynamicFactLookup('普通现货商品通常多久发货？')).toBe(false);
    expect(requiresDynamicFactLookup('退款政策是什么？')).toBe(false);
    expect(requiresDynamicFactLookup('物流配送政策如何？')).toBe(false);
    expect(requiresDynamicFactLookup('黑色 XL 还有吗？')).toBe(true);
    expect(
      classifyImportRow({
        rowNumber: 6,
        scope: 'PRODUCT',
        productExternalId: 'p-1',
        question: '黑色 XL 还有吗？',
        answer: '黑色 XL 还有 2 件。',
      }),
    ).toMatchObject({ status: 'ERROR', reason: 'DYNAMIC_COMMERCE_FACT_FORBIDDEN' });
  });

  it.each([
    '明天送达',
    '预计后天送达',
    '周末配送',
    '今天发货',
    '当前优惠',
    '多久到货',
    '几天到货',
    '什么时候到货',
    '发货了吗',
    '什么时候发货',
    '配送什么时候到',
    '运费多少',
    '物流什么时候更新',
    '预计7天内发出',
    '预售商品多久发出？',
    '该款预售7天内发出',
    '预售商品七天发货',
    '本款预售中，7天后发货',
    '黑色XL还剩两件',
    '这款还有三件',
    '运费9元',
    '物流将在三天后送达',
    '该款预售下个月发出',
    '本款预售将在下个月发货',
    '本款卖99元',
    '这款只要99元',
    '本款有2件现货',
  ])('blocks relative delivery and promotion promise %s from import and runtime RAG', (dynamicText) => {
    expect(requiresDynamicFactLookup(dynamicText)).toBe(true);
    expect(
      classifyImportRow({
        rowNumber: 7,
        scope: 'STORE',
        productExternalId: null,
        question: dynamicText,
        answer: dynamicText,
      }),
    ).toMatchObject({ status: 'ERROR', reason: 'DYNAMIC_COMMERCE_FACT_FORBIDDEN' });

    const productSource = buildProductKnowledgeSource({
      title: '轻羽测试商品',
      description: `稳定材质说明。${dynamicText}。建议按标签洗护。`,
    });
    expect(productSource).toContain('稳定材质说明');
    expect(productSource).toContain('建议按标签洗护');
    expect(productSource).not.toContain(dynamicText);
  });

  it('removes concrete presale fulfillment promises from product-learning source', () => {
    const source = buildProductKnowledgeSource({
      title: '轻羽预售羽绒服',
      description: '90% 白鸭绒。该款预售7天内发出。建议专业洗护。',
    });

    expect(source).toContain('90% 白鸭绒');
    expect(source).toContain('建议专业洗护');
    expect(source).not.toMatch(/预售7天内发出/);
  });

  it('returns CONFLICTED before automatic selection and NO_EVIDENCE when nothing is eligible', () => {
    const conflicted = decideRagResult({
      candidates: [candidate('candidate', { scoreText: '材质 316l' })],
      conflicts: [candidate('conflict', { businessStatus: 'CONFLICTED', scoreText: '材质' })],
    });
    expect(conflicted).toEqual({ status: 'CONFLICTED', candidates: [], autoSelectable: false });

    expect(decideRagResult({ candidates: [], conflicts: [] })).toEqual({
      status: 'NO_EVIDENCE',
      candidates: [],
      autoSelectable: false,
    });
  });

  it('preserves the old active version unless a newly indexed version is READY', () => {
    expect(versionSwitchDecision({ currentActiveVersionId: 'v1', nextVersionId: 'v2', nextIndexStatus: 'FAILED' }))
      .toEqual({ activeVersionId: 'v1', switched: false });
    expect(versionSwitchDecision({ currentActiveVersionId: 'v1', nextVersionId: 'v2', nextIndexStatus: 'READY' }))
      .toEqual({ activeVersionId: 'v2', switched: true });
  });

  it('infers STORE/PRODUCT from productId and rejects a contradictory explicit scope', () => {
    expect(inferKnowledgeScope()).toBe('STORE');
    expect(inferKnowledgeScope('product-a')).toBe('PRODUCT');
    expect(() => inferKnowledgeScope('product-a', 'STORE')).toThrow('KNOWLEDGE_SCOPE_PRODUCT_MISMATCH');
  });
});

function candidate(
  id: string,
  overrides: Partial<{
    workspaceId: string;
    tenantId: string;
    shopId: string;
    scope: 'STORE' | 'PRODUCT';
    productId: string | null;
    businessStatus: 'ENABLED' | 'CONFLICTED';
    indexStatus: 'READY' | 'INDEXING';
    scoreText: string;
    vectorScore: number;
  }> = {},
) {
  return {
    id,
    itemId: `${id}-item`,
    versionId: `${id}-version`,
    version: 1,
    workspaceId: 'workspace-a',
    tenantId: 'tenant-a',
    shopId: 'shop-a',
    scope: 'STORE' as const,
    productId: null,
    businessStatus: 'ENABLED' as const,
    indexStatus: 'READY' as const,
    effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    effectiveTo: null,
    question: overrides.scoreText ?? '保温杯材质',
    answer: overrides.scoreText ?? '316L 不锈钢',
    sourceType: 'MANUAL' as const,
    ...overrides,
  };
}
