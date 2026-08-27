-- Phase 04 reply planning persists its own durable work. The task and reply
-- records are scoped at every level so a reply/evidence lookup can never use
-- an unqualified conversation or knowledge id.

CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'RUNNING', 'RESOLVED', 'AMBIGUOUS', 'FAILED', 'SUPERSEDED', 'CANCELLED');
CREATE TYPE "TaskOperation" AS ENUM ('READ', 'WRITE');
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "ReplyJobStatus" AS ENUM ('PENDING', 'FAST_PATH_READY', 'GENERATING', 'WAITING_HUMAN', 'SENT', 'CANCELLING', 'STALE', 'EXPIRED', 'CANCELLED', 'FAILED', 'RECOVERY_PENDING');

CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userTurnId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "operation" "TaskOperation" NOT NULL DEFAULT 'READ',
    "riskLevel" "RiskLevel" NOT NULL,
    "requiredContextJson" JSONB NOT NULL,
    "requiredKnowledgeJson" JSONB NOT NULL,
    "requiredToolsJson" JSONB NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "resultJson" JSONB,
    "errorCode" TEXT,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReplyJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userTurnId" TEXT NOT NULL,
    "status" "ReplyJobStatus" NOT NULL DEFAULT 'PENDING',
    "mode" "ConversationMode" NOT NULL,
    "sourceLastMessageId" TEXT,
    "sourceSequence" INTEGER NOT NULL,
    "sourceContextVersion" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "staleReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplyJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReplyEvidence" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "replyJobId" TEXT NOT NULL,
    "knowledgeItemId" TEXT NOT NULL,
    "knowledgeVersionId" TEXT NOT NULL,
    "knowledgeVersionNumber" INTEGER NOT NULL,
    "sourceType" "KnowledgeSourceType" NOT NULL,
    "scope" "KnowledgeScope" NOT NULL,
    "productId" TEXT,
    "retrievedContentSnapshotJson" JSONB NOT NULL,
    "retrievalScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplyEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReplyJob_idempotencyKey_key" ON "ReplyJob"("idempotencyKey");
CREATE INDEX "Task_workspaceId_tenantId_shopId_conversationId_status_idx" ON "Task"("workspaceId", "tenantId", "shopId", "conversationId", "status");
CREATE INDEX "Task_workspaceId_tenantId_shopId_userTurnId_status_idx" ON "Task"("workspaceId", "tenantId", "shopId", "userTurnId", "status");
CREATE INDEX "ReplyJob_workspaceId_tenantId_shopId_conversationId_status_idx" ON "ReplyJob"("workspaceId", "tenantId", "shopId", "conversationId", "status");
CREATE INDEX "ReplyJob_workspaceId_tenantId_shopId_userTurnId_status_idx" ON "ReplyJob"("workspaceId", "tenantId", "shopId", "userTurnId", "status");
CREATE INDEX "ReplyEvidence_workspaceId_tenantId_shopId_replyJobId_idx" ON "ReplyEvidence"("workspaceId", "tenantId", "shopId", "replyJobId");
CREATE INDEX "ReplyEvidence_knowledgeItemId_knowledgeVersionId_idx" ON "ReplyEvidence"("knowledgeItemId", "knowledgeVersionId");

-- The service stales the previous active job before inserting a new one. This
-- database invariant closes races between independent workers as well.
CREATE UNIQUE INDEX "ReplyJob_one_active_per_conversation"
  ON "ReplyJob"("workspaceId", "tenantId", "shopId", "conversationId")
  WHERE "status" IN ('PENDING', 'FAST_PATH_READY', 'GENERATING', 'WAITING_HUMAN', 'CANCELLING', 'RECOVERY_PENDING');

ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_userTurnId_fkey" FOREIGN KEY ("userTurnId") REFERENCES "UserTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReplyJob" ADD CONSTRAINT "ReplyJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyJob" ADD CONSTRAINT "ReplyJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyJob" ADD CONSTRAINT "ReplyJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyJob" ADD CONSTRAINT "ReplyJob_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyJob" ADD CONSTRAINT "ReplyJob_userTurnId_fkey" FOREIGN KEY ("userTurnId") REFERENCES "UserTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReplyEvidence" ADD CONSTRAINT "ReplyEvidence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyEvidence" ADD CONSTRAINT "ReplyEvidence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyEvidence" ADD CONSTRAINT "ReplyEvidence_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReplyEvidence" ADD CONSTRAINT "ReplyEvidence_replyJobId_fkey" FOREIGN KEY ("replyJobId") REFERENCES "ReplyJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
