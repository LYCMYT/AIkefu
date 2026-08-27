import { CustomerDataDeletionController } from '../src/privacy/customer-data-deletion.controller';

describe('CustomerDataDeletionController', () => {
  const scope = {
    workspaceId: 'workspace-a',
    tenantId: 'tenant-a',
    workspace: {
      id: 'workspace-a', status: 'ACTIVE' as const,
      lastAccessedAt: '2026-08-27T12:00:00.000Z', expiresAt: '2026-08-28T12:00:00.000Z', createdAt: '2026-08-27T12:00:00.000Z',
    },
    tenant: { id: 'tenant-a', workspaceId: 'workspace-a', name: 'Demo tenant' },
  };

  it('exposes the frozen buyer customer-data route through the scoped service', async () => {
    const result = {
      buyerId: 'buyer-a', status: 'COMPLETED' as const,
      deleted: { conversations: 1, messages: 1, attachments: 1, customerMemories: 0, knowledgeCandidates: 0 },
      anonymized: { buyers: 1, orders: 1 },
      preserved: { anonymousAggregates: 1, auditFacts: 1 },
      completedAt: '2026-08-27T12:00:00.000Z',
    };
    const deletion = { deleteCustomerData: jest.fn().mockResolvedValue(result) };
    const controller = new CustomerDataDeletionController(deletion as never);

    await expect(controller.remove(scope, ' buyer-a ')).resolves.toEqual(result);
    expect(deletion.deleteCustomerData).toHaveBeenCalledWith(scope, 'buyer-a');
  });

  it('rejects an empty route parameter before a deletion service can run', async () => {
    const deletion = { deleteCustomerData: jest.fn() };
    const controller = new CustomerDataDeletionController(deletion as never);

    await expect(controller.remove(scope, '  ')).rejects.toMatchObject({
      response: { code: 'CUSTOMER_DATA_SUBJECT_INVALID' },
    });
    expect(deletion.deleteCustomerData).not.toHaveBeenCalled();
  });
});
