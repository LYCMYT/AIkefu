import { ConflictException } from '@nestjs/common';
import { ReplyRuntimeService, customerFacingHandoffText, evidenceTaskBindingKey, explicitOrderMatches, explicitProductMatches, explicitSkuMatches, intentInferenceText, knowledgeRetrievalQuery, knowledgeScopesForTask, productCatalogReply, productQuestionNeedsLiveFact, requestedColorInventory, selectEvidenceReply, shippingPromiseBoundaryReply, taskBoundReusableEvidence } from '../src/replies/reply-runtime.service';

describe('knowledgeScopesForTask', () => {
  it('reuses frozen evidence only for the task that originally retrieved it', () => {
    const shippingKey = evidenceTaskBindingKey({
      intent: 'SHIPPING_POLICY', requiredContext: [], requiredKnowledge: ['STORE'],
    });
    const invoiceKey = evidenceTaskBindingKey({
      intent: 'FAQ_QUERY', requiredContext: [], requiredKnowledge: ['STORE'],
    });
    const evidence = [
      {
        taskKey: shippingKey, itemId: 'shipping', versionId: 'shipping-v1', version: 1,
        source: 'MANUAL' as const, scope: 'STORE' as const, productId: null,
        contentSnapshot: { question: '多久发货？', answer: '24小时内发货。' }, retrievalScore: 1,
      },
      {
        taskKey: invoiceKey, itemId: 'invoice', versionId: 'invoice-v1', version: 1,
        source: 'MANUAL' as const, scope: 'STORE' as const, productId: null,
        contentSnapshot: { question: '能开发票吗？', answer: '支持电子发票。' }, retrievalScore: 1,
      },
      {
        itemId: 'legacy', versionId: 'legacy-v1', version: 1,
        source: 'MANUAL' as const, scope: 'STORE' as const, productId: null,
        contentSnapshot: { question: '旧证据', answer: '不能跨任务复用。' }, retrievalScore: 1,
      },
    ];

    expect(taskBoundReusableEvidence(evidence, shippingKey, ['STORE'])).toEqual([evidence[0]]);
    expect(taskBoundReusableEvidence(evidence, invoiceKey, ['STORE'])).toEqual([evidence[1]]);
    expect(shippingKey).not.toBe(invoiceKey);
    expect(evidenceTaskBindingKey({
      intent: 'SHIPPING_POLICY', requiredContext: ['SKU', 'PRODUCT'], requiredKnowledge: ['PRODUCT', 'STORE'],
    })).toBe(evidenceTaskBindingKey({
      intent: 'SHIPPING_POLICY', requiredContext: ['PRODUCT', 'SKU'], requiredKnowledge: ['STORE', 'PRODUCT'],
    }));
  });

  it('honors an explicit policy-evidence requirement on a dynamic or transactional task', () => {
    expect(knowledgeScopesForTask({ intent: 'ORDER_QUERY', requiredKnowledge: ['STORE'] }, undefined)).toEqual(['STORE']);
    expect(knowledgeScopesForTask({ intent: 'REFUND_REQUEST', requiredKnowledge: ['STORE'] }, undefined)).toEqual(['STORE']);
    expect(knowledgeScopesForTask({ intent: 'SHIPPING_POLICY', requiredKnowledge: ['STORE'] }, undefined)).toEqual(['STORE']);
  });

  it('removes transport card markers without discarding sanitized image observations', () => {
    expect(knowledgeRetrievalQuery('[商品卡]\n这个适合冬天吗？')).toBe('这个适合冬天吗？');
    expect(knowledgeRetrievalQuery('今天下单什么时候发货？')).toBe('什么时候发货？');
    expect(knowledgeRetrievalQuery('黑色XL有吗？今天下单什么时候发货？')).toBe('黑色XL有吗？什么时候发货？');
    expect(knowledgeRetrievalQuery('黑色XL有吗？今天下单什么时候发货？', 'SHIPPING_POLICY')).toBe('多久发货');
    expect(knowledgeRetrievalQuery('黑色XL有吗？今天下单什么时候发？', 'SHIPPING_POLICY')).toBe('多久发货');
    expect(knowledgeRetrievalQuery('什么时候发货？支持退货吗？', 'AFTER_SALES_QUERY')).toBe('支持退货');
    expect(knowledgeRetrievalQuery('这个能烘干吗？黑色XL还有吗？', 'PRODUCT_QUERY')).toBe('可以烘干吗');
    expect(knowledgeRetrievalQuery('帮我查物流，我还想退款。', 'REFUND_REQUEST')).toBe('可以退款吗');
    expect(knowledgeRetrievalQuery('你们能保证周五之前送到吗？')).toBe('多久发货');
    expect(knowledgeRetrievalQuery('那水洗呢？')).toBe('怎么洗');
    expect(knowledgeRetrievalQuery('[订单卡]\n[图片 PRODUCT_DAMAGE] 疑似商品破损\n收到就是这样的'))
      .toBe('疑似商品破损 收到就是这样的');
    expect(shippingPromiseBoundaryReply('你们能保证周五之前送到吗？')).toContain('不能保证具体到达日期');
    expect(shippingPromiseBoundaryReply('什么时候发货？')).toBeUndefined();
    expect(productQuestionNeedsLiveFact('这个能烘干吗？')).toBe(false);
    expect(productQuestionNeedsLiveFact('这个现在还能买吗？')).toBe(true);
    expect(productCatalogReply('这个商品有什么特点？', {
      description: '70%棉、30%聚酯纤维，宽松版型，适合春秋日常穿着。',
    })).toBe('这款商品的主要特点是：70%棉、30%聚酯纤维，宽松版型，适合春秋日常穿着。');
    expect(productCatalogReply('这个是什么材质？', { description: '70%棉、30%聚酯纤维。' })).toBeUndefined();
  });
});

describe('intentInferenceText', () => {
  it('adds only the previous buyer ask for an elliptical follow-up', () => {
    const recentMessages = [
      { role: 'BUYER', text: '昨天那单呢？', sequence: 2 },
      { role: 'ASSISTANT', text: '这笔订单已发货。', sequence: 3 },
      { role: 'BUYER', text: '还是它。', sequence: 4 },
    ];

    expect(intentInferenceText('还是它。', recentMessages)).toBe('昨天那单呢？\n还是它。');
    expect(intentInferenceText('我想问物流', recentMessages)).toBe('我想问物流');
  });
});

describe('explicitOrderMatches', () => {
  const orders = [
    { externalOrderId: 'PT-006', product: { title: 'SilentKey 84 静音键盘' } },
    { externalOrderId: 'PT-007', product: { title: 'ViewGo 15.6英寸便携屏' } },
  ];

  it('uses a unique customer product phrase without treating generic logistics wording as a selection', () => {
    expect(explicitOrderMatches(orders, '键盘那个')).toEqual([orders[0]]);
    expect(explicitOrderMatches(orders, '我的快递怎么没动？')).toEqual([]);
  });
});

