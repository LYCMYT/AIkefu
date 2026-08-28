import { ConversationReplyControlService } from '../src/replies/conversation-reply-control.service';

describe('ConversationReplyControlService', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

  it('rejects AUTO when the scoped shop ceiling is not AUTO_ALLOWED', async () => {
    const tx = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 3, shop: { aiMode: 'ASSIST_ONLY' } }),
        updateMany: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new ConversationReplyControlService(
      { $transaction: jest.fn((work: Function) => work(tx)) } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.setMode(scope, 'conversation-a', 'AUTO')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SHOP_AUTO_MODE_DISABLED' }),
    });
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
  });

  it('persists AUTO as the configured base when the shop ceiling allows it', async () => {
    const tx = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 3, shop: { aiMode: 'AUTO_ALLOWED' } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new ConversationReplyControlService(
      { $transaction: jest.fn((work: Function) => work(tx)) } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.setMode(scope, 'conversation-a', 'AUTO')).resolves.toMatchObject({
      overrideMode: 'AUTO', effectiveMode: 'AUTO', shopAiMode: 'AUTO_ALLOWED', humanActive: false,
    });
    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conversation-a', ...scope },
      data: { mode: 'AUTO', overrideMode: 'AUTO', humanActive: false, needsReplan: true },
    });
  });

  it('soft-recalls only a scoped outgoing message while preserving its version and audit facts', async () => {
    const message = {
      id: 'message-human', conversationId: 'conversation-a', shopId: 'shop-a', role: 'HUMAN', status: 'ACTIVE',
      contentJson: { text: '人工回复' }, sequence: 9, _count: { versions: 1 },
    };
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a' }), update: jest.fn().mockResolvedValue({ id: 'conversation-a' }) },
      message: {
        findFirst: jest.fn().mockResolvedValue(message),
        update: jest.fn().mockResolvedValue({ ...message, status: 'RECALLED' }),
      },
      messageVersion: { create: jest.fn().mockResolvedValue({ id: 'version-2' }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
      conversationMemory: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const gateway = { publish: jest.fn() };
    const service = new ConversationReplyControlService(
      { $transaction: jest.fn((work: Function) => work(tx)) } as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      gateway as never,
    );

    await expect(service.deleteOutgoingMessage(scope, 'conversation-a', 'message-human')).resolves.toEqual({
      id: 'message-human', status: 'RECALLED', remoteRecalled: false,
    });
    expect(tx.messageVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      workspaceId: 'workspace-a', tenantId: 'tenant-a', messageId: 'message-human', version: 2, status: 'ACTIVE',
    }) });
    expect(tx.message.update).toHaveBeenCalledWith({ where: { id: 'message-human' }, data: { status: 'RECALLED' } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: 'OUTGOING_MESSAGE_SOFT_RECALLED', entityType: 'MESSAGE', entityId: 'message-human',
    }) });
    expect(gateway.publish).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'CONVERSATION_UPDATED', entityId: 'conversation-a',
    }));
  });

  it('refuses to delete a buyer message through the operator reply endpoint', async () => {
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a' }) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-buyer', role: 'BUYER', status: 'ACTIVE', _count: { versions: 0 } }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new ConversationReplyControlService(
      { $transaction: jest.fn((work: Function) => work(tx)) } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.deleteOutgoingMessage(scope, 'conversation-a', 'message-buyer')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OUTGOING_MESSAGE_REQUIRED' }),
    });
  });

  it('takes over in the exact scope and stales active jobs before an automatic send can claim them', async () => {
    const tx = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', shopId: 'shop-a', contextVersion: 6 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new ConversationReplyControlService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.takeover(scope, 'conversation-a')).resolves.toMatchObject({ humanActive: true, overrideMode: 'MANUAL' });
    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conversation-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', humanActive: false },
      data: { humanActive: true, overrideMode: 'MANUAL' },
    });
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ conversationId: 'conversation-a', status: { in: expect.arrayContaining(['PENDING', 'GENERATING']) } }),
      data: { status: 'STALE', staleReason: 'HUMAN_TAKEOVER' },
    }));
  });

  it('publishes a scoped conversation refresh after a durable reply-control transition', async () => {
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const gateway = { publish: jest.fn() };
    const service = new ConversationReplyControlService({ $transaction: jest.fn((work: Function) => work(tx)) } as never, {} as never, {} as never, {} as never, undefined, gateway as never);

    await service.setMode(scope, 'conversation-a', 'MANUAL');
    expect(gateway.publish).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'CONVERSATION_UPDATED', workspaceId: 'workspace-a', entityType: 'CONVERSATION', entityId: 'conversation-a',
      payload: { conversationId: 'conversation-a', refresh: true },
    }));
  });

  it('cancels a not-yet-transported AI PENDING send in the same takeover lock, so resume cannot revive the old reply', async () => {
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyJob: { findMany: jest.fn().mockResolvedValue([{ id: 'reply-old' }]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      sendOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, $queryRaw: jest.fn(),
    };
    const service = new ConversationReplyControlService({ $transaction: jest.fn((work: Function) => work(tx)) } as never, {} as never, {} as never, {} as never);

    await service.takeover(scope, 'conversation-a');

    expect(tx.sendOutbox.updateMany.mock.calls[0]![0]).toEqual({
      where: expect.objectContaining({ replyJobId: { in: ['reply-old'] }, status: 'PENDING', payloadJson: { path: ['senderRole'], equals: 'AI' } }),
      data: { status: 'CANCELLED', failureCode: 'REPLY_JOB_STALE', failureReason: 'HUMAN_TAKEOVER' },
    });
  });

  it('persists MANUAL/HOLD as human-active and cancels pending scheduled sends; resume only sets needsReplan', async () => {
    const tx = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new ConversationReplyControlService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.setMode(scope, 'conversation-a', 'MANUAL')).resolves.toMatchObject({ humanActive: true });
    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conversation-a', ...scope }, data: { mode: 'MANUAL', overrideMode: 'MANUAL', humanActive: true, needsReplan: true },
    });
    expect(tx.processingOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ aggregateId: 'conversation-a', eventType: { in: ['SCHEDULED_WELCOME', 'SCHEDULED_CLOSING'] }, status: 'PENDING' }),
      data: { status: 'FAILED' },
    }));

    await expect(service.resumeAi(scope, 'conversation-a')).resolves.toMatchObject({ resumed: true, humanActive: false });
    expect(tx.conversation.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'conversation-a', ...scope, humanActive: true }, data: { humanActive: false, mode: 'ASSIST', overrideMode: null, needsReplan: true },
    });
  });

  it('downgrades AUTO to ASSIST by staling the old generation and creating a fresh ASSIST job from the latest turn', async () => {
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 7 }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyJob: { findMany: jest.fn().mockResolvedValue([{ id: 'reply-auto' }]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, sendOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      userTurn: { findFirst: jest.fn().mockResolvedValue({ id: 'turn-latest', lastSequence: 8, sourceMessageIdsJson: ['message-8'] }) },
      processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, $queryRaw: jest.fn(),
    };
    const replyJobs = { createInTransaction: jest.fn().mockResolvedValue({ id: 'reply-assist' }) };
    const runtime = { process: jest.fn().mockResolvedValue({ status: 'WAITING_HUMAN' }) };
    const service = new ConversationReplyControlService({ $transaction: jest.fn((work: Function) => work(tx)) } as never, {} as never, replyJobs as never, {} as never, runtime as never);

    await expect(service.setMode(scope, 'conversation-a', 'ASSIST')).resolves.toMatchObject({ overrideMode: 'ASSIST', replyJobId: 'reply-assist' });
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'STALE', staleReason: 'MODE_CHANGED' } }));
    expect(replyJobs.createInTransaction).toHaveBeenCalledWith(tx, scope, expect.objectContaining({ mode: 'ASSIST', userTurnId: 'turn-latest', sourceContextVersion: 7 }), { lockHeld: true });
    expect(runtime.process).toHaveBeenCalledWith(scope, 'reply-assist');
  });

  it('resume creates a fresh PENDING job from the newest turn instead of reviving the stale job', async () => {
    const tx = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 7, lastCommittedSequence: 9 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      userTurn: { findFirst: jest.fn().mockResolvedValue({ id: 'turn-new', lastSequence: 9, sourceMessageIdsJson: ['message-9'] }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const replyJobs = { createInTransaction: jest.fn().mockResolvedValue({ id: 'reply-new', status: 'PENDING' }) };
    const runtime = { process: jest.fn().mockResolvedValue({ status: 'WAITING_HUMAN' }) };
    const service = new ConversationReplyControlService({ $transaction: jest.fn((work: Function) => work(tx)) } as never, {} as never, replyJobs as never, {} as never, runtime as never);

    await expect(service.resumeAi(scope, 'conversation-a')).resolves.toMatchObject({ resumed: true, replyJobId: 'reply-new' });
    expect(replyJobs.createInTransaction).toHaveBeenCalledWith(tx, scope, expect.objectContaining({
      conversationId: 'conversation-a', userTurnId: 'turn-new', sourceLastMessageId: 'message-9', sourceSequence: 9, sourceContextVersion: 7, mode: 'ASSIST',
    }), { lockHeld: true });
    expect(runtime.process).toHaveBeenCalledWith(scope, 'reply-new');
  });

  it('regenerate commits a new job then invokes the runtime outside the transaction', async () => {
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 7, humanActive: false, lastCommittedSequence: 9 }) },
      userTurn: { findFirst: jest.fn().mockResolvedValue({ id: 'turn-new', lastSequence: 9, sourceMessageIdsJson: ['message-9'] }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const replyJobs = { createInTransaction: jest.fn().mockResolvedValue({ id: 'reply-regenerated', status: 'PENDING' }) };
    const runtime = { process: jest.fn().mockResolvedValue({ status: 'WAITING_HUMAN' }) };
    const service = new ConversationReplyControlService({ $transaction: jest.fn((work: Function) => work(tx)) } as never, {} as never, replyJobs as never, {} as never, runtime as never);

    await expect(service.regenerate(scope, 'conversation-a')).resolves.toMatchObject({ id: 'reply-regenerated' });
    expect(runtime.process).toHaveBeenCalledWith(scope, 'reply-regenerated');
  });

  it('stores AI draft and human final but enqueues its delivery; only a later receipt can mark it SENT/visible', async () => {
    const tx = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', buyerId: 'buyer-a', lastCommittedSequence: 8, contextVersion: 5 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyDraft: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'draft-a', replyJobId: 'reply-a', aiDraft: '48 小时发货', sourceContextVersion: 5, sourceLastMessageId: 'message-8', sourceSequence: 8, status: 'WAITING_HUMAN',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      userTurn: { findFirst: jest.fn().mockResolvedValue({ normalizedText: '什么时候发货？' }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const knowledge = { createHumanCandidateInTransaction: jest.fn().mockResolvedValue({ id: 'candidate-a', status: 'PENDING' }) };
    const outboxes = { enqueueInTransaction: jest.fn().mockResolvedValue({ id: 'send-a', status: 'PENDING' }) };
    const service = new ConversationReplyControlService(prisma as never, knowledge as never, {} as never, outboxes as never);

    await expect(service.saveHumanFinal(scope, 'conversation-a', {
      text: '偏远地区通常 72 小时内发货。', sourceDraftId: 'draft-a', editType: 'FACTUAL_CORRECTION',
    })).resolves.toMatchObject({ sendOutboxId: 'send-a', candidateId: 'candidate-a' });

    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'draft-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', status: 'WAITING_HUMAN' },
      data: { humanFinal: '偏远地区通常 72 小时内发货。', editType: 'FACTUAL_CORRECTION' },
    });
    expect(outboxes.enqueueInTransaction).toHaveBeenCalledWith(tx, scope, expect.objectContaining({
      replyJobId: 'reply-a', conversationId: 'conversation-a', text: '偏远地区通常 72 小时内发货。',
      expectedLastMessageId: 'message-8', expectedSequence: 8, expectedContextVersion: 5,
    }));
    expect((tx as { message?: unknown }).message).toBeUndefined();
    expect(knowledge.createHumanCandidateInTransaction).toHaveBeenCalledWith(tx, scope, expect.objectContaining({
      shopId: 'shop-a', conversationId: 'conversation-a', replyJobId: 'reply-a',
      question: '什么时候发货？', answer: '偏远地区通常 72 小时内发货。', source: 'FACTUAL_CORRECTION',
    }));
  });

  it('allows an operator in MANUAL takeover to enqueue a scoped human final without an AI draft', async () => {
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', buyerId: 'buyer-a', lastCommittedSequence: 8, contextVersion: 5, humanActive: true, overrideMode: 'MANUAL' }) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'message-8' }) },
      replyDraft: { findFirst: jest.fn() }, replyJob: { updateMany: jest.fn() }, userTurn: { findFirst: jest.fn() }, $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const outboxes = { enqueueInTransaction: jest.fn().mockResolvedValue({ id: 'send-human', status: 'PENDING' }) };
    const service = new ConversationReplyControlService({ $transaction: jest.fn((work: Function) => work(tx)) } as never, {} as never, {} as never, outboxes as never);

    await expect(service.saveHumanFinal(scope, 'conversation-a', { text: '我来为您处理。' })).resolves.toEqual({ sendOutboxId: 'send-human' });
    expect(outboxes.enqueueInTransaction).toHaveBeenCalledWith(tx, scope, expect.objectContaining({
      conversationId: 'conversation-a', text: '我来为您处理。', senderRole: 'HUMAN',
      expectedLastMessageId: 'message-8', expectedSequence: 8, expectedContextVersion: 5,
    }));
  });

  it('rejects a no-draft human final before takeover, so AUTO cannot bypass the draft/send policy', async () => {
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', buyerId: 'buyer-a', lastCommittedSequence: 8, contextVersion: 5, humanActive: false, overrideMode: null }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new ConversationReplyControlService({ $transaction: jest.fn((work: Function) => work(tx)) } as never, {} as never, {} as never, {} as never);

    await expect(service.saveHumanFinal(scope, 'conversation-a', { text: '越过草稿的发送' })).rejects.toMatchObject({ response: { code: 'HUMAN_MESSAGE_DRAFT_REQUIRED' } });
  });
});
