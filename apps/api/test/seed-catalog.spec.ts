import { SeedCatalog } from '../src/seed/seed-catalog';
import { containsDynamicCommerceFact } from '../src/knowledge/knowledge.policy';
import { normalizeWorkflowGraph } from '../src/workflow/workflow-graph';
import { validateWorkflowGraph } from '@ai-customer-service/core';

describe('synthetic seed catalog', () => {
  it('loads the frozen Phase 01 counts with unique, valid references', async () => {
    const seed = await new SeedCatalog().load();

    expect({
      shops: seed.shops.length,
      buyers: seed.buyers.length,
      products: seed.products.length,
      orders: seed.orders.length,
      knowledge: seed.knowledge.length,
      workflows: seed.workflows.length,
    }).toEqual({ shops: 2, buyers: 4, products: 10, orders: 10, knowledge: 80, workflows: 2 });

    const shopKeys = new Set(seed.shops.map(({ key }) => key));
    const buyerKeys = new Set(seed.buyers.map(({ key }) => key));
    const productKeys = new Set(seed.products.map(({ key }) => key));
    const skuKeys = new Set(seed.products.flatMap(({ skus }) => skus.map(({ externalSkuId }) => externalSkuId)));

    expect(shopKeys.size).toBe(seed.shops.length);
    expect(buyerKeys.size).toBe(seed.buyers.length);
    expect(productKeys.size).toBe(seed.products.length);
    expect(seed.products.every(({ shopKey }) => shopKeys.has(shopKey))).toBe(true);
    expect(seed.orders.every(({ shopKey, buyerKey, productKey, sku }) =>
      shopKeys.has(shopKey) && buyerKeys.has(buyerKey) && productKeys.has(productKey) && skuKeys.has(sku),
    )).toBe(true);
    expect(seed.knowledge.every(({ shopKey, productKey }) =>
      shopKeys.has(shopKey) && (productKey === null || productKeys.has(productKey)),
    )).toBe(true);
    expect(
      seed.knowledge
        .filter(({ businessStatus, indexStatus }) => businessStatus === 'ENABLED' && indexStatus === 'READY')
        .filter(({ question, answer }) => containsDynamicCommerceFact(`${question}\n${answer}`)),
    ).toEqual([]);
  });

  it('normalizes both frozen workflow graphs to the canonical source/target graph with bounded settings', async () => {
    const seed = await new SeedCatalog().load();
    expect(seed.workflows).toHaveLength(2);
    for (const workflow of seed.workflows) {
      const graph = normalizeWorkflowGraph(workflow.graph);
      expect(graph).not.toBeNull();
      expect(graph!.edges.every((edge) => edge.source && edge.target)).toBe(true);
      expect(validateWorkflowGraph(graph!)).toEqual({ valid: true, errors: [] });
    }
    const afterSales = normalizeWorkflowGraph(seed.workflows.find((workflow) => workflow.key === 'wf_after_sales_template')!.graph)!;
    const condition = afterSales.nodes.find((node) => node.type === 'CONDITION')!;
    expect(afterSales.edges.filter((edge) => edge.source === condition.id).map((edge) => edge.condition).sort()).toEqual(['false', 'true']);
  });

  it('provides idempotent frozen EvalCase fixtures without pretending they are production metrics', async () => {
    const seed = await new SeedCatalog().load();
    expect(seed.evalCases).toHaveLength(36);
    expect(seed.evalCases.map((entry) => entry.key)).toEqual(expect.arrayContaining(['fixed:E001', 'fixed:E036']));
    expect(seed.evalCases.find((entry) => entry.key === 'fixed:E001')).toMatchObject({
      shopKey: 'shop_mia_fashion',
      input: { buyerKey: 'buyer_001', messages: ['多久发货？'] },
      expected: { category: 'STORE_FAQ', tasks: ['SHIPPING_POLICY'], mode: 'ASSIST' },
      assertions: { forbiddenClaims: ['保证24小时到达'] },
    });
    expect(seed.evalCases.every((entry) => entry.expected && entry.assertions)).toBe(true);
    expect(seed.evalCases.every((entry) => !entry.shopKey || seed.shops.some((shop) => shop.key === entry.shopKey))).toBe(true);
  });
});
