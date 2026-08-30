import {
  PrismaProductionReplyEvalPort,
  ProductionReplyEvalExecutor,
  projectProductionReplyExecution,
  type ProductionReplyEvalPort,
} from '../src/eval/production-reply-eval-executor';

describe('PrismaProductionReplyEvalPort', () => {
  it('loads scoped AI invocations without requiring a conversation id that runtime calls do not persist', async () => {
    const invocationFindMany = jest.fn(async () => ([{
      id: 'invocation-eval',
      provider: 'deepseek',
      model: 'deepseek-chat',
      inputTokens: 42,
      outputTokens: 9,
      durationMs: 180,
    }]));
    const createdAt = new Date('2026-08-30T00:00:00.000Z');
    const prisma = {
      replyJob: { findFirst: jest.fn(async () => ({
        id: 'reply-eval',
        userTurnId: 'turn-eval',
        status: 'WAITING_HUMAN',
        mode: 'ASSIST',
        createdAt,
        draft: { id: 'draft-eval', aiDraft: '需要人工确认。', status: 'WAITING_HUMAN' },
        sendOutbox: null,
        evidences: [],
      })) },
      task: { findMany: jest.fn(async () => []) },
      traceEvent: { findMany: jest.fn(async () => []) },
      aIInvocation: { findMany: invocationFindMany },
      message: { findMany: jest.fn(async () => []) },
    };
    const port = new PrismaProductionReplyEvalPort(
      {} as never,
      {} as never,
      prisma as never,
      { timeoutMs: 50, pollMs: 1 },
    );

    const projection = await port.waitForProjection({
      workspaceId: 'workspace-eval',
      tenantId: 'tenant-eval',
      shopId: 'shop-eval',
      conversationId: 'conversation-eval',
    });

    expect(projection.invocations).toHaveLength(1);
    expect(invocationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: 'workspace-eval',
        tenantId: 'tenant-eval',
        shopId: 'shop-eval',
        createdAt: { gte: createdAt },
      },
    }));
  });
});

