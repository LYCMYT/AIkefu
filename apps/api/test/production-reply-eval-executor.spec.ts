import {
  PrismaProductionReplyEvalPort,
  ProductionReplyEvalExecutor,
  projectProductionReplyExecution,
  type ProductionReplyEvalPort,
} from '../src/eval/production-reply-eval-executor';
import { AiEvalFaultRegistry } from '../src/eval/ai-eval-fault-registry';

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
    const replyJobFindFirst = jest.fn(async () => ({
        id: 'reply-eval',
        userTurnId: 'turn-eval',
        status: 'WAITING_HUMAN',
        mode: 'ASSIST',
        createdAt,
        draft: { id: 'draft-eval', aiDraft: '需要人工确认。', status: 'WAITING_HUMAN' },
        sendOutbox: null,
        evidences: [],
      }));
    const taskFindMany = jest.fn(async () => []);
    const traceFindMany = jest.fn(async () => []);
    const messageFindMany = jest.fn(async () => []);
    const prisma = {
      replyJob: { findFirst: replyJobFindFirst, findMany: jest.fn(async () => []) },
      task: { findMany: taskFindMany },
      traceEvent: { findMany: traceFindMany },
      aIInvocation: { findMany: invocationFindMany },
      message: { findMany: messageFindMany },
      knowledgeItem: { findMany: jest.fn(async () => []) },
      product: { findMany: jest.fn(async () => []) },
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
      afterReplyJobId: 'reply-previous-stale',
    });

    expect(projection.invocations).toHaveLength(1);
    expect(replyJobFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: 'workspace-eval',
        tenantId: 'tenant-eval',
        shopId: 'shop-eval',
        conversationId: 'conversation-eval',
        id: { not: 'reply-previous-stale' },
      },
    }));
    expect(invocationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        workspaceId: 'workspace-eval',
        tenantId: 'tenant-eval',
        shopId: 'shop-eval',
        createdAt: { gte: createdAt },
      },
    }));
    const scopedConversation = {
      workspaceId: 'workspace-eval', tenantId: 'tenant-eval', shopId: 'shop-eval', conversationId: 'conversation-eval',
    };
    expect(taskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ...scopedConversation, userTurnId: 'turn-eval' },
    }));
    expect(traceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ...scopedConversation, replyJobId: 'reply-eval' },
    }));
    expect(messageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ...scopedConversation, role: { in: ['ASSISTANT', 'HUMAN'] }, createdAt: { gte: createdAt } },
    }));
  });

  it('audits only the explicitly invalidated reply job, not a legitimate earlier turn', async () => {
    const createdAt = new Date('2026-08-30T00:00:00.000Z');
    const invalidatedFindMany = jest.fn(async () => ([{
      id: 'reply-invalidated',
      sendOutbox: { status: 'SENT', receiptJson: { externalMessageId: 'stale-message' } },
    }]));
    const prisma = {
      replyJob: {
        findFirst: jest.fn(async () => ({
          id: 'reply-current', userTurnId: 'turn-current', status: 'WAITING_HUMAN', mode: 'ASSIST', createdAt,
          draft: { id: 'draft-current', aiDraft: '需要人工确认。', status: 'WAITING_HUMAN' }, sendOutbox: null, evidences: [],
        })),
        findMany: invalidatedFindMany,
      },
      task: { findMany: jest.fn(async () => []) }, traceEvent: { findMany: jest.fn(async () => []) },
      aIInvocation: { findMany: jest.fn(async () => []) }, message: { findMany: jest.fn(async () => []) },
      knowledgeItem: { findMany: jest.fn(async () => []) }, product: { findMany: jest.fn(async () => []) },
    };
    const port = new PrismaProductionReplyEvalPort({} as never, {} as never, prisma as never, { timeoutMs: 50, pollMs: 1 });
    const scope = {
      workspaceId: 'workspace-eval', tenantId: 'tenant-eval', shopId: 'shop-eval', conversationId: 'conversation-eval',
    };

    const ordinaryNextTurn = await port.waitForProjection({ ...scope, afterReplyJobId: 'reply-legitimate-earlier-turn' });
    expect(ordinaryNextTurn.oldReplySent).toBe(false);
    expect(invalidatedFindMany).not.toHaveBeenCalled();

    const mutationReplan = await port.waitForProjection({
      ...scope,
      afterReplyJobId: 'reply-invalidated',
      invalidatedReplyJobId: 'reply-invalidated',
    });
    expect(mutationReplan.oldReplySent).toBe(true);
    expect(invalidatedFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ...scope, id: 'reply-invalidated' },
    }));
  });

  it('recovers a pre-transport sending outbox without requiring an AI draft or creating a human final', async () => {
    const scope = { workspaceId: 'workspace-restart', tenantId: 'tenant-restart', shopId: 'shop-restart' };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findFirst = jest.fn().mockResolvedValue({ status: 'PENDING' });
    const recovery = { recoverOnce: jest.fn().mockResolvedValue({ recoveryPending: 0, stale: 0, preTransport: 1, uncertain: 0, expiredDrafts: 0 }) };
    const port = new PrismaProductionReplyEvalPort(
      {} as never,
      {} as never,
      { sendOutbox: { updateMany, findFirst } } as never,
      { timeoutMs: 50, pollMs: 1 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      recovery as never,
      undefined,
    );

    await expect(port.resumeAfterRestart({
      ...scope,
      buyerId: 'buyer-restart',
      conversationId: 'conversation-restart',
      phase: 'SEND_OUTBOX_SENDING',
      projection: {
        workspaceId: scope.workspaceId,
        conversationId: 'conversation-restart',
        replyJob: {
          id: 'reply-restart', userTurnId: 'turn-restart', status: 'FAST_PATH_READY', mode: 'AUTO', draft: null,
          sendOutbox: { id: 'send-restart', status: 'SENDING', payloadJson: { text: '24小时内发货' }, receiptJson: {} },
        },
        tasks: [], evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
      },
    })).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'send-restart', ...scope, status: 'SENDING', transportStartedAt: null },
    }));
    expect(recovery.recoverOnce).toHaveBeenCalledTimes(1);
  });

  it('waits for the injected generation crash and recovers only the claimed reply job', async () => {
    const scope = { workspaceId: 'workspace-generation-restart', tenantId: 'tenant-generation-restart', shopId: 'shop-generation-restart' };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const recovery = { recoverOnce: jest.fn().mockResolvedValue({ recoveryPending: 1, stale: 0, preTransport: 0, uncertain: 0, expiredDrafts: 0 }) };
    const faults = new AiEvalFaultRegistry();
    const port = new PrismaProductionReplyEvalPort(
      {} as never,
      {} as never,
      { replyJob: { updateMany } } as never,
      { timeoutMs: 50, pollMs: 1 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      faults,
      undefined,
      recovery as never,
      undefined,
    );
    await port.prepareRestart({ ...scope, buyerId: 'buyer-generation-restart', phase: 'GENERATING' });

    const resumed = port.resumeAfterRestart({
      ...scope,
      buyerId: 'buyer-generation-restart',
      conversationId: 'conversation-generation-restart',
      phase: 'GENERATING',
      replyJobId: 'reply-generation-restart',
    });
    faults.markRestartCrash(scope.workspaceId);
    await expect(resumed).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'reply-generation-restart',
        ...scope,
        conversationId: 'conversation-generation-restart',
        status: 'GENERATING',
      },
    }));
    expect(recovery.recoverOnce).toHaveBeenCalledTimes(1);
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
        {
          id: 'task-e001', intent: 'SHIPPING_POLICY', status: 'RESOLVED',
          resultJson: { evidenceVersionIds: ['version-e001'] }, requiredToolsJson: ['GET_ORDER'],
        },
      ],
      evidences: [
        {
          id: 'evidence-e001',
          knowledgeItemId: 'knowledge-e001',
          knowledgeVersionId: 'version-e001',
          sourceType: 'MANUAL',
          scope: 'STORE',
          productId: null,
          retrievalScore: 0.91,
          retrievedContentSnapshotJson: { question: '多久发货？', answer: '普通现货商品通常24小时内发出。' },
          knowledgeKey: 'k001',
          productKey: null,
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
      tools: ['GET_ORDER'],
      evidenceDetails: [expect.objectContaining({ knowledgeKey: 'k001', productKey: null })],
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

  it('projects a no-evidence draft as MANUAL from its durable policy trace', () => {
    const execution = projectProductionReplyExecution({
      workspaceId: 'workspace-no-evidence', conversationId: 'conversation-no-evidence',
      replyJob: {
        id: 'reply-no-evidence', userTurnId: 'turn-no-evidence', status: 'WAITING_HUMAN', mode: 'AUTO',
        draft: { id: 'draft-no-evidence', aiDraft: '暂时没有找到可靠依据，已转人工确认。', status: 'WAITING_HUMAN' },
        sendOutbox: null,
      },
      tasks: [{ id: 'task-no-evidence', intent: 'PRODUCT_QUERY', status: 'FAILED', resultJson: null }],
      evidences: [],
      traceEvents: [{ id: 'trace-no-evidence', stage: 'REPLY_POLICY', payloadJson: { mode: 'MANUAL', reasons: ['NO_EVIDENCE'] } }],
      invocations: [], assistantMessages: [],
    });

    expect(execution).toMatchObject({ mode: 'MANUAL', outputSource: 'DRAFT', terminalStatus: 'WAITING_HUMAN' });
  });

  it('projects a pre-existing human takeover as MANUAL even when the stale job retained AUTO', () => {
    const execution = projectProductionReplyExecution({
      workspaceId: 'workspace-human-active', conversationId: 'conversation-human-active',
      replyJob: {
        id: 'reply-human-active', userTurnId: 'turn-human-active', status: 'STALE', mode: 'AUTO',
        conversationHumanActive: true,
        draft: null, sendOutbox: null,
      },
      tasks: [], evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
    });

    expect(execution.mode).toBe('MANUAL');
  });
});

