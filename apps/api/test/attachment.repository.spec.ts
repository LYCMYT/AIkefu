import { PrismaAttachmentRepository } from '../src/attachments/attachments.repository';

describe('PrismaAttachmentRepository upload intent transitions', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', buyerId: 'buyer-a' };
  const now = new Date('2026-08-27T00:00:00.000Z');

  it('activates only the exact PENDING attachment in the full owner scope and sweeps PENDING intents', async () => {
    const row = {
      id: 'attachment-a', ...scope, conversationId: null, objectKey: 'attachments/opaque', mimeType: 'image/png', size: 1,
      status: 'ACTIVE', containsPII: false, analysisJson: null, expiresAt: now, createdAt: now,
    };
    const attachment = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([row]),
    };
    const repository = new PrismaAttachmentRepository({ attachment } as never);

    await expect(repository.markActive(scope, 'attachment-a', now)).resolves.toMatchObject({ id: 'attachment-a', status: 'ACTIVE' });
    expect(attachment.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'attachment-a',
        workspaceId: 'workspace-a',
        tenantId: 'tenant-a',
        shopId: 'shop-a',
        buyerId: 'buyer-a',
        status: 'PENDING',
      },
      data: { status: 'ACTIVE' },
    });

    await expect(repository.listExpired(now)).resolves.toHaveLength(1);
    expect(attachment.findMany).toHaveBeenCalledWith({
      where: { status: { in: ['PENDING', 'ACTIVE'] }, expiresAt: { lte: now } },
    });
  });
});