describe('projectProductionReplyExecution', () => {
  it('projects the reply from durable tasks, frozen evidence, policy trace, draft, and invocations', () => {
    const execution = projectProductionReplyExecution({
      workspaceId: 'workspace-eval',
      conversationId: 'conversation-e001',
      replyJob: {
        id: 'reply-e001',
        userTurnId: 'turn-e001',
        status: 'WAITING_HUMAN',
        mode: 'AUTO',
        draft: { id: 'draft-e001', aiDraft: '普通现货商品通常24小时内发出。', status: 'WAITING_HUMAN' },
        sendOutbox: null,
      },
      tasks: [
        { id: 'task-e001', intent: 'SHIPPING_POLICY', status: 'RESOLVED', resultJson: { evidenceVersionIds: ['version-e001'] } },
      ],
      evidences: [
        {
          id: 'evidence-e001',
          knowledgeItemId: 'knowledge-e001',
          knowledgeVersionId: 'version-e001',
          retrievedContentSnapshotJson: { question: '多久发货？', answer: '普通现货商品通常24小时内发出。' },
        },
      ],
      traceEvents: [
        { id: 'trace-policy', stage: 'REPLY_POLICY', payloadJson: { mode: 'ASSIST', reasons: ['SHOP_MODE_CEILING'] } },
        { id: 'trace-usage', stage: 'AI_USAGE', payloadJson: { invocationId: 'invocation-e001' } },
      ],
      invocations: [
        { id: 'invocation-e001', provider: 'deepseek', model: 'deepseek-chat', inputTokens: 120, outputTokens: 30, durationMs: 210 },
      ],
      assistantMessages: [],
    });

    expect(execution).toMatchObject({
      text: '普通现货商品通常24小时内发出。',
      tasks: ['SHIPPING_POLICY'],
      mode: 'ASSIST',
      evidence: ['普通现货商品通常24小时内发出。'],
      provider: 'deepseek',
      model: 'deepseek-chat',
      inputTokens: 120,
      outputTokens: 30,
      latencyMs: 210,
      outputSource: 'DRAFT',
      terminalStatus: 'WAITING_HUMAN',
      trace: {
        workspaceId: 'workspace-eval',
        conversationId: 'conversation-e001',
        replyJobId: 'reply-e001',
        userTurnId: 'turn-e001',
        taskIds: ['task-e001'],
        evidenceIds: ['evidence-e001'],
        knowledgeVersionIds: ['version-e001'],
        draftId: 'draft-e001',
        invocationIds: ['invocation-e001'],
      },
    });
  });

  it('uses an assistant projection only when it is linked to a sent reply outbox', () => {
    const execution = projectProductionReplyExecution({
      workspaceId: 'workspace-eval',
      conversationId: 'conversation-e006',
      replyJob: {
        id: 'reply-e006', userTurnId: 'turn-e006', status: 'FAST_PATH_READY', mode: 'AUTO', draft: null,
        sendOutbox: {
          id: 'send-e006', status: 'SENT', payloadJson: { text: '黑色 XL 当前库存8件。' },
          receiptJson: { externalMessageId: 'assistant-external-e006' },
        },
      },
      tasks: [{ id: 'task-e006', intent: 'INVENTORY_QUERY', status: 'RESOLVED', resultJson: { inventory: 8 } }],
      evidences: [],
      traceEvents: [{ id: 'trace-policy', stage: 'REPLY_POLICY', payloadJson: { mode: 'AUTO' } }],
      invocations: [],
      assistantMessages: [
        { id: 'message-e006', externalMessageId: 'assistant-external-e006', contentJson: { text: '黑色 XL 当前库存8件。' } },
      ],
    });

    expect(execution).toMatchObject({
      text: '黑色 XL 当前库存8件。',
      mode: 'AUTO',
      outputSource: 'SENT_MESSAGE',
      terminalStatus: 'SENT',
      trace: { sendOutboxId: 'send-e006', sentMessageId: 'message-e006' },
    });
  });

  it('reports a durable human draft as ASSIST when clarification precedes a policy trace', () => {
    const execution = projectProductionReplyExecution({
      workspaceId: 'workspace-eval', conversationId: 'conversation-clarify',
      replyJob: {
        id: 'reply-clarify', userTurnId: 'turn-clarify', status: 'WAITING_HUMAN', mode: 'AUTO',
        draft: { id: 'draft-clarify', aiDraft: '请选择商品规格。', status: 'WAITING_HUMAN' }, sendOutbox: null,
      },
      tasks: [{ id: 'task-clarify', intent: 'CLARIFICATION', status: 'AMBIGUOUS', resultJson: null }],
      evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
    });

    expect(execution.mode).toBe('ASSIST');
  });
});