describe('ProductionReplyEvalExecutor', () => {
  it('raises the scoped shop ceiling before an AUTO evaluation turn', async () => {
    const calls: string[] = [];
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-auto', tenantId: 'tenant-auto', shops: { shop_mia_fashion: 'shop-mia' },
        buyers: { buyer_001: 'buyer-1' }, products: {}, orders: {},
      }),
      setShopAiMode: async (input: { mode: string }) => { calls.push(`mode:${input.mode}`); },
      sendText: async () => { calls.push('send'); return { conversationId: 'conversation-auto' }; },
      sendProductCard: async () => { throw new Error('not expected'); },
      sendOrderCard: async () => { throw new Error('not expected'); },
      sendImageFixture: async () => { throw new Error('not expected'); },
      editPreviousBuyerMessage: async () => undefined,
      recallPreviousBuyerMessage: async () => undefined,
      waitForProjection: async () => ({
        workspaceId: 'workspace-auto', conversationId: 'conversation-auto',
        replyJob: {
          id: 'reply-auto', userTurnId: 'turn-auto', status: 'FAST_PATH_READY', mode: 'AUTO', draft: null,
          sendOutbox: { id: 'send-auto', status: 'SENT', payloadJson: { text: '默认使用顺丰或中通。' }, receiptJson: { externalMessageId: 'external-auto' } },
        },
        tasks: [{ id: 'task-auto', intent: 'SHIPPING_POLICY', status: 'RESOLVED', resultJson: null }],
        evidences: [], traceEvents: [{ id: 'trace-auto', stage: 'REPLY_POLICY', payloadJson: { mode: 'AUTO' } }], invocations: [],
        assistantMessages: [{ id: 'message-auto', externalMessageId: 'external-auto', contentJson: { text: '默认使用顺丰或中通。' } }],
      }),
      deleteIsolatedWorkspace: async () => { calls.push('delete'); },
    } satisfies ProductionReplyEvalPort;

    const result = await new ProductionReplyEvalExecutor(port).execute({
      id: 'A001', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_001', messages: ['发什么快递？'],
      contextSetup: { shopAiMode: 'AUTO_ALLOWED' }, expectedTasks: ['SHIPPING_POLICY'], expectedMode: 'AUTO',
      expectedFacts: ['顺丰或中通'], forbiddenClaims: [], expectedAutoSend: true,
    });

    expect(calls).toEqual(['mode:AUTO_ALLOWED', 'send', 'delete']);
    expect(result).toMatchObject({ mode: 'AUTO', outputSource: 'SENT_MESSAGE', terminalStatus: 'SENT' });
  });

  it('observes the pre-transport send boundary before recovery, then waits for the final projection', async () => {
    const calls: string[] = [];
    const sendingProjection = {
      workspaceId: 'workspace-restart-send', conversationId: 'conversation-restart-send',
      replyJob: {
        id: 'reply-restart-send', userTurnId: 'turn-restart-send', status: 'FAST_PATH_READY', mode: 'AUTO', draft: null,
        sendOutbox: { id: 'send-restart-send', status: 'SENDING', payloadJson: { text: '24小时内发货' }, receiptJson: {} },
      },
      tasks: [{ id: 'task-restart-send', intent: 'SHIPPING_POLICY', status: 'RESOLVED', resultJson: null }],
      evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
    };
    const sentProjection = {
      ...sendingProjection,
      replyJob: {
        ...sendingProjection.replyJob,
        status: 'SENT',
        sendOutbox: {
          ...sendingProjection.replyJob.sendOutbox,
          status: 'SENT',
          receiptJson: { externalMessageId: 'external-restart-send' },
        },
      },
      assistantMessages: [{
        id: 'message-restart-send', externalMessageId: 'external-restart-send', contentJson: { text: '24小时内发货' },
      }],
    };
    let resumed = false;
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-restart-send', tenantId: 'tenant-restart-send', shops: { shop_mia_fashion: 'shop-mia' },
        buyers: { buyer_001: 'buyer-1' }, products: {}, orders: {},
      }),
      prepareRestart: async () => { calls.push('prepare'); },
      sendText: async () => { calls.push('send'); return { conversationId: 'conversation-restart-send' }; },
      sendProductCard: async () => { throw new Error('not expected'); },
      sendOrderCard: async () => { throw new Error('not expected'); },
      sendImageFixture: async () => { throw new Error('not expected'); },
      editPreviousBuyerMessage: async () => undefined,
      recallPreviousBuyerMessage: async () => undefined,
      waitForPreTransportSend: async () => { calls.push('boundary'); return sendingProjection; },
      resumeAfterRestart: async (input: { projection?: unknown }) => {
        calls.push(`resume:${input.projection === sendingProjection}`);
        resumed = true;
      },
      waitForProjection: async () => {
        calls.push('final');
        if (!resumed) throw new Error('FINAL_WAIT_RAN_BEFORE_RECOVERY');
        return sentProjection;
      },
      deleteIsolatedWorkspace: async () => { calls.push('delete'); },
    } as unknown as ProductionReplyEvalPort;

    const result = await new ProductionReplyEvalExecutor(port).execute({
      id: 'E03', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_001', messages: ['多久发货？'],
      contextSetup: { restartDuring: 'SEND_OUTBOX_SENDING' }, expectedTasks: ['SHIPPING_POLICY'], expectedMode: 'AUTO',
      expectedFacts: ['24小时内发货'], forbiddenClaims: [], expectedAutoSend: true,
    });

    expect(calls).toEqual(['prepare', 'send', 'boundary', 'resume:true', 'final', 'delete']);
    expect(result).toMatchObject({ outputSource: 'SENT_MESSAGE', terminalStatus: 'SENT' });
  });

  it('arms provider and restart faults before sending, then resumes through production ports', async () => {
    const calls: string[] = [];
    const projection = {
      workspaceId: 'workspace-fault', conversationId: 'conversation-fault',
      replyJob: { id: 'reply-fault', userTurnId: 'turn-fault', status: 'WAITING_HUMAN', mode: 'ASSIST', draft: null, sendOutbox: null },
      tasks: [{ id: 'task-fault', intent: 'PRODUCT_QUERY', status: 'FAILED', resultJson: null }],
      evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
    };
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-fault', tenantId: 'tenant-fault', shops: { shop_pixel_tech: 'shop-pixel' },
        buyers: { buyer_001: 'buyer-1' }, products: {}, orders: {},
      }),
      configureProviderScenario: async () => { calls.push('provider'); },
      prepareRestart: async () => { calls.push('prepare'); },
      prepareGenerationBarrier: async () => { calls.push('barrier:prepare'); },
      waitForGenerationBarrier: async () => { calls.push('barrier:reached'); return { replyJobId: 'reply-fault' }; },
      releaseGenerationBarrier: async () => { calls.push('barrier:release'); },
      resumeAfterRestart: async (input: { replyJobId?: string }) => { calls.push(`resume:${input.replyJobId ?? 'none'}`); },
      sendText: async () => { calls.push('send'); return { conversationId: 'conversation-fault' }; },
      sendProductCard: async () => { throw new Error('not expected'); },
      sendOrderCard: async () => { throw new Error('not expected'); },
      sendImageFixture: async () => { throw new Error('not expected'); },
      editPreviousBuyerMessage: async () => undefined,
      recallPreviousBuyerMessage: async () => undefined,
      waitForProjection: async () => projection,
      deleteIsolatedWorkspace: async () => { calls.push('delete'); },
    } as unknown as ProductionReplyEvalPort;

    await new ProductionReplyEvalExecutor(port).execute({
      id: 'E-FAULT', shopKey: 'shop_pixel_tech', buyerKey: 'buyer_001', messages: ['介绍一下便携屏'],
      contextSetup: { primaryProvider: 'TIMEOUT', fallback: 'TIMEOUT', restartDuring: 'GENERATING' },
      expectedTasks: ['PRODUCT_QUERY'], expectedMode: 'ASSIST', expectedFacts: [], forbiddenClaims: [],
    });

    expect(calls).toEqual([
      'provider', 'prepare', 'barrier:prepare', 'send', 'barrier:reached',
      'barrier:release', 'resume:reply-fault', 'delete',
    ]);
  });

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
          evidences: [{ id: 'evidence-1', knowledgeItemId: 'knowledge-1', knowledgeVersionId: 'version-1', sourceType: 'HUMAN_REVIEWED', scope: 'PRODUCT', productId: 'product-1', retrievalScore: 0.96, retrievedContentSnapshotJson: { answer: '不建议使用烘干机。' } }],
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
      prepareGenerationBarrier: async () => { calls.push('barrier:prepare'); },
      waitForGenerationBarrier: async () => { calls.push('barrier:reached'); return { replyJobId: 'reply-before-mutation' }; },
      releaseGenerationBarrier: async () => { calls.push('barrier:release'); },
      changeSkuInventory: async (input: { skuExternalId: string; inventory: number }) => { calls.push(`inventory:${input.skuExternalId}:${input.inventory}`); },
      changeOrderStatus: async (input: { orderId: string; status: string }) => { calls.push(`order:${input.orderId}:${input.status}`); },
      waitForProjection: async (input: { afterReplyJobId?: string }) => {
        calls.push(`projection:after:${input.afterReplyJobId ?? 'none'}`);
        return {
          workspaceId: 'workspace-mutation', conversationId: 'conversation-mutation',
          replyJob: { id: 'reply-mutation', userTurnId: 'turn-mutation', status: 'WAITING_HUMAN', mode: 'ASSIST', draft: null, sendOutbox: null },
          tasks: [{ id: 'task-mutation', intent: 'INVENTORY_QUERY', status: 'RESOLVED', resultJson: { reply: '这个规格暂时缺货。' } }],
          evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
        };
      },
      deleteIsolatedWorkspace: async (workspaceId: string) => { calls.push(`delete:${workspaceId}`); },
    } satisfies ProductionReplyEvalPort;

    await new ProductionReplyEvalExecutor(port).execute({
      id: 'E024', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_002',
      messages: [{ type: 'GOODS_CARD', productKey: 'fashion_hoodie' }, '黑色XL有吗？'],
      contextSetup: { changeInventoryDuringGeneration: { sku: 'P-F-001-BLACK-XL', to: 0 } },
      expectedTasks: ['INVENTORY_QUERY'], expectedMode: 'ASSIST', expectedFacts: ['暂时缺货'], forbiddenClaims: [],
    });

    expect(calls).toEqual([
      'barrier:prepare',
      'text:黑色XL有吗？',
      'barrier:reached',
      'inventory:P-F-001-BLACK-XL:0',
      'barrier:release',
      'projection:after:reply-before-mutation',
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

  it('dispatches human takeover, duplicate delivery, out-of-order delivery, and logistics barriers explicitly', async () => {
    const calls: string[] = [];
    const projection = {
      workspaceId: 'workspace-reliable', conversationId: 'conversation-reliable',
      replyJob: {
        id: 'reply-reliable', userTurnId: 'turn-reliable', status: 'WAITING_HUMAN', mode: 'MANUAL',
        draft: { id: 'draft-reliable', aiDraft: '请由人工继续处理。', status: 'WAITING_HUMAN' }, sendOutbox: null,
      },
      tasks: [{ id: 'task-reliable', intent: 'LOGISTICS_QUERY', status: 'RESOLVED', resultJson: null }],
      evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
    };
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-reliable', tenantId: 'tenant-reliable', shops: { shop_mia_fashion: 'shop-mia' },
        buyers: { buyer_001: 'buyer-1' }, products: {}, orders: { order_002: 'order-2' },
      }),
      sendDuplicateText: async () => { calls.push('duplicate'); return { conversationId: 'conversation-reliable' }; },
      sendOutOfOrderTexts: async () => { calls.push('out-of-order'); return { conversationId: 'conversation-reliable' }; },
      setHumanActive: async () => { calls.push('human'); },
      prepareGenerationBarrier: async () => { calls.push('barrier:prepare'); },
      waitForGenerationBarrier: async () => { calls.push('barrier:reached'); },
      releaseGenerationBarrier: async () => { calls.push('barrier:release'); },
      changeLogistics: async () => { calls.push('logistics'); },
      sendText: async () => { throw new Error('plain send must not run'); },
      sendProductCard: async () => { throw new Error('not expected'); },
      sendOrderCard: async () => ({ conversationId: 'conversation-reliable' }),
      sendImageFixture: async () => { throw new Error('not expected'); },
      editPreviousBuyerMessage: async () => undefined,
      recallPreviousBuyerMessage: async () => undefined,
      waitForProjection: async () => projection,
      deleteIsolatedWorkspace: async () => { calls.push('delete'); },
    } as unknown as ProductionReplyEvalPort;

    await new ProductionReplyEvalExecutor(port).execute({
      id: 'E-RELIABLE', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_001',
      messages: ['first', 'second'],
      contextSetup: {
        humanActive: true,
        duplicateTransport: true,
        outOfOrderTransport: true,
        changeLogisticsDuringGeneration: { orderKey: 'order_002', toNode: '派送中' },
      },
      expectedTasks: ['LOGISTICS_QUERY'], expectedMode: 'MANUAL', expectedFacts: [], forbiddenClaims: [],
    });

    expect(calls).toEqual([
      'barrier:prepare',
      'out-of-order',
      'human',
      'barrier:reached',
      'logistics',
      'barrier:release',
      'delete',
    ]);
  });

  it('waits for one durable terminal projection before starting the next declared turn', async () => {
    const calls: string[] = [];
    const projection = {
      workspaceId: 'workspace-turns', conversationId: 'conversation-turns',
      replyJob: {
        id: 'reply-turns', userTurnId: 'turn-2', status: 'WAITING_HUMAN', mode: 'ASSIST',
        draft: { id: 'draft-turns', aiDraft: '第二轮回复。', status: 'WAITING_HUMAN' }, sendOutbox: null,
      },
      tasks: [{ id: 'task-turns', intent: 'PRODUCT_QUERY', status: 'RESOLVED', resultJson: null }],
      evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
    };
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-turns', tenantId: 'tenant-turns', shops: { shop_mia_fashion: 'shop-mia' },
        buyers: { buyer_001: 'buyer-1' }, products: {}, orders: {},
      }),
      sendText: async (input: { text: string }) => { calls.push(`text:${input.text}`); return { conversationId: 'conversation-turns' }; },
      sendProductCard: async () => { throw new Error('not expected'); },
      sendOrderCard: async () => { throw new Error('not expected'); },
      sendImageFixture: async () => { throw new Error('not expected'); },
      editPreviousBuyerMessage: async () => undefined,
      recallPreviousBuyerMessage: async () => undefined,
      waitForProjection: async (input: { afterReplyJobId?: string }) => {
        calls.push(`wait:${input.afterReplyJobId ?? 'none'}`);
        return input.afterReplyJobId
          ? projection
          : {
              ...projection,
              replyJob: { ...projection.replyJob, id: 'reply-turn-1', userTurnId: 'turn-1' },
            };
      },
      deleteIsolatedWorkspace: async () => { calls.push('delete'); },
    } as unknown as ProductionReplyEvalPort;

    await new ProductionReplyEvalExecutor(port).execute({
      id: 'E-TURNS', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_001',
      messages: [
        { type: 'TEXT', text: '第一轮', turn: 1 },
        { type: 'TEXT', text: '第二轮', turn: 2 },
      ],
      contextSetup: {}, expectedTasks: ['PRODUCT_QUERY'], expectedMode: 'ASSIST', expectedFacts: [], forbiddenClaims: [],
    });

    expect(calls).toEqual([
      'text:第一轮',
      'wait:none',
      'text:第二轮',
      'wait:reply-turn-1',
      'delete',
    ]);
  });

  it('does not wait for a phantom reply job after a recall before sending the next buyer turn', async () => {
    const calls: string[] = [];
    const projection = {
      workspaceId: 'workspace-recall', conversationId: 'conversation-recall',
      replyJob: {
        id: 'reply-logistics', userTurnId: 'turn-logistics', status: 'WAITING_HUMAN', mode: 'ASSIST',
        draft: { id: 'draft-logistics', aiDraft: '我来帮您查询物流。', status: 'WAITING_HUMAN' }, sendOutbox: null,
      },
      tasks: [{ id: 'task-logistics', intent: 'LOGISTICS_QUERY', status: 'RESOLVED', resultJson: null }],
      evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
    };
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-recall', tenantId: 'tenant-recall', shops: { shop_mia_fashion: 'shop-mia' },
        buyers: { buyer_001: 'buyer-1' }, products: {}, orders: {},
      }),
      sendText: async (input: { text: string }) => {
        calls.push(`text:${input.text}`);
        return { conversationId: 'conversation-recall' };
      },
      sendProductCard: async () => { throw new Error('not expected'); },
      sendOrderCard: async () => { throw new Error('not expected'); },
      sendImageFixture: async () => { throw new Error('not expected'); },
      editPreviousBuyerMessage: async () => { throw new Error('not expected'); },
      recallPreviousBuyerMessage: async () => { calls.push('recall'); },
      waitForProjection: async (input: { afterReplyJobId?: string }) => {
        calls.push(`wait:${input.afterReplyJobId ?? 'none'}`);
        return input.afterReplyJobId
          ? projection
          : { ...projection, replyJob: { ...projection.replyJob, id: 'reply-refund', userTurnId: 'turn-refund' } };
      },
      deleteIsolatedWorkspace: async () => { calls.push('delete'); },
    } as unknown as ProductionReplyEvalPort;

    await new ProductionReplyEvalExecutor(port).execute({
      id: 'M04', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_001',
      messages: [
        { type: 'TEXT', text: '我要退款', turn: 1 },
        { action: 'RECALL_PREVIOUS', turn: 2 },
        { type: 'TEXT', text: '发错了，我想问物流。', turn: 3 },
      ],
      contextSetup: {}, expectedTasks: ['LOGISTICS_QUERY'], expectedMode: 'ASSIST', expectedFacts: [], forbiddenClaims: [],
    });

    expect(calls).toEqual([
      'text:我要退款',
      'wait:none',
      'recall',
      'text:发错了，我想问物流。',
      'wait:reply-refund',
      'delete',
    ]);
  });

  it('establishes human takeover before the first buyer message', async () => {
    const calls: string[] = [];
    const projection = {
      workspaceId: 'workspace-human-first', conversationId: 'conversation-human-first',
      replyJob: {
        id: 'reply-human-first', userTurnId: 'turn-human-first', status: 'STALE', mode: 'MANUAL', draft: null, sendOutbox: null,
      },
      tasks: [], evidences: [], traceEvents: [], invocations: [], assistantMessages: [],
    };
    const port = {
      createIsolatedWorkspace: async () => ({
        workspaceId: 'workspace-human-first', tenantId: 'tenant-human-first', shops: { shop_mia_fashion: 'shop-mia' },
        buyers: { buyer_001: 'buyer-1' }, products: {}, orders: {},
      }),
      prepareHumanActive: async () => { calls.push('human'); return { conversationId: 'conversation-human-first' }; },
      setHumanActive: async () => { calls.push('late-human'); },
      sendText: async (input: { conversationId?: string; text: string }) => {
        calls.push(`text:${input.conversationId}:${input.text}`);
        return { conversationId: input.conversationId ?? 'unexpected' };
      },
      sendProductCard: async () => { throw new Error('not expected'); },
      sendOrderCard: async () => { throw new Error('not expected'); },
      sendImageFixture: async () => { throw new Error('not expected'); },
      editPreviousBuyerMessage: async () => undefined,
      recallPreviousBuyerMessage: async () => undefined,
      waitForProjection: async () => projection,
      deleteIsolatedWorkspace: async () => { calls.push('delete'); },
    } as unknown as ProductionReplyEvalPort;

    await new ProductionReplyEvalExecutor(port).execute({
      id: 'E-HUMAN-FIRST', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_001', messages: ['继续处理'],
      contextSetup: { humanActive: true }, expectedTasks: [], expectedMode: 'MANUAL', expectedFacts: [], forbiddenClaims: [],
    });

    expect(calls).toEqual(['human', 'text:conversation-human-first:继续处理', 'delete']);
  });
});
