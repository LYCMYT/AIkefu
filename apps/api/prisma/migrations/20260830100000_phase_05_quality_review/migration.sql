CREATE TYPE "QualityReviewStatus" AS ENUM ('PENDING', 'RUNNING', 'AUTO_REVIEWED', 'PASS', 'FAIL', 'NEEDS_HUMAN');

CREATE TABLE "QualityReview" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "replySnapshotJson" JSONB NOT NULL,
  "evidenceSnapshotJson" JSONB NOT NULL,
  "deterministicResultJson" JSONB,
  "judgeResultJson" JSONB,
  "humanResult" TEXT,
  "metricsJson" JSONB,
  "sampleSize" INTEGER NOT NULL DEFAULT 1,
  "status" "QualityReviewStatus" NOT NULL DEFAULT 'PENDING',
  "createdBy" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QualityReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QualityReview_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE,
  CONSTRAINT "QualityReview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "QualityReview_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE,
  CONSTRAINT "QualityReview_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE
);
CREATE INDEX "QualityReview_workspaceId_tenantId_shopId_conversationId_createdAt_idx" ON "QualityReview"("workspaceId", "tenantId", "shopId", "conversationId", "createdAt");
