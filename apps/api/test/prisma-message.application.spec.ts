import { PrismaMessageApplication } from '../src/messages/prisma-message.application';
import { NotFoundException } from '@nestjs/common';

const scope = { workspaceId: 'workspace-1', tenantId: 'tenant-1' };

describe('PrismaMessageApplication memory invalidation', () => {
  it.each([
    ['editMessage', 'EDITED', 'MESSAGE_EDITED'],
    ['recallMessage', 'RECALLED', 'MESSAGE_RECALLED'],
  ] as const)('%s schedules a dirty summary rebuild only after its transaction commits', async (method, nextStatus, eventType) => {
    let committed = false;
    const updatedMessage = {
      id: 'message-1',
      workspaceId: 'workspace-1',
      tenantId: 'tenant-1',
      shopId: 'shop-1',
      conversationId: 'conversation-1',
      buyerId: 'buyer-1',
      externalMessageId: 'external-message-1',
      sequence: 4,
      kind: 'TEXT',
      status: nextStatus,
      role: 'BUYER',
      contentJson: { text: nextStatus === 'EDITED' ? 'edited' : 'original' },
      sentAt: new Date('2026-08-27T00:00:00.000Z'),
      receivedAt: new Date('2026-08-27T00:00:00.000Z'),
      createdAt: new Date('2026-08-27T00:00:00.000Z'),
    };
    const originalMessage = { ...updatedMessage, status: 'ACTIVE', contentJson: { text: 'original' }, _count: { versions: 0 } };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      message: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({ conversationId: 'conversation-1' })
          .mockResolvedValueOnce(originalMessage),
        update: jest.fn().mockResolvedValue(updatedMessage),
        create: jest.fn(),
      },
      messageVersion: { create: jest.fn().mockResolvedValue({ id: 'version-1' }) },
      conversation: { update: jest.fn().mockResolvedValue({ id: 'conversation-1' }) },
      conversationMemory: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      message: { findFirst: jest.fn().mockResolvedValue({ shopId: 'shop-1', externalMessageId: 'external-message-1' }) },
      conversation: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
        const result = await work(tx);
        committed = true;
        return result;
      }),
    };
    const memory = {
      scheduleRebuild: jest.fn(async () => {
        expect(committed).toBe(true);
      }),
    };
    const replyDrafts = { staleForContext: jest.fn().mockResolvedValue(undefined) };
    const adapter = { editMessage: jest.fn(), recallMessage: jest.fn() };
    const app = new PrismaMessageApplication(
      prisma as never,
      { publish: jest.fn() } as never,
      adapter as never,
      {} as never,
      memory as never,
      undefined,
      replyDrafts as never,
    );
    const publishMessage = jest.spyOn(app as any, 'publishMessage').mockImplementation(() => undefined);
    jest.spyOn(app as any, 'publishConversation').mockResolvedValue(undefined);

    if (method === 'editMessage') {
      await app.editMessage(scope, 'message-1', 'edited');
    } else {
      await app.recallMessage(scope, 'message-1');
    }

    expect(tx.conversationMemory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ conversationId: 'conversation-1', basedOnThroughSequence: { gte: 4 } }),
      data: { status: 'DIRTY' },
    }));
    expect(memory.scheduleRebuild).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1', tenantId: 'tenant-1', shopId: 'shop-1', conversationId: 'conversation-1', reason: 'MESSAGE_MUTATED',
    }));
    expect(replyDrafts.staleForContext).toHaveBeenCalledWith(
      tx,
      { workspaceId: 'workspace-1', tenantId: 'tenant-1', shopId: 'shop-1' },
      'conversation-1',
      nextStatus === 'EDITED' ? 'MESSAGE_EDITED' : 'MESSAGE_RECALLED',
    );
    expect(adapter[method === 'editMessage' ? 'editMessage' : 'recallMessage']).toHaveBeenCalledTimes(1);
    expect(publishMessage).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ id: 'message-1' }),
      eventType,
    );
  });

  it('persists a summarized late message as DIRTY in the commit transaction and schedules only afterward', async () => {
    let committed = false;
    const conversation = {
      id: 'conversation-1',
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: 'shop-1',
      buyerId: 'buyer-1',
      lastCommittedSequence: 8,
      syncState: 'CONNECTED',
    };
    const persistedMessage = {
      id: 'message-late',
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: 'shop-1',
      buyerId: 'buyer-1',
      conversationId: 'conversation-1',
      externalMessageId: 'late-message',
      sequence: 4,
      role: 'BUYER',
      kind: 'TEXT',
      status: 'ACTIVE',
      contentJson: { text: 'late arrival' },
      sentAt: new Date('2026-08-27T00:00:00.000Z'),
      receivedAt: new Date('2026-08-27T00:00:00.000Z'),
      createdAt: new Date('2026-08-27T00:00:00.000Z'),
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      conversation: {
        findFirst: jest.fn().mockResolvedValue(conversation),
        update: jest.fn().mockResolvedValue(conversation),
      },
      reorderBufferEntry: {
        aggregate: jest.fn().mockResolvedValue({ _max: { sequence: null } }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      message: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(persistedMessage),
      },
      processingOutbox: { create: jest.fn().mockResolvedValue({ id: 'outbox-1' }) },
      conversationMemory: {
        updateMany: jest.fn(async () => {
          expect(committed).toBe(false);
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
        const result = await work(tx);
        committed = true;
        return result;
      }),
    };
    const memory = {
      // The old path used this post-commit write. It must never be reached:
      // a process could die between commit and this call.
      markDirtyForLateMessage: jest.fn().mockResolvedValue(true),
      scheduleRebuild: jest.fn(async () => {
        expect(committed).toBe(true);
      }),
    };
    const app = new PrismaMessageApplication(
      prisma as never,
      { publish: jest.fn() } as never,
      {} as never,
      {} as never,
      memory as never,
    );
    jest.spyOn(app as any, 'assertShop').mockResolvedValue(undefined);
    jest.spyOn(app as any, 'assertBuyer').mockResolvedValue(undefined);
    jest.spyOn(app as any, 'publishMessage').mockImplementation(() => undefined);
    jest.spyOn(app as any, 'publishConversation').mockResolvedValue(undefined);
    jest.spyOn(app as any, 'dispatchPending').mockResolvedValue(undefined);

    await expect((app as any).ingest(scope, {
      shopId: 'shop-1',
      buyerId: 'buyer-1',
      conversationId: 'conversation-1',
      kind: 'TEXT',
      content: { text: 'late arrival' },
      sentAt: '2026-08-27T00:00:00.000Z',
      forcedSequence: 4,
      externalMessageId: 'late-message',
    })).resolves.toMatchObject({ status: 'ACCEPTED' });

    expect(tx.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'conversation-1' },
      data: expect.objectContaining({ contextVersion: { increment: 1 }, needsReplan: true }),
    }));
    expect(tx.conversationMemory.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        shopId: 'shop-1',
        conversationId: 'conversation-1',
        basedOnThroughSequence: { gte: 4 },
      },
      data: { status: 'DIRTY' },
    });
    expect(memory.markDirtyForLateMessage).not.toHaveBeenCalled();
    expect(memory.scheduleRebuild).toHaveBeenCalledWith({
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: 'shop-1',
      conversationId: 'conversation-1',
      reason: 'LATE_MESSAGE',
    });
  });
});

