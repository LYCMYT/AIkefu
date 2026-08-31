import { SeedCatalog } from '../src/seed/seed-catalog';
import { containsDynamicCommerceFact } from '../src/knowledge/knowledge.policy';
import { normalizeWorkflowGraph } from '../src/workflow/workflow-graph';
import { validateWorkflowGraph } from '@ai-customer-service/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

    const byShop = Object.fromEntries([...shopKeys].map((shopKey) => [shopKey, seed.knowledge.filter((entry) => entry.shopKey === shopKey)]));
    expect(Object.fromEntries(Object.entries(byShop).map(([shopKey, entries]) => [shopKey, entries.length]))).toEqual({
      shop_mia_fashion: 40,
      shop_pixel_tech: 40,
    });
    expect(seed.knowledge.filter((entry) => entry.scope === 'STORE')).toHaveLength(30);
    expect(seed.knowledge.filter((entry) => entry.scope === 'PRODUCT')).toHaveLength(50);
    expect(seed.knowledge.filter((entry) => entry.sourceType === 'MANUAL')).toHaveLength(50);
    expect(seed.knowledge.filter((entry) => entry.sourceType === 'AUTO_LEARNED')).toHaveLength(20);
    expect(seed.knowledge.filter((entry) => entry.sourceType === 'HUMAN_REVIEWED')).toHaveLength(10);
    expect(seed.knowledge.filter((entry) => entry.scope === 'STORE').every((entry) => entry.productKey === null)).toBe(true);
    expect(seed.knowledge.filter((entry) => entry.scope === 'PRODUCT').every((entry) => entry.productKey !== null)).toBe(true);

    expect(Object.fromEntries(seed.knowledge.filter((entry) => ['k019', 'k027', 'k055', 'k075'].includes(entry.key)).map((entry) => [entry.key, { question: entry.question, answer: entry.answer }]))).toEqual({
      k019: { question: '支持Windows吗？', answer: '是否支持 Windows 取决于具体商品和系统版本，请发送商品卡或商品名称后确认。' },
      k027: { question: '支持增值税专用发票吗？', answer: '开票类型和所需抬头资料需结合订单与店铺规则，由人工确认。' },
      k055: { question: '下架商品的历史订单还能申请售后吗？', answer: '已购买订单仍可按订单页和店铺售后政策申请处理；是否可继续购买以实时商品状态为准。' },
      k075: { question: '有哪些颜色规格？', answer: '商品规格包含黑色和白色，具体可售颜色与库存以实时 SKU 信息为准。' },
    });
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

  it('keeps showcase, no-answer, fixture and Eval assets outside runtime knowledge', async () => {
    const seed = await new SeedCatalog().load();
    const repositoryRoot = resolve(__dirname, '../../..');
    const noAnswer = JSON.parse(readFileSync(resolve(repositoryRoot, 'seed/no-answer-topics.json'), 'utf8')) as {
      topics: Array<{ id: string; topic: string; examples: string[]; safeCustomerMessage: string }>;
    };
    const showcase = JSON.parse(readFileSync(resolve(repositoryRoot, 'seed/showcase-scenarios.json'), 'utf8')) as {
      rules: { resultsMustComeFromRuntime: boolean; hardcodedReplyForbidden: boolean; evalAssertionsMustNotEnterRag: boolean };
      scenarios: Array<{ id: string; steps: Array<Record<string, unknown>> }>;
    };
    const knowledgeText = seed.knowledge.map((entry) => `${entry.key}\n${entry.question}\n${entry.answer}`).join('\n');

    expect(noAnswer.topics).toHaveLength(7);
    expect(showcase.scenarios.map((scenario) => scenario.id)).toEqual([
      'SC-01-PRODUCT-CARE',
      'SC-02-MULTI-TURN',
      'SC-03-STALE-REPLAN',
      'SC-04-IMAGE-HUMAN',
      'SC-05-SAFE-GREETING',
      'SC-06-SHOP-AI-OFF',
    ]);
    expect(showcase.rules).toEqual({
      resultsMustComeFromRuntime: true,
      hardcodedReplyForbidden: true,
      evalAssertionsMustNotEnterRag: true,
    });
    expect(knowledgeText).not.toMatch(/\bE0\d{2}\b|AICS_FIXTURE:/);
    for (const topic of noAnswer.topics) {
      expect(knowledgeText).not.toContain(topic.safeCustomerMessage);
      expect(seed.knowledge.some((entry) => topic.examples.includes(entry.question))).toBe(false);
    }
  });
});
