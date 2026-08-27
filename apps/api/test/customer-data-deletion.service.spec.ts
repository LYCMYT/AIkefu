import type { CustomerDataDeletionResult } from '@ai-customer-service/contracts';
import { CustomerDataDeletionService } from '../src/privacy/customer-data-deletion.service';

describe('CustomerDataDeletionService', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
  const now = new Date('2026-08-27T12:00:00.000Z');

  function createHarness() {
    const tx = {
      knowledgeCandidate: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      traceEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      aIInvocation: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      aIUsage: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      processingOutbox: {
        findMany: jest.fn().mockResolvedValue([{ eventId: 'event-a' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      processingReceipt: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      attachment: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      customerMemory: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      conversation: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      buyer: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      evalCase: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { updateMany: jest.fn().mockResolvedValue({ count: 3 }), create: jest.fn().mockResolvedValue({ id: 'audit-a', createdAt: now }) },
    };
    const prisma = {
      buyer: { findFirst: jest.fn().mockResolvedValue({ id: 'buyer-a', anonymizedAt: null }) },
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      conversation: { findMany: jest.fn().mockResolvedValue([{ id: 'conversation-a' }]) },
      message: { findMany: jest.fn().mockResolvedValue([{ id: 'message-a' }]) },
      userTurn: { findMany: jest.fn().mockResolvedValue([{ id: 'turn-a' }]) },
      replyJob: { findMany: jest.fn().mockResolvedValue([{ id: 'reply-job-a' }]) },
      replyIncident: { findMany: jest.fn().mockResolvedValue([{ id: 'incident-a', regressionCaseId: 'eval-a' }]) },
      attachment: { findMany: jest.fn().mockResolvedValue([{ id: 'attachment-a' }]) },
      order: { findMany: jest.fn().mockResolvedValue([{ id: 'order-a' }]) },
      $transaction: jest.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    };
    const attachments = { deleteForCustomerData: jest.fn().mockResolvedValue(true) };
    return { tx, prisma, attachments, service: new CustomerDataDeletionService(prisma as never, attachments as never) };
  }

  it('uses the complete workspace/tenant scope, deletes customer chat derivatives and attachments, then preserves only anonymous aggregates', async () => {
    const { tx, prisma, attachments, service } = createHarness();

    const expected: CustomerDataDeletionResult = {
      buyerId: 'buyer-a',
      status: 'COMPLETED',
      deleted: { conversations: 1, messages: 1, attachments: 1, customerMemories: 2, knowledgeCandidates: 2 },
      anonymized: { buyers: 1, orders: 1 },
      preserved: { anonymousAggregates: 1, auditFacts: 4 },
      completedAt: now.toISOString(),
    };
    await expect(service.deleteCustomerData(scope, 'buyer-a', now)).resolves.toEqual(expected);

    expect(prisma.buyer.findFirst).toHaveBeenCalledWith({
      where: { id: 'buyer-a', workspaceId: 'workspace-a', tenantId: 'tenant-a' },
      select: { id: true, anonymizedAt: true },
    });
    expect(prisma.conversation.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a', tenantId: 'tenant-a', buyerId: 'buyer-a' },
      select: { id: true },
    });
    expect(attachments.deleteForCustomerData).toHaveBeenCalledWith(
      { workspaceId: 'workspace-a', tenantId: 'tenant-a', buyerId: 'buyer-a' },
      'attachment-a',
      now,
    );
    expect(tx.knowledgeCandidate.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'workspace-a', tenantId: 'tenant-a',
        OR: [
          { sourceConversationId: { in: ['conversation-a'] } },
          { sourceReplyJobId: { in: ['reply-job-a'] } },
        ],
      },
    });
    expect(tx.customerMemory.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a', tenantId: 'tenant-a', buyerId: 'buyer-a' },
    });
    expect(tx.attachment.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a', tenantId: 'tenant-a', buyerId: 'buyer-a', id: { in: ['attachment-a'] } },
    });
    expect(tx.conversation.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a', tenantId: 'tenant-a', buyerId: 'buyer-a' },
    });
    expect(tx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'order-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', buyerId: 'buyer-a' },
      data: expect.objectContaining({ logisticsSnapshotJson: expect.anything(), seedKey: expect.stringMatching(/^anonymized-order-/) }),
    }));
    const orderUpdate = tx.order.updateMany.mock.calls[0][0].data;
    expect(orderUpdate).not.toHaveProperty('amount');
    expect(orderUpdate).not.toHaveProperty('status');
    expect(orderUpdate).not.toHaveProperty('orderedAt');
    expect(tx.buyer.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'buyer-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', anonymizedAt: null, attachments: { none: {} } },
      data: expect.objectContaining({ seedKey: expect.stringMatching(/^anonymized-buyer-/), displayName: '已匿名化客户', avatar: null, tagsJson: [], anonymizedAt: now }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: 'workspace-a', tenantId: 'tenant-a', action: 'CUSTOMER_DATA_DELETED', entityType: 'BUYER', entityId: expect.stringMatching(/^anonymized-buyer-/),
      }),
    }));
  });

  it('rejects a same-id buyer outside the authenticated tenant before touching storage or database records', async () => {
    const { prisma, attachments, service } = createHarness();
    prisma.buyer.findFirst.mockResolvedValue(null);

    await expect(service.deleteCustomerData(scope, 'buyer-from-another-tenant', now)).rejects.toMatchObject({
      response: { code: 'CUSTOMER_DATA_SUBJECT_NOT_FOUND' },
    });
    expect(attachments.deleteForCustomerData).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not delete database metadata when an object-storage deletion cannot be confirmed', async () => {
    const { prisma, attachments, service } = createHarness();
    attachments.deleteForCustomerData.mockRejectedValue(new Error('object storage unavailable'));

    await expect(service.deleteCustomerData(scope, 'buyer-a', now)).rejects.toThrow('object storage unavailable');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails closed when a previously discovered attachment cannot be durably confirmed as erased', async () => {
    const { prisma, attachments, service } = createHarness();
    attachments.deleteForCustomerData.mockResolvedValue(false);

    await expect(service.deleteCustomerData(scope, 'buyer-a', now)).rejects.toMatchObject({
      response: { code: 'CUSTOMER_DATA_ATTACHMENT_UNCONFIRMED' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns the same durable completion result on a repeated request without reopening customer storage or creating another audit fact', async () => {
    const { tx, prisma, attachments, service } = createHarness();
    prisma.buyer.findFirst.mockResolvedValue({ id: 'buyer-a', anonymizedAt: now });
    prisma.auditLog.findFirst.mockResolvedValue({
      createdAt: now,
      metadataJson: {
        deleted: { conversations: 1, messages: 1, attachments: 1, customerMemories: 2, knowledgeCandidates: 2 },
        anonymized: { buyers: 1, orders: 1 },
        preserved: { anonymousAggregates: 1, auditFacts: 4 },
      },
    });

    await expect(service.deleteCustomerData(scope, 'buyer-a', new Date('2026-08-28T12:00:00.000Z'))).resolves.toEqual({
      buyerId: 'buyer-a', status: 'COMPLETED',
      deleted: { conversations: 1, messages: 1, attachments: 1, customerMemories: 2, knowledgeCandidates: 2 },
      anonymized: { buyers: 1, orders: 1 },
      preserved: { anonymousAggregates: 1, auditFacts: 4 },
      completedAt: now.toISOString(),
    });
    expect(attachments.deleteForCustomerData).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