describe('PrismaMessageApplication image attachment ownership', () => {
  const attachment = {
    id: 'attachment-1',
    shopId: 'shop-1',
    buyerId: 'buyer-1',
    containsPII: false,
    analysis: { scene: 'PRODUCT', observations: ['保温杯'], confidence: 0.9, containsPII: false, requiresHuman: false },
  };

  function createApplication() {
    const attachments = {
      get: jest.fn(async (attachmentScope: { workspaceId: string; tenantId: string; shopId?: string; buyerId?: string }, attachmentId: string) => {
        if (
          attachmentId !== attachment.id ||
          attachmentScope.workspaceId !== scope.workspaceId ||
          attachmentScope.tenantId !== scope.tenantId ||
          attachmentScope.shopId !== attachment.shopId ||
          attachmentScope.buyerId !== attachment.buyerId
        ) {
          throw new NotFoundException({ code: 'ATTACHMENT_NOT_FOUND', message: 'attachment not found' });
        }
        return attachment;
      }),
    };
    const app = new PrismaMessageApplication(
      {} as never,
      { publish: jest.fn() } as never,
      {} as never,
      attachments as never,
      {} as never,
    );
    const ingest = jest.spyOn(app as any, 'ingest').mockResolvedValue({ status: 'ACCEPTED', operationId: 'message-op' });
    return { app, attachments, ingest };
  }

  it('ingests an IMAGE when the attachment belongs to the selected shop and buyer', async () => {
    const { app, attachments, ingest } = createApplication();

    await expect(app.sendMessage(scope, {
      shopId: attachment.shopId,
      buyerId: attachment.buyerId,
      kind: 'IMAGE',
      attachmentId: attachment.id,
    })).resolves.toEqual({ status: 'ACCEPTED', operationId: 'message-op' });

    expect(attachments.get).toHaveBeenCalledWith({
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      shopId: attachment.shopId,
      buyerId: attachment.buyerId,
    }, attachment.id);
    expect(ingest).toHaveBeenCalledWith(scope, expect.objectContaining({
      shopId: attachment.shopId,
      buyerId: attachment.buyerId,
      kind: 'IMAGE',
      content: expect.objectContaining({ attachmentId: attachment.id, analysisStatus: 'READY' }),
    }));
  });

  it.each([
    ['shop', { shopId: 'shop-other', buyerId: attachment.buyerId }],
    ['buyer', { shopId: attachment.shopId, buyerId: 'buyer-other' }],
  ] as const)('rejects a same-workspace attachment lookup for the wrong %s', async (_label, ownership) => {
    const { app, attachments, ingest } = createApplication();

    await expect(app.sendMessage(scope, {
      ...ownership,
      kind: 'IMAGE',
      attachmentId: attachment.id,
    })).rejects.toMatchObject({ status: 404, response: { code: 'ATTACHMENT_NOT_FOUND' } });

    expect(attachments.get).toHaveBeenCalledWith({ ...scope, ...ownership }, attachment.id);
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('PrismaMessageApplication scheduled welcome intent', () => {
  it('writes a single durable welcome plan in the same transaction as the first committed message', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const conversation = {
      id: 'conversation-welcome', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-1', buyerId: 'buyer-1',
      contextVersion: 1, lastCommittedSequence: 0, syncState: 'CONNECTED', state: 'ACTIVE',
    };
    const message = {
      id: 'message-welcome', ...scope, shopId: 'shop-1', buyerId: 'buyer-1', conversationId: conversation.id,
      platform: 'DOUYIN_DEMO', externalMessageId: 'external-welcome', sequence: 1, role: 'BUYER', kind: 'TEXT', status: 'ACTIVE',
      contentJson: { text: '你好' }, sentAt: now, receivedAt: now, createdAt: now,
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      conversation: { findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValue({ contextVersion: 2, lastCommittedSequence: 1 }), create: jest.fn().mockResolvedValue(conversation), update: jest.fn().mockResolvedValue(conversation) },
      reorderBufferEntry: { aggregate: jest.fn().mockResolvedValue({ _max: { sequence: null } }), findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
      message: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(message) },
      processingOutbox: { create: jest.fn().mockResolvedValue({ id: 'message-outbox' }) },
      shopSettings: { findFirst: jest.fn().mockResolvedValue({ welcomeMessage: '您好，欢迎咨询。' }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const schedules = { planWelcomeInTransaction: jest.fn().mockResolvedValue({ id: 'welcome-plan' }) };
    const app = new PrismaMessageApplication(
      prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never,
      undefined, undefined, undefined, schedules as never,
    );
    jest.spyOn(app as any, 'assertShop').mockResolvedValue(undefined);
    jest.spyOn(app as any, 'assertBuyer').mockResolvedValue(undefined);
    jest.spyOn(app as any, 'publishMessage').mockImplementation(() => undefined);
    jest.spyOn(app as any, 'publishConversation').mockResolvedValue(undefined);
    jest.spyOn(app as any, 'dispatchPending').mockResolvedValue(undefined);

    await (app as any).ingest(scope, {
      shopId: 'shop-1', buyerId: 'buyer-1', kind: 'TEXT', content: { text: '你好' }, sentAt: now.toISOString(), externalMessageId: 'external-welcome',
    });

    expect(schedules.planWelcomeInTransaction).toHaveBeenCalledWith(tx, {
      workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-1',
    }, {
      id: 'conversation-welcome', contextVersion: 2, lastCommittedSequence: 1, lastMessageId: 'message-welcome',
    }, '您好，欢迎咨询。', expect.any(Date));
  });
});

describe('PrismaMessageApplication durable outbox dispatch', () => {
  it('coalesces concurrent dispatcher ticks into one global drain per process', async () => {
    let releaseFind: ((rows: unknown[]) => void) | undefined;
    const findMany = jest.fn(() => new Promise<unknown[]>((resolve) => { releaseFind = resolve; }));
    const prisma = {
      processingOutbox: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany,
      },
    };
    const app = new PrismaMessageApplication(prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never);

    const first = (app as any).dispatchPending();
    const second = (app as any).dispatchPending();
    while (findMany.mock.calls.length === 0) await Promise.resolve();

    expect(findMany).toHaveBeenCalledTimes(1);
    releaseFind?.([]);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('periodically reclaims a stale message-consumer DISPATCHING lease instead of stranding it until restart', async () => {
    const prisma = { processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) } };
    const app = new PrismaMessageApplication(prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never);

    await (app as any).dispatchPending();

    expect(prisma.processingOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'DISPATCHING', eventType: { in: expect.arrayContaining(['MESSAGE_RECEIVED', 'USER_TURN_READY']) }, updatedAt: { lt: expect.any(Date) },
      }),
      data: { status: 'PENDING', availableAt: expect.any(Date) },
    }));
  });

  it('never hands scheduled events to the message worker and uses a BullMQ-safe opaque job id', async () => {
    const outbox = {
      id: 'outbox-1', eventId: 'reply-plan:turn-a', eventType: 'USER_TURN_READY', status: 'PENDING', attempts: 0,
      workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-1', availableAt: new Date(), createdAt: new Date(),
    };
    const prisma = {
      processingOutbox: {
        findMany: jest.fn().mockResolvedValue([outbox]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
    };
    const app = new PrismaMessageApplication(prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never);
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    (app as any).queue = queue;

    await (app as any).dispatchPending();

    expect(prisma.processingOutbox.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ eventType: { in: expect.arrayContaining(['MESSAGE_RECEIVED', 'USER_TURN_READY']) } }),
    }));
    expect(queue.add).toHaveBeenCalledWith('outbox', { kind: 'OUTBOX', eventId: 'reply-plan:turn-a' }, expect.objectContaining({
      jobId: expect.stringMatching(/^outbox-[a-f0-9]{64}$/),
    }));
    expect(prisma.processingOutbox.update).not.toHaveBeenCalled();
  });

  it('marks a message outbox dispatched only after its queued consumer completes', async () => {
    const prisma = { processingOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const app = new PrismaMessageApplication(prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never);
    jest.spyOn(app as any, 'consumeOutbox').mockResolvedValue(undefined);

    await (app as any).processRuntimeJob({ data: { kind: 'OUTBOX', eventId: 'reply-plan:turn-a' } });

    expect(prisma.processingOutbox.updateMany).toHaveBeenCalledWith({
      where: { eventId: 'reply-plan:turn-a', status: 'DISPATCHING' },
      data: { status: 'DISPATCHED', dispatchedAt: expect.any(Date) },
    });
  });
});

