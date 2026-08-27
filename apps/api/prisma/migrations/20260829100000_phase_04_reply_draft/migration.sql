CREATE TYPE "ReplyDraftStatus" AS ENUM ('GENERATING', 'WAITING_HUMAN', 'STALE', 'EXPIRED', 'FAILED', 'SENT', 'CANCELLED');
CREATE TYPE "ReplyDraftEditType" AS ENUM ('STYLE_EDIT', 'FACTUAL_CORRECTION', 'KNOWLEDGE_ENRICHMENT');

CREATE TABLE "ReplyDraft" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "replyJobId" TEXT NOT NULL,
    "aiDraft" TEXT NOT NULL,
    "humanFinal" TEXT,
    "editType" "ReplyDraftEditType",
    "status" "ReplyDraftStatus" NOT NULL DEFAULT 'WAITING_HUMAN',
    "sourceContextVersion" INTEGER NOT NULL,
    "sourceLastMessageId" TEXT,
    "sourceSequence" INTEGER,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "staleReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplyDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReplyDraft_replyJobId_key" ON "ReplyDraft"("replyJobId");
CREATE INDEX "ReplyDraft_workspaceId_tenantId_shopId_status_expiresAt_idx" ON "ReplyDraft"("workspaceId", "tenantId", "shopId", "status", "expiresAt");

ALTER TABLE "ReplyDraft" ADD CONSTRAINT "ReplyDraft_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyDraft" ADD CONSTRAINT "ReplyDraft_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyDraft" ADD CONSTRAINT "ReplyDraft_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyDraft" ADD CONSTRAINT "ReplyDraft_replyJobId_fkey" FOREIGN KEY ("replyJobId") REFERENCES "ReplyJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
