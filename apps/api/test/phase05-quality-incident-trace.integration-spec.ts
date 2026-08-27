import { QualityReviewService } from '../src/quality/quality-review.service';
import { ReplyIncidentService } from '../src/incidents/reply-incident.service';
import { SendOutboxService } from '../src/replies/send-outbox.service';
import { TraceService } from '../src/trace/trace.service';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

/**
 * Production-service boundary with deterministic persistence/model ports.
 * Real PostgreSQL FK/index coverage remains opt-in infra work; this proves
 * the application services use their durable repositories and never shortcut
 * visible Message creation.
 */
describe('Phase 05 Quality / Incident / Trace production-service integration', () => {
  it('freezes a manual review and makes a model outage actionable as NEEDS_HUMAN', async () => {
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 6 }) },
      message: { findMany: jest.fn().mockResolvedValue([{ id: 'reply-a', role: 'ASSISTANT', sequence: 3, contentJson: { text: '基于知识库的答复' } }]) },
      replyEvidence: { findMany: jest.fn().mockResolvedValue([{ id: 'evidence-a', knowledgeVersionId: 'version-a', retrievedContentSnapshotJson: { question: '发货', answer: '48小时内' } }]) },
      qualityReview: { create: jest.fn().mockResolvedValue({ id: 'quality-a', conversationId: 'conversation-a', sampleSize: 1, status: 'PENDING' }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), qualityReview: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const service = new QualityReviewService(prisma as never, { runStructured: jest.fn().mockRejectedValue(new Error('judge unavailable')) } as never);
    await expect(service.start(scope, { conversationId: 'conversation-a' })).resolves.toMatchObject({
      id: 'quality-a', status: 'NEEDS_HUMAN', sampleSize: 1,
      metrics: expect.objectContaining({ frozenReplyCount: 1, frozenEvidenceCount: 1, deterministicCheckPassRate: 1 }),
    });
    expect(prisma.qualityReview.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'NEEDS_HUMAN', deterministicResultJson: expect.any(Object), metricsJson: expect.objectContaining({ frozenReplyCount: 1 }),
    }) }));
  });

  it('persists a correction as a HUMAN SendOutbox intent and leaves visible Message projection to receipt processing', async () => {
    const incident = { id: 'incident-a', ...scope, conversationId: 'conversation-a', replyMessageId: 'reply-a', status: 'OPEN' };
    const tx = {
      replyIncident: { findFirst: jest.fn().mockResolvedValue(incident), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', lastCommittedSequence: 8, contextVersion: 3 }) },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'buyer-a' }), create: jest.fn() },
      sendOutbox: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'correction-send-a', status: 'PENDING' }) },
    };
    const prisma = { $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)), replyIncident: { findFirst: jest.fn().mockResolvedValue(incident) } };
    const incidents = new ReplyIncidentService(prisma as never, new SendOutboxService(prisma as never));
    await expect(incidents.correction(scope, 'incident-a', { correctedAnswer: '请以实时订单状态为准。', sendToBuyer: true })).resolves.toEqual({ incidentId: 'incident-a', sendOutboxId: 'correction-send-a', status: 'ACCEPTED' });
    expect(tx.sendOutbox.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING', payloadJson: { text: '请以实时订单状态为准。', senderRole: 'HUMAN' } }) }));
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it('records sanitized structured events and returns them only through a trace=1 scoped endpoint', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const prisma = {
      traceEvent: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `event-${rows.length + 1}`, createdAt: new Date('2026-08-30T10:00:00.000Z'), ...data }; rows.push(row); return row; }),
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => {
          const traceIds = where.traceId && typeof where.traceId === 'object' && Array.isArray((where.traceId as { in?: unknown }).in) ? (where.traceId as { in: unknown[] }).in : undefined;
          return row.workspaceId === where.workspaceId && row.tenantId === where.tenantId && row.conversationId === where.conversationId && (!traceIds || traceIds.includes(row.traceId));
        })),
      },
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'reply-a', conversationId: 'conversation-a', externalMessageId: 'platform-message-a' }) },
      sendOutbox: { findFirst: jest.fn().mockResolvedValue({ id: 'send-a', replyJobId: 'job-a' }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a' }) },
    };
    const traces = new TraceService(prisma as never);
    await traces.record({ ...scope, conversationId: 'conversation-a' }, 'conversation:conversation-a', 'MESSAGE_COMMITTED', { messageId: 'buyer-a', rawMessages: ['private'] });
    await traces.record({ ...scope, conversationId: 'conversation-a' }, 'conversation:conversation-a', 'USER_TURN', { userTurnId: 'turn-a', content: 'private' });
    await traces.record({ ...scope, conversationId: 'conversation-a' }, 'reply-job:job-a', 'POLICY', { outcome: 'AUTO', reasoning: 'private' });
    await traces.record({ ...scope, conversationId: 'conversation-a' }, 'send:send-a', 'SEND_GUARD', { allowed: true, token: 'private' });
    await traces.record({ ...scope, conversationId: 'conversation-a' }, 'reply:reply-a', 'SEND_RECEIPT', { sendOutboxId: 'send-a', prompt: 'private', rawModelOutput: 'private', phone: '13800138000' });
    await traces.record({ ...scope, conversationId: 'conversation-b' }, 'conversation:conversation-b', 'MESSAGE_COMMITTED', { messageId: 'other-conversation' });
    await traces.record({ workspaceId: 'workspace-b', tenantId: scope.tenantId, shopId: scope.shopId, conversationId: 'conversation-a' }, 'conversation:conversation-a', 'MESSAGE_COMMITTED', { messageId: 'other-workspace' });
    await expect(traces.replyTrace({ workspaceId: scope.workspaceId, tenantId: scope.tenantId }, 'reply-a', false)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'TRACE_DISABLED' }) });
    const trace = await traces.replyTrace({ workspaceId: scope.workspaceId, tenantId: scope.tenantId }, 'reply-a', true);
    expect(trace.events.map((event) => event.stage)).toEqual(['MESSAGE_COMMITTED', 'USER_TURN', 'POLICY', 'SEND_GUARD', 'SEND_RECEIPT']);
    expect(trace.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'MESSAGE_COMMITTED', payload: { messageId: 'buyer-a' } }),
      expect.objectContaining({ stage: 'USER_TURN', payload: { userTurnId: 'turn-a' } }),
      expect.objectContaining({ stage: 'SEND_GUARD', payload: { allowed: true } }),
      expect.objectContaining({ stage: 'SEND_RECEIPT', payload: { sendOutboxId: 'send-a' } }),
    ]));
    expect(trace.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ messageId: 'other-conversation' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ messageId: 'other-workspace' }) }),
    ]));
  });
});
