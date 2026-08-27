import { AttachmentService } from '../src/attachments/attachments.service';

describe('AttachmentService customer-data erasure', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', buyerId: 'buyer-a' };
  const record = {
    id: 'attachment-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', buyerId: 'buyer-a', conversationId: 'conversation-a',
    objectKey: 'attachments/opaque', mimeType: 'image/png', size: 12, status: 'ACTIVE' as const,
    containsPII: false, analysisJson: null, expiresAt: new Date('2026-09-01'), createdAt: new Date('2026-08-01'), deletedAt: null,
  };

  it('fails closed when object deletion succeeds but the durable metadata tombstone cannot be committed', async () => {
    const repository = {
      findById: jest.fn().mockResolvedValue(record),
      markDeleted: jest.fn().mockResolvedValue(null),
    };
    const storage = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const service = new AttachmentService(repository as never, storage as never);

    await expect(service.deleteForCustomerData(scope, record.id, new Date('2026-08-27'))).rejects.toMatchObject({
      response: { code: 'ATTACHMENT_DELETE_METADATA_FAILED' },
    });
    expect(storage.deleteObject).toHaveBeenCalledWith('attachments/opaque');
    expect(repository.markDeleted).toHaveBeenCalledWith(scope, record.id, expect.any(Date));
  });

  it('is idempotent after a prior durable tombstone and does not need an object read/delete retry', async () => {
    const repository = {
      findById: jest.fn().mockResolvedValue({ ...record, status: 'DELETED' as const }),
      markDeleted: jest.fn(),
    };
    const storage = { deleteObject: jest.fn() };
    const service = new AttachmentService(repository as never, storage as never);

    await expect(service.deleteForCustomerData(scope, record.id)).resolves.toBe(true);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(repository.markDeleted).not.toHaveBeenCalled();
  });
});
