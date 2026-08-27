import { BadRequestException } from '@nestjs/common';
import { bindImageAttachmentToConversation } from '../src/attachments/attachment-conversation-binding';

describe('bindImageAttachmentToConversation', () => {
  const scope = { workspaceId: 'w1', tenantId: 't1' };

  it('claims an unbound image with compare-and-set in the message transaction', async () => {
    const tx = {
      attachment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'a1', conversationId: null, containsPII: false }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    await bindImageAttachmentToConversation(tx, scope, { attachmentId: 'a1', shopId: 's1', buyerId: 'b1', conversationId: 'c1' });
    expect(tx.attachment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'ACTIVE' }),
    }));
    expect(tx.attachment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 'w1', tenantId: 't1', shopId: 's1', buyerId: 'b1', conversationId: null }),
      data: { conversationId: 'c1' },
    }));
  });

  it('allows reuse only in the same conversation and forbids PII cross-conversation replay', async () => {
    const tx = {
      attachment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'a1', conversationId: 'c-old', containsPII: true }),
        updateMany: jest.fn(),
      },
    };
    await expect(
      bindImageAttachmentToConversation(tx, scope, { attachmentId: 'a1', shopId: 's1', buyerId: 'b1', conversationId: 'c-new' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.attachment.updateMany).not.toHaveBeenCalled();
  });
});
