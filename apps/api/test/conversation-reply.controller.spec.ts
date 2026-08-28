import { ConversationReplyController } from '../src/replies/conversation-reply.controller';

describe('ConversationReplyController contract', () => {
  const workspace = { workspaceId: 'workspace-a', tenantId: 'tenant-a' } as never;

  it('uses POST mode with an explicit shopId and returns the durable control projection expected by the workbench', async () => {
    const controls = { setMode: jest.fn().mockResolvedValue({ id: 'conversation-a', overrideMode: 'ASSIST', effectiveMode: 'ASSIST', shopAiMode: 'ASSIST_ONLY', humanActive: false }) };
    const controller = new ConversationReplyController(controls as never);

    await expect(controller.setMode(workspace, 'conversation-a', { shopId: 'shop-a', mode: 'ASSIST' })).resolves.toEqual({ id: 'conversation-a', overrideMode: 'ASSIST', effectiveMode: 'ASSIST', shopAiMode: 'ASSIST_ONLY', humanActive: false });
    expect(controls.setMode).toHaveBeenCalledWith({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }, 'conversation-a', 'ASSIST');
  });

  it('accepts a human final as a durable send intent with its real outbox/candidate identifiers, never a visible Message', async () => {
    const controls = { saveHumanFinal: jest.fn().mockResolvedValue({ sendOutboxId: 'send-a', candidateId: 'candidate-a' }) };
    const controller = new ConversationReplyController(controls as never);

    await expect(controller.humanMessage(workspace, 'conversation-a', { shopId: 'shop-a', text: '人工回复' })).resolves.toEqual({ status: 'ACCEPTED', sendOutboxId: 'send-a', candidateId: 'candidate-a' });
  });

  it('returns the scoped takeover and resume state rather than an unrelated operation id', async () => {
    const controls = {
      takeover: jest.fn().mockResolvedValue({ id: 'conversation-a', overrideMode: 'MANUAL', humanActive: true }),
      resumeAi: jest.fn().mockResolvedValue({ id: 'conversation-a', overrideMode: null, humanActive: false, resumed: true, replyJobId: 'reply-new' }),
    };
    const controller = new ConversationReplyController(controls as never);

    await expect(controller.takeover(workspace, 'conversation-a', { shopId: 'shop-a' })).resolves.toEqual({ id: 'conversation-a', overrideMode: 'MANUAL', humanActive: true });
    await expect(controller.resumeAi(workspace, 'conversation-a', { shopId: 'shop-a' })).resolves.toEqual({ id: 'conversation-a', overrideMode: null, humanActive: false, resumed: true });
  });

  it('binds an outgoing soft-recall to workspace, shop, conversation, and message', async () => {
    const controls = {
      deleteOutgoingMessage: jest.fn().mockResolvedValue({ id: 'message-a', status: 'RECALLED', remoteRecalled: false }),
    };
    const controller = new ConversationReplyController(controls as never);

    await expect(controller.deleteOutgoingMessage(
      workspace, 'conversation-a', 'message-a', { shopId: 'shop-a' },
    )).resolves.toEqual({ id: 'message-a', status: 'RECALLED', remoteRecalled: false });
    expect(controls.deleteOutgoingMessage).toHaveBeenCalledWith(
      { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' },
      'conversation-a', 'message-a',
    );
  });
});