describe('PrismaMessageApplication buyer-context invalidation', () => {
  it('marks active jobs and drafts stale in the same commit as every new buyer message', async () => {
    const tx = {
      message: { create: jest.fn().mockResolvedValue({ id: 'message-9', ...scope, shopId: 'shop-1', buyerId: 'buyer-1', conversationId: 'conversation-1', externalMessageId: 'external-9', sequence: 9, role: 'BUYER', kind: 'TEXT', contentJson: { text: '补充一下' }, sentAt: new Date(), receivedAt: new Date(), createdAt: new Date() }) },
      processingOutbox: { create: jest.fn() },
      conversation: { update: jest.fn() },
    };
    const drafts = { staleForContext: jest.fn().mockResolvedValue(undefined) };
    const app = new PrismaMessageApplication({} as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never, undefined, drafts as never);

    await (app as any).persistCommitted(tx, scope, {
      platform: 'DOUYIN_DEMO', shopId: 'shop-1', buyerId: 'buyer-1', conversationId: 'conversation-1', externalMessageId: 'external-9',
      sequence: 9, kind: 'TEXT', content: { text: '补充一下' }, sentAt: '2026-08-30T00:00:00.000Z', receivedAt: '2026-08-30T00:00:00.000Z',
    });

    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conversation-1' },
      data: expect.objectContaining({ contextVersion: { increment: 1 }, needsReplan: true, unreadCount: { increment: 1 } }),
    });
    expect(drafts.staleForContext).toHaveBeenCalledWith(tx, {
      workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-1',
    }, 'conversation-1', 'NEW_BUYER_MESSAGE');
  });
});

