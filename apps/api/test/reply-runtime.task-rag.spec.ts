import { ReplyRuntimeService } from '../src/replies/reply-runtime.service';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

describe('ReplyRuntimeService Task-scoped RAG', () => {
  it('resolves a product card before retrieving and freezing PRODUCT evidence', async () => {
    const productFindFirst = jest.fn().mockResolvedValue({ id: 'product-a', title: '云朵卫衣' });
    const messageFindMany = jest.fn().mockImplementation(async (input: { where?: { kind?: unknown } }) => input.where?.kind
      ? [{ kind: 'GOODS_CARD', contentJson: { productId: 'product-a' } }]
      : []);
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-product', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
            sourceLastMessageId: 'message-card', sourceSequence: 2, sourceContextVersion: 4, evidences: [],
            conversation: { id: 'conversation-a', buyerId: 'buyer-a', contextVersion: 4, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null, currentProductId: null, currentOrderId: null, clarificationRoundsJson: {} },
            userTurn: { normalizedText: '这个可以烘干吗？', sourceMessageIdsJson: ['message-card'] },
          })
          .mockResolvedValueOnce({
            id: 'reply-product', status: 'GENERATING', sourceContextVersion: 4,
            conversation: { id: 'conversation-a', contextVersion: 4, humanActive: false, state: 'ACTIVE' },
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      message: { findMany: messageFindMany },
      product: { findFirst: productFindFirst, findMany: jest.fn() },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversationMemory: { findFirst: jest.fn().mockResolvedValue(null) },
      customerMemory: { findMany: jest.fn().mockResolvedValue([]) },
      replyEvidence: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ platform: 'DOUYIN_DEMO', aiMode: 'AUTO_ALLOWED', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ tone: '亲切简洁', logisticsPolicy: '', shippingPolicy: '', afterSalesPolicy: '', forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const knowledge = { search: jest.fn().mockResolvedValue({ status: 'EVIDENCE', conflictItemIds: [], evidence: [{
      itemId: 'knowledge-product', versionId: 'version-product', version: 2, source: 'PRODUCT_LEARNING', scope: 'PRODUCT', productId: 'product-a',
      contentSnapshot: { question: '可以烘干吗？', answer: '建议低温轻柔烘干，避免高温。' }, retrievalScore: 0.97,
    }] }) };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'PRODUCT_QUERY', riskLevel: 'LOW', requiredContext: ['PRODUCT'], requiredKnowledge: ['PRODUCT'], requiredTools: [] }] }, invocationId: 'intent-1', provider: 'fixture', model: 'fixture', fallbackUsed: false })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] }, invocationId: 'risk-1', provider: 'fixture', model: 'fixture', fallbackUsed: false }),
    };
    const drafts = { createWaitingHuman: jest.fn() };
    const outboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-product' }) };
    const service = new ReplyRuntimeService(prisma as never, knowledge as never, runtime as never, drafts as never, outboxes as never);

    await expect(service.process(scope, 'reply-product')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(knowledge.search).toHaveBeenCalledWith(scope, expect.objectContaining({ scope: 'PRODUCT', productId: 'product-a' }));
    expect(productFindFirst.mock.invocationCallOrder[0]).toBeLessThan(knowledge.search.mock.invocationCallOrder[0]!);
    expect(prisma.replyEvidence.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ productId: 'product-a', knowledgeVersionId: 'version-product' })],
    }));
    expect(outboxes.enqueue).toHaveBeenCalledWith(scope, expect.objectContaining({ text: '建议低温轻柔烘干，避免高温。' }));
    expect(drafts.createWaitingHuman).not.toHaveBeenCalled();
  });

  it('never invokes RAG for a live inventory task', async () => {
    const messageFindMany = jest.fn().mockImplementation(async (input: { where?: { kind?: unknown } }) => input.where?.kind ? [] : []);
    const prisma = {
      replyJob: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: 'reply-inventory', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a',
            sourceLastMessageId: 'message-inventory', sourceSequence: 7, sourceContextVersion: 4, evidences: [],
            conversation: { id: 'conversation-a', buyerId: 'buyer-a', contextVersion: 4, humanActive: false, state: 'ACTIVE', syncState: 'CONNECTED', overrideMode: null, currentProductId: null, currentOrderId: null, clarificationRoundsJson: {} },
            userTurn: { normalizedText: '黑色 XL 还有吗？', sourceMessageIdsJson: ['message-inventory'] },
          })
          .mockResolvedValueOnce({
            id: 'reply-inventory', status: 'GENERATING', sourceContextVersion: 4,
            conversation: { id: 'conversation-a', contextVersion: 4, humanActive: false, state: 'ACTIVE' },
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      message: { findMany: messageFindMany },
      productSku: { findMany: jest.fn().mockResolvedValue([{
        id: 'sku-black-xl', productId: 'product-a', externalSkuId: 'black-xl', inventory: 2, price: '99.00',
        attributesJson: { color: '黑色', size: 'XL' },
      }]) },
      conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversationMemory: { findFirst: jest.fn().mockResolvedValue(null) },
      customerMemory: { findMany: jest.fn().mockResolvedValue([]) },
      task: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      shop: { findFirst: jest.fn().mockResolvedValue({ platform: 'DOUYIN_DEMO', aiMode: 'AUTO_ALLOWED', productLearningJobs: [{ status: 'SUCCEEDED' }] }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ tone: '亲切简洁', logisticsPolicy: '', shippingPolicy: '', afterSalesPolicy: '', forbiddenTermsJson: [], transferKeywordsJson: [] }) },
    };
    const knowledge = { search: jest.fn() };
    const runtime = { runStructured: jest.fn()
      .mockResolvedValueOnce({ output: { tasks: [{ intent: 'INVENTORY_QUERY', riskLevel: 'LOW', requiredContext: ['PRODUCT', 'SKU'], requiredKnowledge: ['STORE'], requiredTools: ['GET_INVENTORY'] }] }, invocationId: 'intent-inventory', provider: 'fixture', model: 'fixture', fallbackUsed: false })
      .mockResolvedValueOnce({ output: { riskLevel: 'LOW', recommendedMode: 'AUTO', reasons: [] }, invocationId: 'risk-inventory', provider: 'fixture', model: 'fixture', fallbackUsed: false }),
    };
    const drafts = { createWaitingHuman: jest.fn() };
    const outboxes = { enqueue: jest.fn().mockResolvedValue({ id: 'send-inventory' }) };
    const service = new ReplyRuntimeService(prisma as never, knowledge as never, runtime as never, drafts as never, outboxes as never);

    await expect(service.process(scope, 'reply-inventory')).resolves.toMatchObject({ status: 'READY_TO_SEND' });
    expect(knowledge.search).not.toHaveBeenCalled();
    expect(outboxes.enqueue).toHaveBeenCalledWith(scope, expect.objectContaining({
      text: '这个规格目前库存较少，建议尽快下单。',
    }));
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ currentProductId: 'product-a' }),
    }));
    expect(drafts.createWaitingHuman).not.toHaveBeenCalled();
  });
});