describe('customer-facing resolver copy', () => {
  it('prefers the most query-specific frozen evidence answer over a generic higher-ranked answer', () => {
    expect(selectEvidenceReply([
      {
        contentSnapshot: { question: '多久发货？', answer: '普通现货商品通常在24小时内发出。' },
      },
      {
        contentSnapshot: { question: '偏远地区多久发货？', answer: '新疆、西藏等偏远地区的履约时效以实际物流信息为准。' },
      },
    ], '新疆多久发货？')).toBe('新疆、西藏等偏远地区的履约时效以实际物流信息为准。');
  });

  it('uses an explicit product phrase to exclude unrelated same-color SKUs', () => {
    const rows = [
      { externalSkuId: 'P-T-001-BLACK', attributesJson: { color: '黑色', switch: '静音轴' }, product: { title: 'SilentKey 84 静音键盘' } },
      { externalSkuId: 'P-T-004-BLACK', attributesJson: { color: '黑色' }, product: { title: 'AirMouse 轻量无线鼠标' } },
    ];

    expect(explicitSkuMatches(rows, '黑色静音键盘有吗？')).toEqual([rows[0]]);
  });

  it('aggregates multiple requested colors from the current product only', () => {
    const inventory = requestedColorInventory([
      { productId: 'product-current', inventory: 0, attributesJson: { color: '黑色', size: 'M' } },
      { productId: 'product-current', inventory: 0, attributesJson: { color: '黑色', size: 'L' } },
      { productId: 'product-current', inventory: 2, attributesJson: { color: '白色', size: 'M' } },
      { productId: 'product-current', inventory: 5, attributesJson: { color: '白色', size: 'L' } },
      { productId: 'product-other', inventory: 99, attributesJson: { color: '黑色', size: 'M' } },
    ], 'product-current', '黑色和白色哪个有货？');

    expect(inventory).toEqual({ 黑色: 0, 白色: 7 });
  });

  it('separates customer handoff copy from internal reasons without claiming an action completed', () => {
    expect(customerFacingHandoffText(['HUMAN_REQUEST'], 'USER_REQUESTED_HUMAN')).toContain('人工客服');
    expect(customerFacingHandoffText(['COMPLAINT'], 'HIGH_RISK_TASK')).toContain('投诉');
    expect(customerFacingHandoffText(['REFUND_REQUEST'], 'HIGH_RISK_TASK')).toContain('退款');
    expect(customerFacingHandoffText(['FAQ_QUERY'], 'NO_EVIDENCE')).toContain('暂时没有找到可靠依据');
    for (const text of [
      customerFacingHandoffText(['HUMAN_REQUEST'], 'USER_REQUESTED_HUMAN'),
      customerFacingHandoffText(['COMPLAINT'], 'HIGH_RISK_TASK'),
      customerFacingHandoffText(['REFUND_REQUEST'], 'HIGH_RISK_TASK'),
    ]) {
      expect(text).not.toBe('请人工处理此会话。');
      expect(text).not.toMatch(/已退款|退款成功|已赔付|已补偿/);
    }
  });
});