describe('ProductionReplyEvalExecutor', () => {
  it('activates a frozen knowledge conflict through the production setup port before sending the turn', async () => {
    const calls: string[] = [];
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-conflict', tenantId: 'tenant-conflict',
        shops: { shop_mia_fashion: 'shop-mia' }, buyers: { buyer_001: 'buyer-1' }, products: {}, orders: {},
      }),
      activateConflict: async (input: { shopId: string; fixture: string }) => { calls.push(`conflict:${input.shopId}:${input.fixture}`); },
      sendText: async (input: { text: string }) => { calls.push(`text:${input.text}`); return { conversationId: 'conversation-conflict' }; },
      sendProductCard: async () => { throw new Error('not expected'); },
      sendOrderCard: async () => { throw new Error('not expected'); },
      sendImageFixture: async () => { throw new Error('not expected'); },
      editPreviousBuyerMessage: async () => { throw new Error('not expected'); },
      recallPreviousBuyerMessage: async () => { throw new Error('not expected'); },
      waitForProjection: async () => ({
        workspaceId: 'workspace-conflict', conversationId: 'conversation-conflict',
        replyJob: {
          id: 'reply-conflict', userTurnId: 'turn-conflict', status: 'WAITING_HUMAN', mode: 'MANUAL',
          draft: { id: 'draft-conflict', aiDraft: '知识存在冲突，请人工确认。', status: 'WAITING_HUMAN' }, sendOutbox: null,
        },
        tasks: [{ id: 'task-conflict', intent: 'SHIPPING_POLICY', status: 'FAILED', resultJson: null }],
        evidences: [], traceEvents: [{ id: 'trace-policy', stage: 'REPLY_POLICY', payloadJson: { mode: 'MANUAL' } }],
        invocations: [], assistantMessages: [],
      }),
      deleteIsolatedWorkspace: async (workspaceId: string) => { calls.push(`delete:${workspaceId}`); },
    } satisfies ProductionReplyEvalPort;

    await new ProductionReplyEvalExecutor(port).execute({
      id: 'E018', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_001', messages: ['普通商品多久发货？'],
      contextSetup: { activateConflict: 'conflict_001' }, expectedTasks: ['SHIPPING_POLICY'], expectedMode: 'MANUAL',
      expectedFacts: [], forbiddenClaims: ['直接选择24小时或48小时'],
    });

    expect(calls).toEqual([
      'conflict:shop-mia:conflict_001',
      'text:普通商品多久发货？',
      'delete:workspace-conflict',
    ]);
  });

  it('drives structured and text messages through an isolated workspace and always cleans it', async () => {
    const calls: string[] = [];
    const port: ProductionReplyEvalPort = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-isolated', tenantId: 'tenant-isolated',
        shops: { shop_mia_fashion: 'shop-mia' },
        buyers: { buyer_002: 'buyer-2' },
        products: { fashion_hoodie: 'product-hoodie' }, orders: {},
      }),
      sendProductCard: async (input) => { calls.push(`product:${input.productId}`); return { conversationId: 'conversation-1' }; },
      sendOrderCard: async () => { throw new Error('not expected'); },
      sendImageFixture: async () => { throw new Error('not expected'); },
      sendText: async (input) => { calls.push(`text:${input.text}`); return { conversationId: input.conversationId ?? 'conversation-1' }; },
      editPreviousBuyerMessage: async () => { throw new Error('not expected'); },
      recallPreviousBuyerMessage: async () => { throw new Error('not expected'); },
      waitForProjection: async (input) => {
        calls.push(`wait:${input.conversationId}`);
        return {
          workspaceId: 'workspace-isolated', conversationId: input.conversationId,
          replyJob: {
            id: 'reply-1', userTurnId: 'turn-1', status: 'WAITING_HUMAN', mode: 'ASSIST',
            draft: { id: 'draft-1', aiDraft: '不建议使用烘干机。', status: 'WAITING_HUMAN' }, sendOutbox: null,
          },
          tasks: [{ id: 'task-1', intent: 'PRODUCT_QUERY', status: 'RESOLVED', resultJson: null }],
          evidences: [{ id: 'evidence-1', knowledgeItemId: 'knowledge-1', knowledgeVersionId: 'version-1', retrievedContentSnapshotJson: { answer: '不建议使用烘干机。' } }],
          traceEvents: [{ id: 'trace-1', stage: 'REPLY_POLICY', payloadJson: { mode: 'ASSIST' } }],
          invocations: [], assistantMessages: [],
        };
      },
      deleteIsolatedWorkspace: async (workspaceId) => { calls.push(`delete:${workspaceId}`); },
    };
    const executor = new ProductionReplyEvalExecutor(port);

    const result = await executor.execute({
      id: 'E004', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_002',
      messages: [{ type: 'GOODS_CARD', productKey: 'fashion_hoodie' }, '这个可以烘干吗？'],
      contextSetup: {}, expectedTasks: ['PRODUCT_QUERY'], expectedMode: 'ASSIST', expectedFacts: ['不建议使用烘干机'], forbiddenClaims: [],
    });

    expect(result.text).toContain('不建议使用烘干机');
    expect(calls).toEqual([
      'product:product-hoodie',
      'text:这个可以烘干吗？',
      'wait:conversation-1',
      'delete:workspace-isolated',
    ]);
  });

  it('fails closed for a context mutation that has no production driver and still cleans up', async () => {
    const deleted: string[] = [];
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-unsupported', tenantId: 'tenant-unsupported',
        shops: { shop_mia_fashion: 'shop-mia' }, buyers: { buyer_001: 'buyer-1' }, products: {}, orders: {},
      }),
      sendText: async () => ({ conversationId: 'conversation-1' }),
      sendProductCard: async () => ({ conversationId: 'conversation-1' }),
      sendOrderCard: async () => ({ conversationId: 'conversation-1' }),
      sendImageFixture: async () => ({ conversationId: 'conversation-1' }),
      editPreviousBuyerMessage: async () => undefined,
      recallPreviousBuyerMessage: async () => undefined,
      waitForProjection: async () => { throw new Error('must not run'); },
      deleteIsolatedWorkspace: async (workspaceId: string) => { deleted.push(workspaceId); },
    } satisfies ProductionReplyEvalPort;
    const executor = new ProductionReplyEvalExecutor(port);

    await expect(executor.execute({
      id: 'E026', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_001', messages: ['多久发货？'],
      contextSetup: { forceAiTimeout: true }, expectedTasks: ['SHIPPING_POLICY'], expectedMode: 'ASSIST', expectedFacts: [], forbiddenClaims: [],
    })).rejects.toThrow('EXECUTOR_UNSUPPORTED:forceAiTimeout');
    expect(deleted).toEqual(['workspace-unsupported']);
  });

  it('applies dynamic fact changes after the buyer turn through production mutation ports', async () => {
    const calls: string[] = [];
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-mutation', tenantId: 'tenant-mutation',
        shops: { shop_mia_fashion: 'shop-mia' }, buyers: { buyer_002: 'buyer-2' },
        products: { fashion_hoodie: 'product-hoodie' }, orders: { order_001: 'order-1' },
      }),
      sendText: async (input: { text: string; conversationId?: string }) => { calls.push(`text:${input.text}`); return { conversationId: input.conversationId ?? 'conversation-mutation' }; },
      sendProductCard: async () => ({ conversationId: 'conversation-mutation' }),
      sendOrderCard: async () => ({ conversationId: 'conversation-mutation' }),
      sendImageFixture: async () => { throw new Error('not expected'); },
      editPreviousBuyerMessage: async () => { throw new Error('not expected'); },
      recallPreviousBuyerMessage: async () => { throw new Error('not expected'); },
      changeSkuInventory: async (input: { skuExternalId: string; inventory: number }) => { calls.push(`inventory:${input.skuExternalId}:${input.inventory}`); },
      changeOrderStatus: async (input: { orderId: string; status: string }) => { calls.push(`order:${input.orderId}:${input.status}`); },
      waitForProjection: async () => ({
        workspaceId: 'workspace-mutation', conversationId: 'conversation-mutation',
        replyJob: { id: 'reply-mutation', userTurnId: 'turn-mutation', status: 'WAITING_HUMAN', mode: 'ASSIST', draft: null, sendOutbox: null },
        tasks: [{ id: 'task-mutation', intent: 'INVENTORY_QUERY', status: 'RESOLVED', resultJson: { reply: '这个规格暂时缺货。' } }],
        evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
      }),
      deleteIsolatedWorkspace: async (workspaceId: string) => { calls.push(`delete:${workspaceId}`); },
    } satisfies ProductionReplyEvalPort;

    await new ProductionReplyEvalExecutor(port).execute({
      id: 'E024', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_002',
      messages: [{ type: 'GOODS_CARD', productKey: 'fashion_hoodie' }, '黑色XL有吗？'],
      contextSetup: { changeInventoryDuringGeneration: { sku: 'P-F-001-BLACK-XL', to: 0 } },
      expectedTasks: ['INVENTORY_QUERY'], expectedMode: 'ASSIST', expectedFacts: ['暂时缺货'], forbiddenClaims: [],
    });

    expect(calls).toEqual([
      'text:黑色XL有吗？',
      'inventory:P-F-001-BLACK-XL:0',
      'delete:workspace-mutation',
    ]);
  });

  it('submits a human edit and expires a draft only after the initial durable projection exists', async () => {
    const calls: string[] = [];
    let waitCount = 0;
    const projection = {
      workspaceId: 'workspace-human', conversationId: 'conversation-human',
      replyJob: {
        id: 'reply-human', userTurnId: 'turn-human', status: 'WAITING_HUMAN', mode: 'ASSIST',
        draft: { id: 'draft-human', aiDraft: '默认使用顺丰或中通。', status: 'WAITING_HUMAN' }, sendOutbox: null,
      },
      tasks: [{ id: 'task-human', intent: 'SHIPPING_POLICY', status: 'RESOLVED', resultJson: null }],
      evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
    };
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-human', tenantId: 'tenant-human', shops: { shop_mia_fashion: 'shop-mia' },
        buyers: { buyer_001: 'buyer-1' }, products: {}, orders: {},
      }),
      sendText: async () => ({ conversationId: 'conversation-human' }),
      sendProductCard: async () => ({ conversationId: 'conversation-human' }),
      sendOrderCard: async () => ({ conversationId: 'conversation-human' }),
      sendImageFixture: async () => ({ conversationId: 'conversation-human' }),
      editPreviousBuyerMessage: async () => undefined,
      recallPreviousBuyerMessage: async () => undefined,
      applyHumanEdit: async (input: { editType: string; projection: unknown }) => { calls.push(`edit:${input.editType}:${input.projection === projection}`); },
      advanceDraftTime: async (input: { minutes: number }) => { calls.push(`advance:${input.minutes}`); },
      waitForProjection: async () => { waitCount += 1; return projection; },
      deleteIsolatedWorkspace: async (workspaceId: string) => { calls.push(`delete:${workspaceId}`); },
    } satisfies ProductionReplyEvalPort;

    await new ProductionReplyEvalExecutor(port).execute({
      id: 'E-CONTEXT', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_001', messages: ['发什么快递？'],
      contextSetup: { humanEditType: 'STYLE_EDIT', advanceTimeMinutes: 6 }, expectedTasks: ['SHIPPING_POLICY'],
      expectedMode: 'ASSIST', expectedFacts: [], forbiddenClaims: [],
    });

    expect(waitCount).toBe(3);
    expect(calls).toEqual(['edit:STYLE_EDIT:true', 'advance:6', 'delete:workspace-human']);
  });

  it('executes edit and recall actions against the preceding durable buyer message', async () => {
    const calls: string[] = [];
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-actions', tenantId: 'tenant-actions',
        shops: { shop_pixel_tech: 'shop-pixel' }, buyers: { buyer_001: 'buyer-1' }, products: {}, orders: {},
      }),
      sendText: async (input: { conversationId?: string; text: string }) => {
        calls.push(`text:${input.text}`);
        return { conversationId: input.conversationId ?? 'conversation-actions' };
      },
      sendProductCard: async () => { throw new Error('not expected'); },
      sendOrderCard: async () => { throw new Error('not expected'); },
      editPreviousBuyerMessage: async (input: { conversationId: string; text: string }) => { calls.push(`edit:${input.conversationId}:${input.text}`); },
      recallPreviousBuyerMessage: async (input: { conversationId: string }) => { calls.push(`recall:${input.conversationId}`); },
      waitForProjection: async (input: { conversationId: string }) => ({
        workspaceId: 'workspace-actions', conversationId: input.conversationId,
        replyJob: {
          id: 'reply-actions', userTurnId: 'turn-actions', status: 'WAITING_HUMAN', mode: 'ASSIST',
          draft: { id: 'draft-actions', aiDraft: '物流信息需要人工确认。', status: 'WAITING_HUMAN' }, sendOutbox: null,
        },
        tasks: [{ id: 'task-actions', intent: 'LOGISTICS_QUERY', status: 'FAILED', resultJson: null }],
        evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
      }),
      deleteIsolatedWorkspace: async (workspaceId: string) => { calls.push(`delete:${workspaceId}`); },
    } as unknown as ProductionReplyEvalPort;
    const executor = new ProductionReplyEvalExecutor(port);

    await executor.execute({
      id: 'E-ACTIONS', shopKey: 'shop_pixel_tech', buyerKey: 'buyer_001',
      messages: [
        '我要退款',
        { action: 'EDIT_PREVIOUS', text: '我想问退款规则' },
        { action: 'RECALL_PREVIOUS' },
        '发错了，我想问物流',
      ],
      contextSetup: {}, expectedTasks: ['LOGISTICS_QUERY'], expectedMode: 'ASSIST', expectedFacts: [], forbiddenClaims: [],
    });

    expect(calls).toEqual([
      'text:我要退款',
      'edit:conversation-actions:我想问退款规则',
      'recall:conversation-actions',
      'text:发错了，我想问物流',
      'delete:workspace-actions',
    ]);
  });

  it('sends a frozen image fixture through the production image message boundary', async () => {
    const calls: string[] = [];
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-image', tenantId: 'tenant-image',
        shops: { shop_mia_fashion: 'shop-mia' }, buyers: { buyer_004: 'buyer-4' }, products: {}, orders: {},
      }),
      sendImageFixture: async (input: { fixture: string; conversationId?: string }) => {
        calls.push(`image:${input.fixture}`);
        return { conversationId: input.conversationId ?? 'conversation-image' };
      },
      sendText: async (input: { text: string; conversationId?: string }) => {
        calls.push(`text:${input.text}`);
        return { conversationId: input.conversationId ?? 'conversation-image' };
      },
      sendProductCard: async () => { throw new Error('not expected'); },
      sendOrderCard: async () => { throw new Error('not expected'); },
      editPreviousBuyerMessage: async () => { throw new Error('not expected'); },
      recallPreviousBuyerMessage: async () => { throw new Error('not expected'); },
      waitForProjection: async (input: { conversationId: string }) => ({
        workspaceId: 'workspace-image', conversationId: input.conversationId,
        replyJob: {
          id: 'reply-image', userTurnId: 'turn-image', status: 'WAITING_HUMAN', mode: 'ASSIST',
          draft: { id: 'draft-image', aiDraft: '疑似商品破损，需要人工确认。', status: 'WAITING_HUMAN' }, sendOutbox: null,
        },
        tasks: [{ id: 'task-image', intent: 'AFTER_SALES_QUERY', status: 'FAILED', resultJson: null }],
        evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
      }),
      deleteIsolatedWorkspace: async (workspaceId: string) => { calls.push(`delete:${workspaceId}`); },
    } as unknown as ProductionReplyEvalPort;

    await new ProductionReplyEvalExecutor(port).execute({
      id: 'E020', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_004',
      messages: [{ type: 'IMAGE', fixture: 'damaged_sleeve.png' }, '收到就是这样的'], contextSetup: {},
      expectedTasks: ['AFTER_SALES_QUERY'], expectedMode: 'ASSIST', expectedFacts: ['疑似商品破损'], forbiddenClaims: [],
    });

    expect(calls).toEqual([
      'image:damaged_sleeve.png',
      'text:收到就是这样的',
      'delete:workspace-image',
    ]);
  });
});
