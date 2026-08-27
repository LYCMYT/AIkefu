import { QualityController } from '../src/quality/quality.controller';
import { ReplyIncidentController } from '../src/incidents/reply-incident.controller';
import { TraceController } from '../src/trace/trace.controller';

const workspace = { workspaceId: 'workspace-a', tenantId: 'tenant-a', workspaceToken: 'token-a' };
const scoped = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

describe('Phase 05 Quality / Incident / Trace controller contracts', () => {
  it('derives Quality scope from stored conversation/review and returns accepted operation receipts', async () => {
    const quality = { scopeForConversation: jest.fn().mockResolvedValue(scoped), start: jest.fn().mockResolvedValue({ id: 'quality-a' }), scopeForReview: jest.fn().mockResolvedValue(scoped), conclude: jest.fn().mockResolvedValue({ id: 'quality-a' }), list: jest.fn(), get: jest.fn() };
    const controller = new QualityController(quality as never);
    await expect(controller.start(workspace as never, { conversationId: 'conversation-a' })).resolves.toEqual({ status: 'ACCEPTED', operationId: 'quality-a' });
    await expect(controller.conclude(workspace as never, 'quality-a', { result: 'PASS' })).resolves.toEqual({ status: 'ACCEPTED', operationId: 'quality-a' });
    expect(quality.scopeForConversation).toHaveBeenCalledWith(workspace, 'conversation-a');
    expect(quality.scopeForReview).toHaveBeenCalledWith(workspace, 'quality-a');
  });

  it('uses canonical incident routes without accepting caller-provided shop or conversation ownership', async () => {
    const incidents = {
      contextForReply: jest.fn().mockResolvedValue({ ...scoped, conversationId: 'conversation-a' }),
      create: jest.fn().mockResolvedValue({ id: 'incident-a', replyId: 'reply-a', originalAnswer: '旧答复' }),
      scopeForIncident: jest.fn().mockResolvedValue(scoped), correction: jest.fn().mockResolvedValue({ status: 'ACCEPTED', incidentId: 'incident-a', sendOutboxId: 'send-a' }),
      rootCause: jest.fn(), regression: jest.fn(), resolve: jest.fn(), list: jest.fn(),
    };
    const controller = new ReplyIncidentController(incidents as never);
    await expect(controller.create(workspace as never, 'reply-a', { errorType: 'GROUNDING', severity: 'HIGH' })).resolves.toEqual({ id: 'incident-a', replyId: 'reply-a', originalAnswer: '旧答复' });
    await expect(controller.correction(workspace as never, 'incident-a', { correctedAnswer: '修正', sendToBuyer: true })).resolves.toEqual({
      status: 'ACCEPTED',
      operationId: 'send-a',
      incidentId: 'incident-a',
      sendOutboxId: 'send-a',
    });
    await controller.list(workspace as never, 'conversation-a', 'OPEN', 'HIGH');
    expect(incidents.create).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conversation-a' }), expect.objectContaining({ replyMessageId: 'reply-a' }));
    expect(incidents.scopeForIncident).toHaveBeenCalledWith(workspace, 'incident-a');
    expect(incidents.list).toHaveBeenCalledWith(workspace, { conversationId: 'conversation-a', status: 'OPEN', severity: 'HIGH' });
  });

  it('keeps developer trace invisible unless trace=1 and exposes the fixed reply/conversation entry points', async () => {
    const traces = { replyTrace: jest.fn().mockResolvedValue({ traceId: 'reply:reply-a', events: [] }), conversationTrace: jest.fn().mockResolvedValue({ traceId: 'conversation:conversation-a', events: [] }) };
    const controller = new TraceController(traces as never);
    await controller.reply(workspace as never, 'reply-a', '1');
    await controller.conversation(workspace as never, 'conversation-a', undefined);
    expect(traces.replyTrace).toHaveBeenCalledWith(workspace, 'reply-a', true);
    expect(traces.conversationTrace).toHaveBeenCalledWith(workspace, 'conversation-a', false);
  });
});