describe('ReplyRuntimeService', () => {
  it('selects an explicitly named product beyond the three most recently updated products', () => {
    const rows = [
      { title: 'CodeBoard 75 机械键盘' }, { title: 'AirMouse 轻量无线鼠标' },
      { title: 'GaN 100W 三口充电器' }, { title: 'SilentKey 84 静音键盘' },
    ];
    expect(explicitProductMatches(rows, 'SilentKey 84支持什么连接方式？')).toEqual([rows[3]]);
  });
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

  it('keeps the conversation product for a pronoun-only follow-up after checking current-turn text', async () => {
    const repository = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'product-other-1', title: '柔软针织开衫' },
          { id: 'product-other-2', title: '轻羽绒服' },
          { id: 'product-other-3', title: '牛仔裤' },
        ]),
        findFirst: jest.fn().mockResolvedValue({ id: 'product-current', title: '轻薄连帽卫衣' }),
      },
    };
    const service = new ReplyRuntimeService({} as never, {} as never, {} as never, {} as never, {} as never);

    await expect((service as never as { contextCandidates: Function }).contextCandidates(
      repository,
      scope,
      'buyer-a',
      'PRODUCT',
      { preferredId: 'product-current', text: '那白色呢？' },
    )).resolves.toEqual([{ id: 'product-current', kind: 'PRODUCT', label: '轻薄连帽卫衣' }]);
    expect(repository.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'product-current', ...scope },
    }));
  });

  it('treats two different current-turn goods cards as an ambiguity instead of falling back to currentProductId', async () => {
    const repository = {
      message: { findMany: jest.fn().mockResolvedValue([
        { kind: 'GOODS_CARD', contentJson: { productId: 'product-a' } },
        { kind: 'GOODS_CARD', contentJson: { productId: 'product-b' } },
      ]) },
      product: { findMany: jest.fn().mockResolvedValue([
        { id: 'product-a', title: '轻量键盘 A' },
        { id: 'product-b', title: '轻量键盘 B' },
      ]) },
    };
    const service = new ReplyRuntimeService({ message: repository.message, product: repository.product } as never, {} as never, {} as never, {} as never, {} as never);

    const contexts = await (service as never as { resolveTaskContexts: Function }).resolveTaskContexts(
      scope,
      {
        sourceContextVersion: 5,
        conversation: { id: 'conversation-a', contextVersion: 5, buyerId: 'buyer-a', currentProductId: 'product-b' },
        userTurn: { normalizedText: '这两个型号哪个更轻？', sourceMessageIdsJson: ['card-a', 'card-b'] },
      },
      [{ id: 'weight', riskLevel: 'LOW', requiredContext: ['PRODUCT'] }],
    );

    expect(contexts.get('weight')).toMatchObject({
      status: 'AMBIGUOUS', entity: null,
      clarification: { requests: [expect.objectContaining({ kind: 'PRODUCT', question: '请问您咨询的是哪件商品？' })] },
    });
  });

  it('asks for a product before SKU when an inventory question has no current product or goods card', async () => {
    const repository = {
      message: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([
        { id: 'product-a', title: '轻薄连帽卫衣' },
        { id: 'product-b', title: '宽松针织开衫' },
      ]) },
      productSku: { findMany: jest.fn().mockResolvedValue([
        { id: 'sku-a-black', productId: 'product-a', externalSkuId: 'P-F-001-BLACK', inventory: 3, price: 99, attributesJson: { color: '黑色' } },
        { id: 'sku-b-black', productId: 'product-b', externalSkuId: 'P-F-002-BLACK', inventory: 3, price: 99, attributesJson: { color: '黑色' } },
      ]) },
    };
    const service = new ReplyRuntimeService({ message: repository.message, product: repository.product, productSku: repository.productSku } as never, {} as never, {} as never, {} as never, {} as never);

    const contexts = await (service as never as { resolveTaskContexts: Function }).resolveTaskContexts(
      scope,
      {
        sourceContextVersion: 5,
        conversation: { id: 'conversation-a', contextVersion: 5, buyerId: 'buyer-a', currentProductId: null },
        userTurn: { normalizedText: '黑色和白色都有货吗？', sourceMessageIdsJson: [] },
      },
      [{ id: 'inventory', riskLevel: 'LOW', requiredContext: ['PRODUCT', 'SKU'] }],
    );

    expect(contexts.get('inventory')).toMatchObject({
      status: 'AMBIGUOUS', entity: null,
      clarification: { requests: [expect.objectContaining({ kind: 'PRODUCT', question: '请问您咨询的是哪件商品？' })] },
    });
    expect(repository.productSku.findMany).not.toHaveBeenCalled();
  });

  it('continues from a uniquely named product to its matching SKU in the same inventory turn', async () => {
    const repository = {
      message: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([
        { id: 'product-keyboard', title: 'SilentKey 84 静音键盘' },
        { id: 'product-mouse', title: 'AirMouse 轻量无线鼠标' },
      ]) },
      productSku: { findMany: jest.fn().mockResolvedValue([
        { id: 'sku-keyboard-black', productId: 'product-keyboard', externalSkuId: 'P-T-001-BLACK', inventory: 9, price: 299, attributesJson: { color: '黑色', switch: '静音轴' }, product: { title: 'SilentKey 84 静音键盘' } },
        { id: 'sku-mouse-black', productId: 'product-mouse', externalSkuId: 'P-T-004-BLACK', inventory: 13, price: 169, attributesJson: { color: '黑色' }, product: { title: 'AirMouse 轻量无线鼠标' } },
      ]) },
    };
    const service = new ReplyRuntimeService({ message: repository.message, product: repository.product, productSku: repository.productSku } as never, {} as never, {} as never, {} as never, {} as never);

    const contexts = await (service as never as { resolveTaskContexts: Function }).resolveTaskContexts(
      scope,
      {
        sourceContextVersion: 5,
        conversation: { id: 'conversation-a', contextVersion: 5, buyerId: 'buyer-a', currentProductId: null },
        userTurn: { normalizedText: '黑色静音键盘有吗？另外我昨天那个订单到哪了？', sourceMessageIdsJson: [] },
      },
      [{ id: 'inventory', riskLevel: 'LOW', requiredContext: ['PRODUCT', 'SKU'] }],
    );

    expect(contexts.get('inventory')).toMatchObject({
      status: 'RESOLVED',
      entity: { id: 'sku-keyboard-black', kind: 'SKU' },
    });
    expect(repository.productSku.findMany).toHaveBeenCalled();
  });

  it('treats a draft persistence race with a newly stale job as an idempotent stale result', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'reply-raced', status: 'PENDING', mode: 'MANUAL', conversationId: 'conversation-a', userTurnId: 'turn-a',
          sourceLastMessageId: 'message-1', sourceSequence: 1, sourceContextVersion: 2, evidences: [],
          conversation: { id: 'conversation-a', contextVersion: 2, humanActive: false, state: 'ACTIVE' },
          userTurn: { normalizedText: '转人工' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const drafts = {
      createWaitingHuman: jest.fn().mockRejectedValue(new ConflictException({
        code: 'REPLY_JOB_NOT_DRAFTABLE', message: 'Reply job is no longer draftable',
      })),
    };
    const service = new ReplyRuntimeService(
      prisma as never,
      {} as never,
      {} as never,
      drafts as never,
      {} as never,
    );

    await expect(service.process(scope, 'reply-raced')).resolves.toEqual({
      status: 'STALE', reason: 'REPLY_DRAFT_RACE_LOST',
    });
  });

  it('freezes scoped knowledge evidence before the sanitized REPLY_GENERATION call and creates an ASSIST draft', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'reply-a', status: 'PENDING', mode: 'ASSIST', conversationId: 'conversation-a', userTurnId: 'turn-a',
          sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5,
          evidences: [],
          conversation: { id: 'conversation-a', buyerId: 'buyer-a', contextVersion: 5, humanActive: false, state: 'ACTIVE' },
          userTurn: { normalizedText: '请结合之前的对话说明新疆发货安排。' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyEvidence: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'ASSIST_ONLY', platform: 'DOUYIN_DEMO' }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({
        tone: '亲切简洁', logisticsPolicy: '默认承运方以订单物流为准。',
        shippingPolicy: '偏远地区以实际物流信息为准。', afterSalesPolicy: '售后需人工确认。',
        forbiddenTermsJson: [], transferKeywordsJson: [],
      }) },
      task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversationMemory: { findFirst: jest.fn().mockResolvedValue({ narrative: '买家偏好黑色。', structuredFactsJson: { openQuestions: ['确认尺码'], orderStatus: 'SHIPPED' }, status: 'CLEAN' }) },
      customerMemory: { findMany: jest.fn().mockResolvedValue([
        { type: 'PREFERENCE', key: 'color', valueJson: { preferred: 'black' } },
        { type: 'PREFERENCE', key: 'phone', valueJson: { phone: '13800138000' } },
      ]) },
      message: { findMany: jest.fn().mockResolvedValue([
        { role: 'BUYER', kind: 'TEXT', contentJson: { text: '那新疆呢？' }, sequence: 8 },
        { role: 'ASSISTANT', kind: 'TEXT', contentJson: { text: '普通地区通常更快。' }, sequence: 7 },
      ]) },
    };
    const knowledge = {
      search: jest.fn().mockResolvedValue({
        status: 'EVIDENCE', conflictItemIds: [], evidence: [{
          itemId: 'knowledge-a', versionId: 'version-a', version: 3, source: 'MANUAL', scope: 'STORE', productId: null,
          contentSnapshot: { question: '偏远地区多久发货？', answer: '偏远地区通常 72 小时内发货。' }, retrievalScore: 0.94,
        }],
      }),
    };
    const runtime = {
      runStructured: jest.fn()
        .mockResolvedValueOnce({ output: { tasks: [{ intent: 'SHIPPING_POLICY', riskLevel: 'MEDIUM', requiredContext: [], requiredTools: [] }] } })
        .mockResolvedValueOnce({ output: { riskLevel: 'MEDIUM', reasons: [], recommendedMode: 'ASSIST' } })
        .mockResolvedValueOnce({ output: { text: '新疆等偏远地区通常 72 小时内发货。', requiresHuman: false }, provider: 'offline', model: 'offline-v1', fallbackUsed: false, invocationId: 'invocation-a' }),
    };
    const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-a', status: 'WAITING_HUMAN' }) };
    const outboxes = { enqueue: jest.fn() };
    const traces = { record: jest.fn().mockResolvedValue({}) };
    const service = new ReplyRuntimeService(
      prisma as never,
      knowledge as never,
      runtime as never,
      drafts as never,
      outboxes as never,
      undefined,
      undefined,
      traces as never,
    );

    await expect(service.process(scope, 'reply-a')).resolves.toMatchObject({ status: 'WAITING_HUMAN', draftId: 'draft-a' });
    await Promise.resolve();

    expect(knowledge.search).toHaveBeenCalledWith(scope, { shopId: 'shop-a', query: '请结合之前的对话说明新疆发货安排。', scope: 'STORE', topK: 3 });
    expect(traces.record).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conversation-a', replyJobId: 'reply-a' }),
      'reply-job:reply-a',
      'EVIDENCE',
      expect.objectContaining({
        evidenceRefs: [{ itemId: 'knowledge-a', versionId: 'version-a', scope: 'STORE', productId: null }],
      }),
    );
    expect(prisma.replyEvidence.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', replyJobId: 'reply-a',
      taskKey: evidenceTaskBindingKey({ intent: 'SHIPPING_POLICY', requiredContext: [], requiredKnowledge: ['STORE'] }),
      knowledgeItemId: 'knowledge-a', knowledgeVersionId: 'version-a',
      retrievedContentSnapshotJson: { question: '偏远地区多久发货？', answer: '偏远地区通常 72 小时内发货。' },
    })], skipDuplicates: true });
    expect(runtime.runStructured).toHaveBeenCalledWith(scope, expect.objectContaining({
      purpose: 'REPLY_GENERATION', schema: 'ReplyGeneration', allowedDataClasses: ['turn', 'tasks', 'realtimeFacts', 'evidence', 'recentMessages', 'structuredFacts', 'summary', 'customerMemory', 'shopSettings', 'channel'],
      evidence: expect.arrayContaining([expect.objectContaining({ itemId: 'knowledge-a', versionId: 'version-a' })]),
      context: expect.objectContaining({ turn: { text: '请结合之前的对话说明新疆发货安排。' } }),
    }));
    const composer = runtime.runStructured.mock.calls.find(([, input]) => input.purpose === 'REPLY_GENERATION')![1];
    expect(composer.context).toMatchObject({
      summary: { narrative: '买家偏好黑色。' },
      structuredFacts: { openQuestions: ['确认尺码'] },
      customerMemory: [{ type: 'PREFERENCE', key: 'color', value: { preferred: 'black' } }],
      recentMessages: [
        { role: 'ASSISTANT', kind: 'TEXT', text: '普通地区通常更快。', sequence: 7 },
        { role: 'BUYER', kind: 'TEXT', text: '那新疆呢？', sequence: 8 },
      ],
      shopSettings: {
        tone: '亲切简洁', logisticsPolicy: '默认承运方以订单物流为准。',
        shippingPolicy: '偏远地区以实际物流信息为准。', afterSalesPolicy: '售后需人工确认。',
      },
      channel: 'DOUYIN_DEMO',
    });
    expect(JSON.stringify(composer.context)).not.toContain('13800138000');
    expect(JSON.stringify(composer.context)).not.toContain('SHIPPED');
    expect(prisma.customerMemory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }),
    }));
    expect(drafts.createWaitingHuman).toHaveBeenCalledWith(scope, {
      replyJobId: 'reply-a', aiDraft: '新疆等偏远地区通常 72 小时内发货。',
      sourceContextVersion: 5, sourceLastMessageId: 'message-8', sourceSequence: 8,
    });
    expect(outboxes.enqueue).not.toHaveBeenCalled();
  });

  it('uses the durable plan plus core policy/strategy and only AUTO-enqueues a forbidden-term-safe single reply', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-auto', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
            sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
            conversation: { id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null },
            userTurn: { normalizedText: '多久发货？' },
          })
          .mockResolvedValueOnce({
            id: 'reply-auto', status: 'GENERATING', mode: 'AUTO', sourceContextVersion: 5,
            conversation: { id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE' },
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyEvidence: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: { 赔偿: '售后处理' } }) },
      task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const knowledge = { search: jest.fn().mockResolvedValue({ status: 'EVIDENCE', conflictItemIds: [], evidence: [{
      itemId: 'knowledge-a', versionId: 'version-a', version: 1, source: 'MANUAL', scope: 'STORE', productId: null,
      contentSnapshot: { question: '多久发货？', answer: '现货通常 48 小时内发货，不能承诺赔偿。' }, retrievalScore: 0.98,
    }] }) };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'SHIPPING_POLICY', riskLevel: 'LOW', requiredContext: [], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' } }),
    };
    const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-conflict' }) };
    const outboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-a' }) };
    const service = new ReplyRuntimeService(prisma as never, knowledge as never, runtime as never, drafts as never, outboxes as never);

    await expect(service.process(scope, 'reply-auto')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(runtime.runStructured).toHaveBeenNthCalledWith(1, scope, expect.objectContaining({ purpose: 'INTENT_PLANNER', schema: 'IntentPlan' }));
    expect(runtime.runStructured).toHaveBeenNthCalledWith(2, scope, expect.objectContaining({ purpose: 'RISK_CLASSIFIER', schema: 'RiskResult' }));
    expect(outboxes.enqueue).toHaveBeenCalledWith(scope, expect.objectContaining({
      text: '现货通常 48 小时内发货，不能承诺售后处理。', expectedContextVersion: 5,
    }));
    expect(drafts.createWaitingHuman).not.toHaveBeenCalled();
  });

  it('auto-replies to an exact safe greeting without knowledge or a model call', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-greeting', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
            sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
            conversation: { id: 'conversation-a', buyerId: 'buyer-a', contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null },
            userTurn: { normalizedText: '你好！', sourceMessageIdsJson: ['message-8'] },
          })
          .mockResolvedValueOnce({
            id: 'reply-greeting', status: 'GENERATING', sourceContextVersion: 5,
            conversation: { id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE' },
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyEvidence: { createMany: jest.fn() },
      task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const knowledge = { search: jest.fn() };
    const runtime = { runStructured: jest.fn() };
    const drafts = { createWaitingHuman: jest.fn() };
    const outboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-greeting' }) };
    const service = new ReplyRuntimeService(prisma as never, knowledge as never, runtime as never, drafts as never, outboxes as never);

    await expect(service.process(scope, 'reply-greeting')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(knowledge.search).not.toHaveBeenCalled();
    expect(runtime.runStructured).not.toHaveBeenCalled();
    expect(outboxes.enqueue).toHaveBeenCalledWith(scope, expect.objectContaining({
      text: '您好，我在的。您可以咨询商品、库存、订单、物流或售后问题。',
    }));
    expect(drafts.createWaitingHuman).not.toHaveBeenCalled();
  });

  it('keeps an evidenced static shipping question AUTO when a greeting makes the model return UNKNOWN/MEDIUM', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-polite-shipping', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
            sourceLastMessageId: 'message-9', sourceSequence: 9, sourceContextVersion: 6, evidences: [],
            conversation: { id: 'conversation-a', buyerId: 'buyer-a', contextVersion: 6, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null },
            userTurn: { normalizedText: '你好，请问多久发货？', sourceMessageIdsJson: ['message-9'] },
          })
          .mockResolvedValueOnce({
            id: 'reply-polite-shipping', status: 'GENERATING', sourceContextVersion: 6,
            conversation: { id: 'conversation-a', contextVersion: 6, humanActive: false, state: 'ACTIVE' },
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyEvidence: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const knowledge = { search: jest.fn().mockResolvedValue({ status: 'EVIDENCE', conflictItemIds: [], evidence: [{
      itemId: 'knowledge-shipping', versionId: 'version-shipping', version: 1, source: 'MANUAL', scope: 'STORE', productId: null,
      contentSnapshot: { question: '多久发货？', answer: '普通现货商品通常在24小时内发出；预售商品以商品说明为准。' }, retrievalScore: 0.98,
    }] }) };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'UNKNOWN', riskLevel: 'MEDIUM', requiredContext: [], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'MEDIUM', recommendedMode: 'ASSIST', reasons: ['uncertain'] } }),
    };
    const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-shipping' }) };
    const outboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-shipping' }) };
    const service = new ReplyRuntimeService(prisma as never, knowledge as never, runtime as never, drafts as never, outboxes as never);

    await expect(service.process(scope, 'reply-polite-shipping')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(outboxes.enqueue).toHaveBeenCalledWith(scope, expect.objectContaining({
      text: '普通现货商品通常在24小时内发出；预售商品以商品说明为准。',
    }));
    expect(drafts.createWaitingHuman).not.toHaveBeenCalled();
  });

  it('routes a durable Task before replying and sends the Workflow TaskResult through exactly one final Composer', async () => {
    const persistedTaskId = 'reply-task:reply-workflow:reply-workflow:0';
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-workflow', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
            sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
            conversation: { id: 'conversation-a', buyerId: 'buyer-a', contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null },
            userTurn: { normalizedText: '推荐一个适合我的商品', sourceMessageIdsJson: ['message-8'] },
          })
          .mockResolvedValueOnce({ id: 'reply-workflow', status: 'GENERATING', sourceContextVersion: 5, conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE' } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyEvidence: { createMany: jest.fn() },
      task: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{
          id: persistedTaskId, ownerWorkflowRunId: 'run-a', status: 'RESOLVED', errorCode: null,
          resultJson: { workflowRunId: 'run-a', workflowStatus: 'COMPLETED', reply: '工作流推荐：合成商品 A。', nodeResults: { generate: { text: '工作流推荐：合成商品 A。' } } },
          ownerWorkflowRun: { status: 'COMPLETED' },
        }]),
      },
      processingOutbox: { create: jest.fn().mockResolvedValue({ id: 'route-a' }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'PRODUCT_RECOMMENDATION', riskLevel: 'LOW', requiredContext: [], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } })
      .mockResolvedValueOnce({ output: { text: '最终答复：工作流推荐合成商品 A。', requiresHuman: false }, invocationId: 'composer-a', provider: 'offline', model: 'offline-v1', fallbackUsed: false }),
    };
    const workflowRouter = { route: jest.fn().mockResolvedValue([{ taskId: persistedTaskId, workflowId: 'workflow-a', runId: 'run-a', status: 'COMPLETED' }]) };
    const outboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-workflow' }) };
    const Service = ReplyRuntimeService as unknown as new (...args: any[]) => ReplyRuntimeService;
    const service = new Service(
      prisma as never,
      { search: jest.fn().mockResolvedValue({ status: 'EVIDENCE', conflictItemIds: [], evidence: [{ itemId: 'knowledge-a', versionId: 'version-a', version: 1, source: 'MANUAL', scope: 'STORE', productId: null, contentSnapshot: { question: '推荐', answer: '旧的本地知识答案' }, retrievalScore: 0.9 }] }) } as never,
      runtime as never,
      { createWaitingHuman: jest.fn() } as never,
      outboxes as never,
      undefined,
      undefined,
      undefined,
      workflowRouter,
    );

    await expect(service.process(scope, 'reply-workflow')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(workflowRouter.route).toHaveBeenCalledWith(scope, { conversationId: 'conversation-a', taskIds: [persistedTaskId] });
    const composerCalls = runtime.runStructured.mock.calls.filter(([, input]) => input.purpose === 'REPLY_GENERATION');
    expect(composerCalls).toHaveLength(1);
    expect(composerCalls[0]![1].context.tasks).toEqual([
      expect.objectContaining({ facts: expect.objectContaining({ reply: '工作流推荐：合成商品 A。', workflowRunId: 'run-a' }) }),
    ]);
    expect(outboxes.enqueue).toHaveBeenCalledWith(scope, expect.objectContaining({ text: '最终答复：工作流推荐合成商品 A。' }));
    expect(outboxes.enqueue).not.toHaveBeenCalledWith(scope, expect.objectContaining({ text: '旧的本地知识答案' }));
  });

  it('rolls back FAST_PATH_READY when the durable AUTO send-intent write crashes, leaving no stranded ready job', async () => {
    let status = 'GENERATING';
    const tx = {
      $queryRaw: jest.fn(),
      conversation: { findFirst: jest.fn().mockResolvedValue({ contextVersion: 5, humanActive: false, state: 'ACTIVE' }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'runtime:shop', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      replyJob: { updateMany: jest.fn(async ({ data }) => { status = data.status; return { count: 1 }; }) },
    };
    const prisma = {
      $transaction: jest.fn(async (work: Function) => {
        const before = status;
        try { return await work(tx); } catch (error) { status = before; throw error; }
      }),
      replyJob: { updateMany: jest.fn() },
    };
    const outboxes = { enqueue: jest.fn(), enqueueInTransaction: jest.fn().mockRejectedValue(new Error('simulated crash before outbox commit')) };
    const service = new ReplyRuntimeService(prisma as never, {} as never, {} as never, {} as never, outboxes as never);

    await expect((service as never as { commitAutoSend: Function }).commitAutoSend(scope, {
      id: 'reply-atomic', conversationId: 'conversation-a', sourceContextVersion: 5, sourceLastMessageId: 'message-8', sourceSequence: 8,
    }, '自动答复')).rejects.toThrow('simulated crash');
    expect(status).toBe('GENERATING');
    expect(outboxes.enqueueInTransaction).toHaveBeenCalledWith(tx, scope, expect.objectContaining({ idempotencyKey: 'reply-send:reply-atomic' }));
  });

  it('rechecks live scoped readiness at the final AUTO commit barrier and never writes an intent after learning regresses', async () => {
    const job = {
      id: 'reply-readiness-barrier', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
      sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
      conversation: { id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null },
      userTurn: { normalizedText: '多久发货？' },
    };
    const tx = {
      $queryRaw: jest.fn(),
      conversation: { findFirst: jest.fn().mockResolvedValue({ contextVersion: 5, humanActive: false, state: 'ACTIVE' }) },
      // The policy read before generation was READY; this is the authoritative
      // post-generation read after learning has finished PARTIAL_SUCCESS.
      shop: { findFirst: jest.fn().mockResolvedValue({
        aiMode: 'AUTO_ALLOWED', seedKey: 'runtime:shop', productLearningJobs: [{ status: 'PARTIAL_SUCCESS' }],
      }) },
      replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce(job)
          .mockResolvedValueOnce({ ...job, status: 'GENERATING' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyEvidence: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      // Initial policy read: AUTO is admissible while the job is generated.
      shop: { findFirst: jest.fn().mockResolvedValue({
        aiMode: 'AUTO_ALLOWED', seedKey: 'runtime:shop', productLearningJobs: [{ status: 'SUCCEEDED' }],
      }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
      $transaction: jest.fn((work: Function) => work(tx)),
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'SHIPPING_POLICY', riskLevel: 'LOW', requiredContext: [], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } }),
    };
    const outboxes = { enqueue: jest.fn(), enqueueInTransaction: jest.fn() };
    const service = new ReplyRuntimeService(
      prisma as never,
      { search: jest.fn().mockResolvedValue({ status: 'EVIDENCE', conflictItemIds: [], evidence: [{
        itemId: 'knowledge-a', versionId: 'version-a', version: 1, source: 'MANUAL', scope: 'STORE', productId: null,
        contentSnapshot: { question: '多久发货？', answer: '现货通常 48 小时内发货。' }, retrievalScore: 0.98,
      }] }) } as never,
      runtime as never,
      { createWaitingHuman: jest.fn() } as never,
      outboxes as never,
    );

    await expect(service.process(scope, 'reply-readiness-barrier')).resolves.toEqual({
      status: 'STALE', reason: 'SHOP_AI_NOT_READY',
    });
    expect(tx.shop.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'shop-a', workspaceId: 'workspace-a', tenantId: 'tenant-a' },
      select: expect.objectContaining({ productLearningJobs: expect.objectContaining({
        where: scope, orderBy: { createdAt: 'desc' }, take: 1,
      }) }),
    }));
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'reply-readiness-barrier', ...scope, status: 'GENERATING', sourceContextVersion: 5 },
      data: { status: 'STALE', staleReason: 'SHOP_AI_NOT_READY' },
    });
    expect(outboxes.enqueueInTransaction).not.toHaveBeenCalled();
  });

  it('does not compose or enqueue when the conversation became human-active after planning', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'reply-a', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
          sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
          conversation: { id: 'conversation-a', contextVersion: 5, humanActive: true, state: 'ACTIVE' },
          userTurn: { normalizedText: '我想问物流' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const knowledge = { search: jest.fn() };
    const runtime = { runStructured: jest.fn() };
    const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-conflict' }) };
    const outboxes = { enqueue: jest.fn() };
    const service = new ReplyRuntimeService(prisma as never, knowledge as never, runtime as never, drafts as never, outboxes as never);

    await expect(service.process(scope, 'reply-a')).resolves.toMatchObject({ status: 'STALE', reason: 'HUMAN_ACTIVE' });
    expect(prisma.replyJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'reply-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: 'PENDING' },
      data: { status: 'STALE', staleReason: 'HUMAN_ACTIVE' },
    });
    // Human takeover is an initial durable guard: no provider call is allowed
    // once the source conversation is already human-active.
    expect(runtime.runStructured).not.toHaveBeenCalled();
    expect(runtime.runStructured).not.toHaveBeenCalledWith(scope, expect.objectContaining({ purpose: 'REPLY_GENERATION' }));
    expect(outboxes.enqueue).not.toHaveBeenCalled();
    expect(prisma.task.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        intent: 'LOGISTICS_QUERY', status: 'CANCELLED', errorCode: 'HUMAN_ACTIVE',
        requiredToolsJson: ['GET_ORDER', 'GET_LOGISTICS'],
      })],
    }));
  });

  it('fails closed to human review when scoped knowledge reports a conflict, without composing or enqueueing', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'reply-conflict', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
          sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
          conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null },
          userTurn: { normalizedText: '到底多久发货？' },
        }), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyEvidence: { createMany: jest.fn() },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
      task: { createMany: jest.fn() },
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'SHIPPING_POLICY', riskLevel: 'LOW', requiredContext: [], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } }),
    };
    const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-conflict' }) };
    const outboxes = { enqueue: jest.fn() };
    const service = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'CONFLICTED', evidence: [], conflictItemIds: ['item-a', 'item-b'] }) } as never, runtime as never, drafts as never, outboxes as never);

    await expect(service.process(scope, 'reply-conflict')).resolves.toMatchObject({ status: 'WAITING_HUMAN', reason: 'CONTEXT_CONFLICT' });
    // Conflict is now discovered by Task-scoped retrieval, after intent and
    // risk planning but before reply composition.
    expect(runtime.runStructured).toHaveBeenCalledTimes(2);
    expect(runtime.runStructured).not.toHaveBeenCalledWith(scope, expect.objectContaining({ purpose: 'REPLY_GENERATION' }));
    expect(outboxes.enqueue).not.toHaveBeenCalled();
    expect(drafts.createWaitingHuman).toHaveBeenCalledWith(scope, expect.objectContaining({ replyJobId: 'reply-conflict' }));
    expect(prisma.task.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ intent: 'SHIPPING_POLICY', status: 'FAILED', errorCode: 'KNOWLEDGE_CONFLICT' })],
    }));
  });

  it('uses each shop transfer keyword and conservative risk recommendation as a manual ceiling', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'reply-transfer', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
          sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
          conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null },
          userTurn: { normalizedText: '我要投诉并申请平台介入' },
        }), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyEvidence: { createMany: jest.fn() },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: ['投诉', '平台介入'] }) },
      task: { createMany: jest.fn() },
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'AFTER_SALES', riskLevel: 'LOW', requiredContext: [], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'ASSIST', reasons: [] } }),
    };
    const outboxes = { enqueue: jest.fn() };
    const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-transfer' }) };
    const service = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }) } as never, runtime as never, drafts as never, outboxes as never);

    await expect(service.process(scope, 'reply-transfer')).resolves.toMatchObject({ status: 'WAITING_HUMAN' });
    expect(outboxes.enqueue).not.toHaveBeenCalled();
    expect(prisma.replyJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ staleReason: expect.stringContaining('USER_REQUESTED_HUMAN') }) }));
    expect(drafts.createWaitingHuman).toHaveBeenCalledWith(scope, expect.objectContaining({
      aiDraft: expect.stringMatching(/投诉.*人工/),
    }));
  });

  it('records an all-task NO_EVIDENCE refusal as MANUAL rather than an assist draft', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'reply-no-evidence', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
          sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
          conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null, buyerId: 'buyer-a' },
          userTurn: { normalizedText: '你们有会员积分吗？' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyEvidence: { createMany: jest.fn() },
      task: { createMany: jest.fn() },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'UNKNOWN', riskLevel: 'LOW', requiredContext: [], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } }),
    };
    const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-no-evidence' }) };
    const outboxes = { enqueue: jest.fn() };
    const traces = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new ReplyRuntimeService(
      prisma as never,
      { search: jest.fn().mockResolvedValue({ status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }) } as never,
      runtime as never,
      drafts as never,
      outboxes as never,
      undefined,
      undefined,
      traces as never,
    );

    await expect(service.process(scope, 'reply-no-evidence')).resolves.toMatchObject({
      status: 'WAITING_HUMAN', reason: 'NO_EVIDENCE', draftId: 'draft-no-evidence',
    });
    expect(traces.record).toHaveBeenCalledWith(
      expect.objectContaining({ replyJobId: 'reply-no-evidence' }),
      'reply-job:reply-no-evidence',
      'REPLY_POLICY',
      { mode: 'MANUAL', reasons: ['NO_EVIDENCE'], evidenceCount: 0, taskStatuses: ['FAILED'] },
    );
    expect(outboxes.enqueue).not.toHaveBeenCalled();
  });

  it('converts a configured intent/risk runtime failure into a durable human-review draft and never enqueues', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'reply-runtime-failed', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
          sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
          conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null },
          userTurn: { normalizedText: '什么时候发货？' },
        }), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyEvidence: { createMany: jest.fn() }, task: { createMany: jest.fn() },
    };
    const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-fallback' }) };
    const outboxes = { enqueue: jest.fn() };
    const traces = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }) } as never, { runStructured: jest.fn().mockRejectedValue(new Error('configured provider unavailable')) } as never, drafts as never, outboxes as never, undefined, undefined, traces as never);

    await expect(service.process(scope, 'reply-runtime-failed')).resolves.toMatchObject({ status: 'WAITING_HUMAN', draftId: 'draft-fallback', reason: 'AI_RUNTIME_FAILED' });
    expect(drafts.createWaitingHuman).toHaveBeenCalledWith(scope, expect.objectContaining({ replyJobId: 'reply-runtime-failed', aiDraft: expect.stringContaining('人工') }));
    expect(prisma.task.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        intent: 'SHIPPING_POLICY', status: 'FAILED', errorCode: 'AI_RUNTIME_FAILED',
        requiredToolsJson: ['TRANSFER_HUMAN'],
      })],
    }));
    expect(traces.record).toHaveBeenCalledWith(
      expect.objectContaining({ replyJobId: 'reply-runtime-failed' }),
      'reply-job:reply-runtime-failed',
      'REPLY_POLICY',
      { mode: 'MANUAL', reasons: ['AI_RUNTIME_FAILED'] },
    );
    expect(outboxes.enqueue).not.toHaveBeenCalled();
  });

  it('never lets a low global classifier downgrade a planner HIGH-risk refund task into AUTO', async () => {
    const prisma = {
      replyJob: { findFirst: jest.fn().mockResolvedValue({
        id: 'reply-high', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a', sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
        conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null }, userTurn: { normalizedText: '我要退款' },
      }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyEvidence: { createMany: jest.fn() }, task: { createMany: jest.fn() }, shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) }, shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'REFUND', riskLevel: 'HIGH', requiredContext: [], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } }),
    };
    const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-high' }) };
    const outboxes = { enqueue: jest.fn() };
    const service = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }) } as never, runtime as never, drafts as never, outboxes as never);

    await expect(service.process(scope, 'reply-high')).resolves.toMatchObject({ status: 'WAITING_HUMAN', reason: expect.stringContaining('HIGH_RISK_TASK') });
    expect(outboxes.enqueue).not.toHaveBeenCalled();
  });

  it('uses the user-turn order card before multiple buyer orders when executing a context-required task', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-card', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a', sourceLastMessageId: 'card-order', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
            conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null, buyerId: 'buyer-a' },
            userTurn: { normalizedText: '这单什么时候到？', sourceMessageIdsJson: ['card-order'] },
          })
          .mockResolvedValueOnce({ id: 'reply-card', status: 'GENERATING', sourceContextVersion: 5, conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE' } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyEvidence: { createMany: jest.fn() }, task: { createMany: jest.fn() },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      message: { findMany: jest.fn().mockResolvedValue([{ id: 'card-order', kind: 'ORDER_CARD', contentJson: { orderId: 'order-2' } }]) },
      order: { findMany: jest.fn().mockResolvedValue([
        { id: 'order-1', externalOrderId: 'one', status: 'WAITING_SHIPMENT', logisticsSnapshotJson: {}, version: 1 },
        { id: 'order-2', externalOrderId: 'two', status: 'SHIPPED', logisticsSnapshotJson: {}, version: 2 },
      ]) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'ORDER_LOGISTICS', riskLevel: 'LOW', requiredContext: ['ORDER'], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } }),
    };
    const outboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-card' }) };
    const service = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'EVIDENCE', conflictItemIds: [], evidence: [{ itemId: 'knowledge-a', versionId: 'version-a', version: 1, source: 'MANUAL', scope: 'STORE', productId: null, contentSnapshot: { question: '物流', answer: '请以物流轨迹为准。' }, retrievalScore: 0.9 }] }) } as never, runtime as never, { createWaitingHuman: jest.fn() } as never, outboxes as never);

    await expect(service.process(scope, 'reply-card')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ buyerId: 'buyer-a' }) }));
    expect(outboxes.enqueue).toHaveBeenCalled();
  });

  it('uses an order explicitly named in the current turn before the older currentOrderId selection', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-order-b', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a', sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
            conversation: { id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null, buyerId: 'buyer-a', currentOrderId: 'order-a' },
            userTurn: { normalizedText: '订单 B 什么时候到？', sourceMessageIdsJson: [] },
          })
          .mockResolvedValueOnce({ id: 'reply-order-b', status: 'GENERATING', sourceContextVersion: 5, conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE' } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyEvidence: { createMany: jest.fn() }, task: { createMany: jest.fn() },
      // Production Prisma exposes findFirst.  It must not be used with the
      // older selection when the current turn explicitly names B.
      order: {
        findFirst: jest.fn().mockRejectedValue(new Error('old currentOrderId must not be queried')),
        findMany: jest.fn().mockResolvedValue([
          { id: 'order-a', externalOrderId: 'A', status: 'WAITING_SHIPMENT', logisticsSnapshotJson: {}, version: 1 },
          { id: 'order-b', externalOrderId: 'B', status: 'SHIPPED', logisticsSnapshotJson: {}, version: 2 },
        ]),
      },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'ORDER_LOGISTICS', riskLevel: 'LOW', requiredContext: ['ORDER'], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } }),
    };
    const outboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-order-b' }) };
    const service = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }) } as never, runtime as never, { createWaitingHuman: jest.fn() } as never, outboxes as never);

    await expect(service.process(scope, 'reply-order-b')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
    expect(outboxes.enqueue).toHaveBeenCalledWith(scope, expect.objectContaining({ text: '这笔订单已经发货，请留意物流更新。' }));
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ currentOrderId: 'order-b' }) }));
  });

  it('resolves a unique SKU attribute match as a live fact without RAG and allows the low-risk fast path', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-sku', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
            sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
            conversation: { id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null, buyerId: 'buyer-a', currentProductId: null },
            userTurn: { normalizedText: '黑色 XL 还有库存吗？', sourceMessageIdsJson: [] },
          })
          .mockResolvedValueOnce({ id: 'reply-sku', status: 'GENERATING', sourceContextVersion: 5, conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE' } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyEvidence: { createMany: jest.fn() }, task: { createMany: jest.fn() },
      productSku: { findMany: jest.fn().mockResolvedValue([
        { id: 'sku-black-xl', productId: 'product-a', externalSkuId: 'black-xl', inventory: 3, price: 99, attributesJson: { color: '黑色', size: 'XL' } },
        { id: 'sku-black-l', productId: 'product-a', externalSkuId: 'black-l', inventory: 0, price: 99, attributesJson: { color: '黑色', size: 'L' } },
        { id: 'sku-white-xl', productId: 'product-a', externalSkuId: 'white-xl', inventory: 7, price: 99, attributesJson: { color: '白色', size: 'XL' } },
      ]) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'SKU_INVENTORY', riskLevel: 'LOW', requiredContext: ['PRODUCT', 'SKU'], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } }),
    };
    const outboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-sku' }) };
    const service = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }) } as never, runtime as never, { createWaitingHuman: jest.fn() } as never, outboxes as never);

    await expect(service.process(scope, 'reply-sku')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(prisma.productSku.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: scope }));
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'conversation-a', ...scope, contextVersion: 5 }, data: expect.objectContaining({ currentProductId: 'product-a' }),
    }));
    expect(outboxes.enqueue).toHaveBeenCalledWith(scope, expect.objectContaining({ text: '黑色目前库存较少，建议尽快下单。' }));
    expect(runtime.runStructured).toHaveBeenCalledTimes(2);
  });

  it('renders two requested colors from the current product without combining another product inventory', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-color-inventory', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
            sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
            conversation: { id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null, buyerId: 'buyer-a', currentProductId: 'product-current' },
            userTurn: { normalizedText: '黑色和白色哪个有货？', sourceMessageIdsJson: [] },
          })
          .mockResolvedValueOnce({ id: 'reply-color-inventory', status: 'GENERATING', sourceContextVersion: 5, conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE' } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyEvidence: { createMany: jest.fn() }, task: { createMany: jest.fn() },
      productSku: { findMany: jest.fn().mockResolvedValue([
        { id: 'sku-current-black-m', productId: 'product-current', externalSkuId: 'current-black-m', inventory: 0, price: 99, attributesJson: { color: '黑色', size: 'M' } },
        { id: 'sku-current-black-l', productId: 'product-current', externalSkuId: 'current-black-l', inventory: 0, price: 99, attributesJson: { color: '黑色', size: 'L' } },
        { id: 'sku-current-white-m', productId: 'product-current', externalSkuId: 'current-white-m', inventory: 2, price: 99, attributesJson: { color: '白色', size: 'M' } },
        { id: 'sku-current-white-l', productId: 'product-current', externalSkuId: 'current-white-l', inventory: 5, price: 99, attributesJson: { color: '白色', size: 'L' } },
        { id: 'sku-other-black', productId: 'product-other', externalSkuId: 'other-black', inventory: 99, price: 99, attributesJson: { color: '黑色', size: 'M' } },
      ]) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'SKU_INVENTORY', riskLevel: 'LOW', requiredContext: ['SKU'], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } }),
    };
    const outboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-color-inventory' }) };
    const service = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }) } as never, runtime as never, { createWaitingHuman: jest.fn() } as never, outboxes as never);

    await expect(service.process(scope, 'reply-color-inventory')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(prisma.productSku.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.productSku.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: scope }));
    expect(outboxes.enqueue).toHaveBeenCalledWith(scope, expect.objectContaining({ text: '黑色目前暂时缺货；白色目前有现货，可以正常下单。' }));
    expect(outboxes.enqueue.mock.calls[0][1].text).not.toMatch(/0|7|99/);
  });

  it('treats currentProductId as a productId fallback, never as a productSku id when Prisma findFirst exists', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-preferred-sku', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a', sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
            conversation: { id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null, buyerId: 'buyer-a', currentProductId: 'product-a' },
            userTurn: { normalizedText: '这个还有库存吗？', sourceMessageIdsJson: [] },
          })
          .mockResolvedValueOnce({ id: 'reply-preferred-sku', status: 'GENERATING', sourceContextVersion: 5, conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE' } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyEvidence: { createMany: jest.fn() }, task: { createMany: jest.fn() },
      productSku: {
        findFirst: jest.fn().mockRejectedValue(new Error('product id is not a SKU id')),
        findMany: jest.fn()
          .mockResolvedValueOnce([{ id: 'sku-other', productId: 'product-other', externalSkuId: 'other', inventory: 9, price: 99, attributesJson: { color: '白色' } }])
          .mockResolvedValueOnce([{ id: 'sku-current', productId: 'product-a', externalSkuId: 'current', inventory: 3, price: 99, attributesJson: { color: '黑色' } }]),
      },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'SKU_INVENTORY', riskLevel: 'LOW', requiredContext: ['SKU'], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } }),
    };
    const outboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-preferred-sku' }) };
    const service = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }) } as never, runtime as never, { createWaitingHuman: jest.fn() } as never, outboxes as never);

    await expect(service.process(scope, 'reply-preferred-sku')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(prisma.productSku.findFirst).not.toHaveBeenCalled();
    expect(prisma.productSku.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { ...scope, productId: 'product-a' } }));
    expect(outboxes.enqueue).toHaveBeenCalledWith(scope, expect.objectContaining({ text: '黑色目前库存较少，建议尽快下单。' }));
  });

  it('forces partial multi-task work to ASSIST and exposes the unresolved task to the composer instead of AUTO-sending a subset', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-partial', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a', sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
            conversation: { id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null, buyerId: 'buyer-a' },
            userTurn: { normalizedText: '黑色 XL 有货吗，也多久发货？', sourceMessageIdsJson: [] },
          })
          .mockResolvedValueOnce({ id: 'reply-partial', status: 'GENERATING', sourceContextVersion: 5, conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE' } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyEvidence: { createMany: jest.fn() }, task: { createMany: jest.fn() },
      productSku: { findMany: jest.fn().mockResolvedValue([{ id: 'sku-black-xl', productId: 'product-a', externalSkuId: 'black-xl', inventory: 3, price: 99, attributesJson: { color: '黑色', size: 'XL' } }]) },
      shop: { findFirst: jest.fn().mockResolvedValue({ aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }] }) }, shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [
        { intent: 'SKU_INVENTORY', riskLevel: 'LOW', requiredContext: ['SKU'], requiredTools: [] },
        { intent: 'SHIPPING_POLICY', riskLevel: 'LOW', requiredContext: [], requiredTools: [] },
      ] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } })
      .mockResolvedValueOnce({ output: { text: '黑色 XL 当前有货；发货时效请人工确认。', requiresHuman: false } }),
    };
    const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-partial' }) };
    const outboxes = { enqueue: jest.fn() };
    const service = new ReplyRuntimeService(prisma as never, { search: jest.fn().mockResolvedValue({ status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }) } as never, runtime as never, drafts as never, outboxes as never);

    await expect(service.process(scope, 'reply-partial')).resolves.toMatchObject({ status: 'WAITING_HUMAN', draftId: 'draft-partial' });
    const composer = runtime.runStructured.mock.calls.find(([, input]) => input.purpose === 'REPLY_GENERATION')![1];
    expect(composer.context.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'FAILED', errorCode: 'NO_EVIDENCE' })]));
    expect(outboxes.enqueue).not.toHaveBeenCalled();
  });

  it('persists and sends a deterministic first clarification round, then stops automatic clarification after two rounds', async () => {
    const baseJob = (rounds: unknown) => ({
      id: 'reply-clarify', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a', sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
      conversation: { id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null, buyerId: 'buyer-a', clarificationRoundsJson: rounds },
      userTurn: { normalizedText: '我的订单什么时候到？', sourceMessageIdsJson: [] },
    });
    const make = (rounds: unknown, shop = {
      aiMode: 'AUTO_ALLOWED', seedKey: 'shop_mia_fashion', productLearningJobs: [{ status: 'SUCCEEDED' }],
    }) => {
      const tx = {
        conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        shop: { findFirst: jest.fn().mockResolvedValue(shop) },
        replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const prisma = {
        replyJob: { findFirst: jest.fn().mockResolvedValue(baseJob(rounds)), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        replyEvidence: { createMany: jest.fn() }, task: { createMany: jest.fn() },
        order: { findMany: jest.fn().mockResolvedValue([
          { id: 'order-a', externalOrderId: 'A', status: 'SHIPPED', logisticsSnapshotJson: null, version: 1, product: { title: 'SilentKey 84 静音键盘' } },
          { id: 'order-b', externalOrderId: 'B', status: 'SHIPPED', logisticsSnapshotJson: null, version: 1, product: { title: 'ViewGo 便携屏' } },
        ]) },
        shop: { findFirst: jest.fn().mockResolvedValue(shop) }, shopSettings: { findFirst: jest.fn().mockResolvedValue({ forbiddenTermsJson: [], transferKeywordsJson: [] }) },
        $transaction: jest.fn((work: Function) => work(tx)),
      };
      const runtime = { runStructured: jest.fn()
        .mockResolvedValueOnce({ output: { tasks: [{ intent: 'ORDER_LOGISTICS', riskLevel: 'LOW', requiredContext: ['ORDER'], requiredTools: [] }] } })
        .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } }),
      };
      const outboxes = { enqueueInTransaction: jest.fn().mockResolvedValue({ id: 'send-clarify' }), enqueue: jest.fn() };
      const drafts = { createWaitingHuman: jest.fn().mockResolvedValue({ id: 'draft-manual' }) };
      const knowledge = { search: jest.fn().mockResolvedValue({ status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }) };
      return { tx, prisma, runtime, outboxes, drafts, knowledge, service: new ReplyRuntimeService(prisma as never, knowledge as never, runtime as never, drafts as never, outboxes as never) };
    };
    const first = make({});
    await expect(first.service.process(scope, 'reply-clarify')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(first.tx.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { clarificationRoundsJson: { ORDER: { round: 1, choices: [
      { id: 'order-a', label: 'SilentKey 84 静音键盘（订单 A）' },
      { id: 'order-b', label: 'ViewGo 便携屏（订单 B）' },
    ] } } } }));
    expect(first.tx.task.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ requiredKnowledgeJson: [] })]),
    }));
    expect(first.outboxes.enqueueInTransaction).toHaveBeenCalledWith(first.tx, scope, expect.objectContaining({ text: expect.stringContaining('哪笔订单'), idempotencyKey: expect.stringContaining('clarification:reply-clarify:') }));
    expect(first.runtime.runStructured).toHaveBeenCalledTimes(2);

    const preparing = make({}, {
      aiMode: 'AUTO_ALLOWED', seedKey: 'runtime:shop', productLearningJobs: [{ status: 'PENDING' }],
    });
    await expect(preparing.service.process(scope, 'reply-clarify')).resolves.toMatchObject({
      status: 'WAITING_HUMAN', reason: 'SHOP_AI_NOT_READY',
    });
    expect(preparing.tx.task.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({
        id: 'reply-task:reply-clarify:reply-clarify:0',
        intent: 'LOGISTICS_QUERY',
        riskLevel: 'LOW',
        requiredContextJson: ['ORDER'],
        status: 'AMBIGUOUS',
      })]),
    }));
    expect(preparing.drafts.createWaitingHuman).toHaveBeenCalledWith(scope, expect.objectContaining({
      replyJobId: 'reply-clarify', aiDraft: expect.stringContaining('哪笔订单'),
    }));
    expect(preparing.outboxes.enqueueInTransaction).not.toHaveBeenCalled();

    const exhausted = make({ ORDER: 2 });
    await expect(exhausted.service.process(scope, 'reply-clarify')).resolves.toMatchObject({ status: 'WAITING_HUMAN', reason: expect.stringContaining('CONTEXT_MANUAL_REQUIRED') });
    expect(exhausted.outboxes.enqueueInTransaction).not.toHaveBeenCalled();
    expect(exhausted.drafts.createWaitingHuman).toHaveBeenCalled();
  });

  it('rechecks live scoped readiness at the final clarification commit barrier', async () => {
    const job = {
      id: 'reply-clarification-barrier', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
      sourceLastMessageId: 'message-8', sourceSequence: 8, sourceContextVersion: 5, evidences: [],
      conversation: {
        id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED',
        overrideMode: null, buyerId: 'buyer-a', clarificationRoundsJson: {},
      },
      userTurn: { normalizedText: '我的订单什么时候到？', sourceMessageIdsJson: [] },
    };
    const tx = {
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      // Planning saw READY, but learning regressed before this durable commit.
      shop: { findFirst: jest.fn().mockResolvedValue({
        aiMode: 'AUTO_ALLOWED', seedKey: 'runtime:shop', productLearningJobs: [{ status: 'PARTIAL_SUCCESS' }],
      }) },
      replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      replyJob: { findFirst: jest.fn().mockResolvedValue(job), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyEvidence: { createMany: jest.fn() },
      task: { createMany: jest.fn() },
      order: { findMany: jest.fn().mockResolvedValue([
        { id: 'order-a', externalOrderId: 'A', status: 'SHIPPED', logisticsSnapshotJson: null, version: 1 },
        { id: 'order-b', externalOrderId: 'B', status: 'SHIPPED', logisticsSnapshotJson: null, version: 1 },
      ]) },
      // Initial policy read still permits AUTO.
      shop: { findFirst: jest.fn().mockResolvedValue({
        aiMode: 'AUTO_ALLOWED', seedKey: 'runtime:shop', productLearningJobs: [{ status: 'SUCCEEDED' }],
      }) },
      $transaction: jest.fn((work: Function) => work(tx)),
    };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'ORDER_LOGISTICS', riskLevel: 'LOW', requiredContext: ['ORDER'], requiredTools: [] }] } })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] } }),
    };
    const outboxes = { enqueueInTransaction: jest.fn(), enqueue: jest.fn() };
    const service = new ReplyRuntimeService(
      prisma as never,
      { search: jest.fn().mockResolvedValue({ status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] }) } as never,
      runtime as never,
      { createWaitingHuman: jest.fn() } as never,
      outboxes as never,
    );

    await expect(service.process(scope, job.id)).resolves.toEqual({
      status: 'STALE', reason: 'SHOP_AI_NOT_READY',
    });
    expect(tx.shop.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId },
      select: expect.objectContaining({ productLearningJobs: expect.objectContaining({
        where: scope, orderBy: { createdAt: 'desc' }, take: 1,
      }) }),
    }));
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith({
      where: { id: job.id, ...scope, status: 'GENERATING', sourceContextVersion: job.sourceContextVersion },
      data: { status: 'STALE', staleReason: 'SHOP_AI_NOT_READY' },
    });
    expect(outboxes.enqueueInTransaction).not.toHaveBeenCalled();
  });
});
