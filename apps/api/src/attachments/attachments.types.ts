import type { ImageAnalysis } from './image-analysis';

export type AttachmentStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'DELETED';

/**
 * The authenticated workspace is the minimum scope for an attachment.  The
 * optional shop/buyer fields are useful to callers that operate one shop at a
 * time and let the repository apply the narrower filter when available.
 */
export type AttachmentScope = {
  workspaceId: string;
  tenantId: string;
  shopId?: string;
  buyerId?: string;
};

export type AttachmentFile = {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  size?: number;
};

export type UploadAttachmentInput = {
  shopId: string;
  buyerId: string;
  conversationId?: string;
  file: AttachmentFile;
};

export type AttachmentRecord = {
  id: string;
  workspaceId: string;
  tenantId: string;
  shopId: string;
  buyerId: string;
  conversationId: string | null;
  objectKey: string;
  mimeType: string;
  size: number;
  status: AttachmentStatus;
  containsPII: boolean;
  analysisJson: ImageAnalysis | null;
  expiresAt: Date;
  createdAt: Date;
  deletedAt: Date | null;
};

export type AttachmentCreateInput = Omit<
  AttachmentRecord,
  'id' | 'createdAt' | 'deletedAt'
> & { createdAt?: Date };

export type AttachmentOwnershipInput = {
  shopId: string;
  buyerId: string;
  conversationId?: string;
};

export interface AttachmentRepository {
  /** Verify that the foreign IDs are owned by the same workspace/tenant. */
  assertOwnership?(
    scope: AttachmentScope,
    ownership: AttachmentOwnershipInput,
  ): Promise<void>;
  create(input: AttachmentCreateInput): Promise<AttachmentRecord>;
  findById(scope: AttachmentScope, id: string): Promise<AttachmentRecord | null>;
  /** Compare-and-set PENDING -> ACTIVE within the full attachment owner scope. */
  markActive(scope: AttachmentScope, id: string, now: Date): Promise<AttachmentRecord | null>;
  markExpired(scope: AttachmentScope, id: string, now: Date): Promise<AttachmentRecord | null>;
  markDeleted?(scope: AttachmentScope, id: string, now: Date): Promise<AttachmentRecord | null>;
  listExpired(now: Date): Promise<AttachmentRecord[]>;
}

export type AttachmentView = {
  id: string;
  shopId: string;
  buyerId: string;
  conversationId?: string;
  mimeType: string;
  size: number;
  status: AttachmentStatus;
  containsPII: boolean;
  expiresAt: string;
  analysis?: ImageAnalysis;
};

export type SignedAttachmentUrl = {
  url: string;
  expiresAt: string;
};
