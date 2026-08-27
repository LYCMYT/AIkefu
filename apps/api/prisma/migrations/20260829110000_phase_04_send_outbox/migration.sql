CREATE TYPE "SendOutboxStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN', 'CANCELLED');

CREATE TABLE "SendOutbox" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "replyJobId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "expectedLastMessageId" TEXT,
    "expectedSequence" INTEGER,
    "expectedContextVersion" INTEGER,
    "status" "SendOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "receiptJson" JSONB,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SendOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SendOutbox_replyJobId_key" ON "SendOutbox"("replyJobId");
CREATE UNIQUE INDEX "SendOutbox_idempotencyKey_key" ON "SendOutbox"("idempotencyKey");
CREATE INDEX "SendOutbox_workspaceId_tenantId_shopId_status_createdAt_idx" ON "SendOutbox"("workspaceId", "tenantId", "shopId", "status", "createdAt");
CREATE INDEX "SendOutbox_workspaceId_tenantId_shopId_conversationId_status_idx" ON "SendOutbox"("workspaceId", "tenantId", "shopId", "conversationId", "status");

ALTER TABLE "SendOutbox" ADD CONSTRAINT "SendOutbox_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SendOutbox" ADD CONSTRAINT "SendOutbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SendOutbox" ADD CONSTRAINT "SendOutbox_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SendOutbox" ADD CONSTRAINT "SendOutbox_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SendOutbox" ADD CONSTRAINT "SendOutbox_replyJobId_fkey" FOREIGN KEY ("replyJobId") REFERENCES "ReplyJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
