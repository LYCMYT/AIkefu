import { BadRequestException } from '@nestjs/common';
import { AttachmentsController } from '../src/attachments/attachments.controller';

describe('AttachmentsController shop isolation', () => {
  const workspace = {
    workspaceId: 'workspace-a', tenantId: 'tenant-a',
    workspace: {} as never, tenant: {} as never,
  };

  it.each(['signedUrl', 'remove'] as const)('requires shopId for %s and passes it into the trusted scope', async (method) => {
    const service = {
      createSignedUrl: jest.fn().mockResolvedValue({ url: 'https://example.invalid', expiresAt: new Date().toISOString() }),
      delete: jest.fn().mockResolvedValue({ id: 'attachment-a' }),
    };
    const controller = new AttachmentsController(service as never) as unknown as Record<
      typeof method,
      (scope: typeof workspace, attachmentId: string, shopId?: string) => unknown
    >;

    expect(() => controller[method](workspace, 'attachment-a')).toThrow(BadRequestException);
    await controller[method](workspace, 'attachment-a', 'shop-a');
    const operation = method === 'signedUrl' ? service.createSignedUrl : service.delete;
    expect(operation).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }),
      'attachment-a',
    );
  });
});
