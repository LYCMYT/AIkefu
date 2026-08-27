import { ReplyIncidentPublisher } from '../src/incidents/reply-incident.publisher';

describe('ReplyIncidentPublisher', () => {
  it('publishes a canonical Incident payload after a durable state transition', () => {
    const gateway = { publish: jest.fn() };
    const publisher = new ReplyIncidentPublisher(gateway as never);
    publisher.publish({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }, {
      id: 'incident-a', replyMessageId: 'reply-a', originalAnswerSnapshot: '旧答案', status: 'CORRECTED',
    });
    expect(gateway.publish).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'REPLY_INCIDENT_UPDATED', workspaceId: 'workspace-a',
      payload: { incident: expect.objectContaining({ id: 'incident-a', replyId: 'reply-a', originalAnswer: '旧答案', status: 'CORRECTED' }) },
    }));
  });
});