describe('PrismaMessageApplication Phase 04 snapshot projection', () => {
  it('projects only the scoped active ReplyJob, draft, send intent, and its task bundle into the conversation snapshot', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const activeJob = {
      id: 'reply-active', workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: 'shop-1', conversationId: 'conversation-1', userTurnId: 'turn-1',
      status: 'WAITING_HUMAN', mode: 'ASSIST', sourceLastMessageId: 'message-1', sourceSequence: 1, sourceContextVersion: 4,
      staleReason: null, createdAt: now, updatedAt: now,
      draft: { id: 'draft-1', replyJobId: 'reply-active', aiDraft: '草稿', humanFinal: null, editType: null, status: 'WAITING_HUMAN', sourceContextVersion: 4, sourceLastMessageId: 'message-1', sourceSequence: 1, generatedAt: now, expiresAt: new Date(now.getTime() + 300000), staleReason: null, updatedAt: now },
      sendOutbox: { id: 'send-1', conversationId: 'conversation-1', replyJobId: 'reply-active', idempotencyKey: 'reply-send:reply-active', payloadJson: { text: '草稿' }, expectedLastMessageId: 'message-1', expectedSequence: 1, expectedContextVersion: 4, status: 'PENDING', receiptJson: null, failureCode: null, failureReason: null, createdAt: now, updatedAt: now },
      evidences: [],
    };
    const conversation = {
      id: 'conversation-1', ...scope, shopId: 'shop-1', buyerId: 'buyer-1', externalConversationId: 'external-1', state: 'ACTIVE', mode: 'ASSIST', overrideMode: null,
      syncState: 'CONNECTED', contextVersion: 4, lastCommittedSequence: 1, activeTopic: null, currentProductId: null, currentOrderId: null, humanActive: false, needsReplan: false,
      idleExpiresAt: null, createdAt: now, updatedAt: now, unreadCount: 0,
      buyer: { id: 'buyer-1', workspaceId: scope.workspaceId, tenantId: scope.tenantId, displayName: '买家', avatar: null, tagsJson: [] },
      messages: [], turnBuffer: null, userTurns: [{ id: 'turn-1', sourceMessageIdsJson: ['message-1'], normalizedText: '多久发货？', firstSequence: 1, lastSequence: 1, turnKey: 'turn', status: 'PLANNED', createdAt: now, updatedAt: now }],
      currentProduct: null, currentOrder: null, memory: null, replyJobs: [activeJob],
      tasks: [{ id: 'task-1', userTurnId: 'turn-1', intent: 'SHIPPING_POLICY', riskLevel: 'LOW', operation: 'READ', requiredContextJson: [], requiredKnowledgeJson: [], requiredToolsJson: [], status: 'RESOLVED', resultJson: { reply: '草稿' }, errorCode: null, blocking: false, createdAt: now, updatedAt: now }],
      sendOutboxes: [activeJob.sendOutbox],
    };
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue(conversation) } };
    const app = new PrismaMessageApplication(prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never);

    await expect(app.getConversation(scope, 'conversation-1')).resolves.toMatchObject({
      activeReplyJobId: 'reply-active', activeReplyJob: expect.objectContaining({ id: 'reply-active', currentDraft: expect.objectContaining({ id: 'draft-1' }) }),
      currentDraft: expect.objectContaining({ id: 'draft-1' }), sendOutbox: expect.objectContaining({ id: 'send-1' }),
      taskBundle: expect.objectContaining({ userTurnId: 'turn-1', tasks: [expect.objectContaining({ id: 'task-1' })] }),
    });
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'conversation-1', ...scope }, include: expect.objectContaining({ replyJobs: expect.any(Object), tasks: expect.any(Object), sendOutboxes: expect.any(Object) }),
    }));
  });

  it('caps an AUTO conversation override to the shop ASSIST_ONLY ceiling in its snapshot', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const conversation = {
      id: 'conversation-cap', ...scope, shopId: 'shop-1', buyerId: 'buyer-1', externalConversationId: 'external-cap', state: 'ACTIVE', mode: 'AUTO', overrideMode: 'AUTO',
      syncState: 'CONNECTED', contextVersion: 1, lastCommittedSequence: 0, activeTopic: null, currentProductId: null, currentOrderId: null, humanActive: false, needsReplan: false,
      idleExpiresAt: null, createdAt: now, updatedAt: now, unreadCount: 0, shop: { aiMode: 'ASSIST_ONLY' },
      buyer: { id: 'buyer-1', workspaceId: scope.workspaceId, tenantId: scope.tenantId, displayName: '买家', avatar: null, tagsJson: [] },
      messages: [], turnBuffer: null, userTurns: [], currentProduct: null, currentOrder: null, memory: null, replyJobs: [], tasks: [], sendOutboxes: [],
    };
    const app = new PrismaMessageApplication({ conversation: { findFirst: jest.fn().mockResolvedValue(conversation) } } as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never);

    await expect(app.getConversation(scope, 'conversation-cap')).resolves.toMatchObject({ effectiveMode: 'ASSIST' });
  });
});
