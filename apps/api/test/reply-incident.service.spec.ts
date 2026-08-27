import { ReplyIncidentService } from '../src/incidents/reply-incident.service';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

describe('ReplyIncidentService', () => {
  it('derives correction from the scoped incident and enqueues a HUMAN SendOutbox instead of writing a visible message', async () => {
    const incident = { id: 'incident-a', conversationId: 'conversation-a', replyMessageId: 'reply-a', status: 'OPEN' };
    const tx = {
      replyIncident: { findFirst: jest.fn().mockResolvedValue(incident), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', lastCommittedSequence: 7, contextVersion: 3 }) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'buyer-last' }), create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), replyIncident: tx.replyIncident };
    const sends = { enqueueInTransaction: jest.fn().mockResolvedValue({ id: 'outbox-a', status: 'PENDING' }) };
    const service = new ReplyIncidentService(prisma as never, sends as never);

    await expect(service.correction(scope, 'incident-a', { correctedAnswer: '请以最新订单状态为准', sendToBuyer: true })).resolves.toEqual({
      incidentId: 'incident-a', sendOutboxId: 'outbox-a', status: 'ACCEPTED',
    });
    expect(sends.enqueueInTransaction).toHaveBeenCalledWith(tx, scope, expect.objectContaining({
      conversationId: 'conversation-a', senderRole: 'HUMAN', expectedLastMessageId: 'buyer-last', expectedSequence: 7, expectedContextVersion: 3,
    }));
    expect(tx.replyIncident.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CORRECTION_DRAFTED', correctionSendOutboxId: 'outbox-a' }) }));
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it('uses scoped CAS for root-cause and resolve mutations', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findFirstOrThrow = jest.fn().mockResolvedValue({ id: 'incident-a', status: 'RESOLVED' });
    const prisma = { replyIncident: { updateMany, findFirstOrThrow } };
    const service = new ReplyIncidentService(prisma as never, {} as never);
    await service.rootCause(scope, 'incident-a', 'stale facts');
    await service.resolve(scope, 'incident-a');
    expect(updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: expect.objectContaining({ id: 'incident-a', ...scope }) }));
    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({ id: 'incident-a', ...scope }) }));
  });

  it('does not let a later correction text diverge from an already queued human send', async () => {
    const tx = {
      replyIncident: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'incident-a', conversationId: 'conversation-a', status: 'CORRECTION_DRAFTED',
          correctedAnswer: '已排队的修正 A', correctionSendOutboxId: 'outbox-a',
        }),
        updateMany: jest.fn(),
      },
      conversation: { findFirst: jest.fn() },
      message: { findFirst: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
      replyIncident: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const sends = { enqueueInTransaction: jest.fn() };
    const service = new ReplyIncidentService(prisma as never, sends as never);

    await expect(service.correction(scope, 'incident-a', {
      correctedAnswer: '不同的修正 B', sendToBuyer: true,
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CORRECTION_SEND_IMMUTABLE' }) });
    await expect(service.correction(scope, 'incident-a', {
      correctedAnswer: '已排队的修正 A', sendToBuyer: true,
    })).resolves.toEqual({ incidentId: 'incident-a', sendOutboxId: 'outbox-a', status: 'ACCEPTED' });
    expect(sends.enqueueInTransaction).not.toHaveBeenCalled();
    expect(tx.replyIncident.updateMany).not.toHaveBeenCalled();
  });

  it('rejects workflow-breaking incident state jumps instead of silently overwriting a later state', async () => {
    const prisma = { replyIncident: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    const service = new ReplyIncidentService(prisma as never, {} as never);
    await expect(service.rootCause(scope, 'incident-a', 'cause')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REPLY_INCIDENT_STATE_INVALID' }) });
    await expect(service.resolve(scope, 'incident-a')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REPLY_INCIDENT_STATE_INVALID' }) });
    expect(prisma.replyIncident.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: expect.objectContaining({ status: 'CORRECTED', ...scope }) }));
    expect(prisma.replyIncident.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({ status: 'REGRESSION_ADDED', ...scope }) }));
  });

  it('only links an explicitly supplied active EvalCase from the same full scope', async () => {
    const tx = {
      replyIncident: { findFirst: jest.fn().mockResolvedValue({ id: 'incident-a', status: 'ROOT_CAUSE_FIXED', replyMessageId: 'reply-a', correctedAnswer: '修正' }), update: jest.fn().mockResolvedValue({ id: 'incident-a', status: 'REGRESSION_ADDED' }) },
      evalCase: { findFirst: jest.fn().mockResolvedValue({ id: 'eval-a', status: 'ACTIVE' }), upsert: jest.fn() },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new ReplyIncidentService(prisma as never, {} as never);
    await expect(service.regression(scope, 'incident-a', { caseId: 'eval-a' })).resolves.toMatchObject({ evalCaseId: 'eval-a' });
    expect(tx.evalCase.findFirst).toHaveBeenCalledWith({ where: { id: 'eval-a', ...scope, status: 'ACTIVE' } });
    expect(tx.evalCase.upsert).not.toHaveBeenCalled();
  });

  it('applies declared status and severity filters under the caller workspace/tenant, and rejects undeclared values', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new ReplyIncidentService({ replyIncident: { findMany } } as never, {} as never);

    await service.list(scope, { conversationId: 'conversation-a', status: 'OPEN', severity: 'HIGH' });

    expect(findMany).toHaveBeenCalledWith({
      where: { ...scope, conversationId: 'conversation-a', status: 'OPEN', severity: 'HIGH' },
      orderBy: { createdAt: 'desc' },
    });
    await expect(service.list(scope, { status: 'UNKNOWN' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INCIDENT_STATUS_INVALID' }) });
    await expect(service.list(scope, { severity: 'URGENT' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INCIDENT_SEVERITY_INVALID' }) });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('rejects an undeclared incident severity before querying or creating a scoped incident', async () => {
    const findFirst = jest.fn();
    const service = new ReplyIncidentService({ message: { findFirst } } as never, {} as never);

    await expect(service.create(scope, {
      conversationId: 'conversation-a', replyMessageId: 'reply-a', errorType: 'GROUNDING', severity: 'URGENT',
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INCIDENT_SEVERITY_INVALID' }) });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
