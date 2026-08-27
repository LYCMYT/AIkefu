import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { WorkspaceScope } from '../workspaces/workspace.repository';

type AttachmentRow = {
  id: string;
  conversationId: string | null;
  containsPII: boolean;
};

type AttachmentTransaction = {
  attachment: {
    findFirst(args: { where: Record<string, unknown>; select: Record<string, boolean> }): Promise<AttachmentRow | null>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
};

/**
 * Bind an image to its first conversation inside the message transaction.
 * An attachment is deliberately single-conversation data: this prevents a
 * PII-bearing image (and, conservatively, every already-bound image) from
 * being replayed into a different buyer conversation.
 */
export async function bindImageAttachmentToConversation(
  tx: AttachmentTransaction,
  scope: WorkspaceScope,
  input: { attachmentId: string; shopId: string; buyerId: string; conversationId: string },
): Promise<void> {
  const where = {
    id: input.attachmentId,
    workspaceId: scope.workspaceId,
    tenantId: scope.tenantId,
    shopId: input.shopId,
    buyerId: input.buyerId,
    status: 'ACTIVE',
  };
  const attachment = await tx.attachment.findFirst({
    where,
    select: { id: true, conversationId: true, containsPII: true },
  });
  if (!attachment) {
    throw new NotFoundException({ code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found in this conversation scope' });
  }
  if (attachment.conversationId && attachment.conversationId !== input.conversationId) {
    throw new BadRequestException({
      code: attachment.containsPII ? 'ATTACHMENT_PII_CONVERSATION_REUSE_FORBIDDEN' : 'ATTACHMENT_CONVERSATION_REUSE_FORBIDDEN',
      message: 'Attachment is already bound to a different conversation',
    });
  }
  if (attachment.conversationId === input.conversationId) return;

  // Compare-and-set makes simultaneous first uses deterministic.  Only the
  // transaction that successfully claims a null conversationId may persist
  // its message; the loser rechecks and fails closed if it lost to another
  // conversation.
  const claimed = await tx.attachment.updateMany({
    where: { ...where, conversationId: null },
    data: { conversationId: input.conversationId },
  });
  if (claimed.count === 1) return;
  const afterRace = await tx.attachment.findFirst({
    where,
    select: { id: true, conversationId: true, containsPII: true },
  });
  if (!afterRace || afterRace.conversationId !== input.conversationId) {
    throw new BadRequestException({
      code: afterRace?.containsPII ? 'ATTACHMENT_PII_CONVERSATION_REUSE_FORBIDDEN' : 'ATTACHMENT_CONVERSATION_REUSE_FORBIDDEN',
      message: 'Attachment is already bound to a different conversation',
    });
  }
}
