import { TraceService } from '../src/trace/trace.service';

describe('TraceService', () => {
  it('is hidden without trace=1 and maps payloadJson to a redacted DeveloperTrace payload', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'event-message', traceId: 'conversation:conversation-a', stage: 'MESSAGE_COMMITTED', payloadJson: { messageId: 'buyer-a' }, createdAt: new Date('2026-01-01') },
      { id: 'event-turn', traceId: 'conversation:conversation-a', stage: 'USER_TURN', payloadJson: { userTurnId: 'turn-a' }, createdAt: new Date('2026-01-01') },
      { id: 'event-a', traceId: 'reply-job:job-a', stage: 'EVIDENCE', payloadJson: { evidenceCount: 1 }, createdAt: new Date('2026-01-01') },
      { id: 'event-b', traceId: 'reply-job:job-a', stage: 'POLICY', payloadJson: { outcome: 'ASSIST', prompt: 'secret prompt', phone: '13800138000' }, createdAt: new Date('2026-01-01') },
      { id: 'event-guard', traceId: 'send:outbox-a', stage: 'SEND_GUARD', payloadJson: { allowed: true }, createdAt: new Date('2026-01-01') },
      { id: 'event-c', traceId: 'reply:reply-a', stage: 'SEND_RECEIPT', payloadJson: { status: 'SENT' }, createdAt: new Date('2026-01-01') },
    ]);
    const prisma = { message: { findFirst: jest.fn().mockResolvedValue({ id: 'reply-a', conversationId: 'conversation-a', externalMessageId: 'platform-message-a' }) }, sendOutbox: { findFirst: jest.fn().mockResolvedValue({ id: 'outbox-a', replyJobId: 'job-a' }) }, traceEvent: { findMany, create: jest.fn() } };
    const service = new TraceService(prisma as never);
    await expect(service.replyTrace({ workspaceId: 'workspace-a', tenantId: 'tenant-a' }, 'reply-a', false)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'TRACE_DISABLED' }) });
    await expect(service.replyTrace({ workspaceId: 'workspace-a', tenantId: 'tenant-a' }, 'reply-a', true)).resolves.toEqual(expect.objectContaining({
      traceId: 'reply:reply-a', events: expect.arrayContaining([
        expect.objectContaining({ stage: 'MESSAGE_COMMITTED', payload: { messageId: 'buyer-a' } }),
        expect.objectContaining({ stage: 'USER_TURN', payload: { userTurnId: 'turn-a' } }),
        expect.objectContaining({ stage: 'EVIDENCE', payload: { evidenceCount: 1 } }),
        expect.objectContaining({ stage: 'POLICY', createdAt: '2026-01-01T00:00:00.000Z', payload: { outcome: 'ASSIST' } }),
        expect.objectContaining({ stage: 'SEND_GUARD', payload: { allowed: true } }),
        expect.objectContaining({ stage: 'SEND_RECEIPT', payload: { status: 'SENT' } }),
      ]),
    }));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'workspace-a', tenantId: 'tenant-a', conversationId: 'conversation-a', traceId: { in: ['reply:reply-a', 'reply-job:job-a', 'send:outbox-a', 'conversation:conversation-a'] } }) }));
  });

  it('never persists nested prompt, CoT, token, raw body, or PII fields', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'event-a' });
    const service = new TraceService({ traceEvent: { create } } as never);
    await service.record({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }, 'run-a', 'POLICY', {
      outcome: 'ASSIST', prompt: 'never store', nested: { chainOfThought: 'never store', rawModelOutput: 'never store', phone: '13800138000' }, token: 'never store',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payloadJson: { outcome: 'ASSIST', nested: {} } }) }));
  });

  it('projects only scalar scope fields from a hydrated CurrentWorkspace', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'event-a' });
    const service = new TraceService({ traceEvent: { create } } as never);

    await service.record({
      workspaceId: 'workspace-a',
      tenantId: 'tenant-a',
      shopId: 'shop-a',
      conversationId: 'conversation-a',
      workspace: { id: 'workspace-a' },
      tenant: { id: 'tenant-a' },
    } as never, 'conversation:conversation-a', 'MESSAGE_COMMITTED', { messageId: 'message-a' });

    expect(create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-a',
        tenantId: 'tenant-a',
        shopId: 'shop-a',
        conversationId: 'conversation-a',
        traceId: 'conversation:conversation-a',
        stage: 'MESSAGE_COMMITTED',
        payloadJson: { messageId: 'message-a' },
      },
    });
  });
});
