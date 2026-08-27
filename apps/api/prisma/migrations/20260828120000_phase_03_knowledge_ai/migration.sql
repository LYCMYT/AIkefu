-- Hybrid RAG requires a database-owned pgvector column. This migration owns
-- the extension rather than letting application code silently fall back to an
-- unscoped store.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "KnowledgeImportStatus" AS ENUM ('PREVIEWED', 'COMMITTING', 'COMMITTED', 'FAILED');

-- CreateEnum
CREATE TYPE "KnowledgeImportRowStatus" AS ENUM ('VALID', 'DUPLICATE', 'CONFLICT', 'ERROR', 'COMMITTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "KnowledgeCandidateStatus" AS ENUM ('PENDING', 'APPROVED', 'PUBLISHED', 'REJECTED', 'DUPLICATE', 'CONFLICTED');

-- CreateEnum
CREATE TYPE "KnowledgeConflictStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "ProductLearningJobStatus" AS ENUM ('PENDING', 'RUNNING', 'PARTIAL_SUCCESS', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProductLearningItemStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'OUTDATED');

-- CreateEnum
CREATE TYPE "ConversationSummaryStatus" AS ENUM ('CLEAN', 'DIRTY');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'DELETED');

-- CreateEnum
CREATE TYPE "AIInvocationStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'ABORTED');

-- AlterTable
ALTER TABLE "KnowledgeItem" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "KnowledgeVersion" ADD COLUMN "contentHash" TEXT,
ADD COLUMN "indexedAt" TIMESTAMP(3),
ADD COLUMN "indexError" TEXT,
ADD COLUMN "embedding" vector(1536);

-- Vector similarity is only eligible for a fully indexed, still-effective
-- version. `effectiveFrom <= now()` remains a scoped runtime predicate because
-- PostgreSQL index predicates cannot use a non-immutable clock function.
CREATE INDEX "KnowledgeVersion_embedding_hnsw_ready_idx"
  ON "KnowledgeVersion" USING hnsw ("embedding" vector_cosine_ops)
  WHERE "indexStatus" = 'READY' AND "effectiveTo" IS NULL;
CREATE INDEX "KnowledgeVersion_question_trgm_idx"
  ON "KnowledgeVersion" USING gin ("question" gin_trgm_ops);
CREATE INDEX "KnowledgeVersion_answer_trgm_idx"
  ON "KnowledgeVersion" USING gin ("answer" gin_trgm_ops);

-- CreateTable
CREATE TABLE "KnowledgeImport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "csvHash" TEXT NOT NULL,
    "sourceName" TEXT,
    "status" "KnowledgeImportStatus" NOT NULL DEFAULT 'PREVIEWED',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "conflictRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeImportRow" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "scope" "KnowledgeScope" NOT NULL,
    "productId" TEXT,
    "productExternalId" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "fingerprint" TEXT,
    "status" "KnowledgeImportRowStatus" NOT NULL,
    "reason" TEXT,
    "committedKnowledgeItemId" TEXT,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeCandidate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT,
    "source" TEXT NOT NULL,
    "proposedQuestion" TEXT NOT NULL,
    "proposedAnswer" TEXT NOT NULL,
    "status" "KnowledgeCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "duplicateOfId" TEXT,
    "conflictWithId" TEXT,
    "sourceConversationId" TEXT,
    "sourceReplyJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeConflict" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "leftItemId" TEXT NOT NULL,
    "rightItemId" TEXT NOT NULL,
    "leftVersionId" TEXT NOT NULL,
    "rightVersionId" TEXT NOT NULL,
    "status" "KnowledgeConflictStatus" NOT NULL DEFAULT 'OPEN',
    "resolutionJson" JSONB,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeConflict_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "KnowledgeConflict_distinct_sides_check" CHECK ("leftItemId" <> "rightItemId" AND "leftVersionId" <> "rightVersionId")
);

-- CreateTable
CREATE TABLE "ProductLearningJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "status" "ProductLearningJobStatus" NOT NULL DEFAULT 'PENDING',
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "createdProducts" INTEGER NOT NULL DEFAULT 0,
    "updatedProducts" INTEGER NOT NULL DEFAULT 0,
    "skippedProducts" INTEGER NOT NULL DEFAULT 0,
    "failedProducts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductLearningJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductLearningJobItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "ProductLearningItemStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductLearningJobItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMemory" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "narrative" TEXT NOT NULL DEFAULT '',
    "structuredFactsJson" JSONB NOT NULL,
    "summaryVersion" INTEGER NOT NULL DEFAULT 0,
    "basedOnThroughSequence" INTEGER NOT NULL DEFAULT 0,
    "status" "ConversationSummaryStatus" NOT NULL DEFAULT 'CLEAN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT,
    "buyerId" TEXT,
    "conversationId" TEXT,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "containsPII" BOOLEAN NOT NULL DEFAULT false,
    "analysisJson" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '15 days'),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIInvocation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT,
    "conversationId" TEXT,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "ragStrategy" TEXT,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "contextVersion" INTEGER,
    "evidenceIdsJson" JSONB NOT NULL,
    "durationMs" INTEGER,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "status" "AIInvocationStatus" NOT NULL DEFAULT 'PENDING',
    "includedDataClassesJson" JSONB NOT NULL,
    "excludedPIIJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIInvocationEvidence" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT,
    "invocationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" "KnowledgeSourceType" NOT NULL,
    "scope" "KnowledgeScope" NOT NULL,
    "productId" TEXT,
    "contentSnapshotJson" JSONB NOT NULL,
    "retrievalScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIInvocationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIUsage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT,
    "conversationId" TEXT,
    "invocationId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeImport_workspaceId_tenantId_shopId_csvHash_key" ON "KnowledgeImport"("workspaceId", "tenantId", "shopId", "csvHash");
CREATE INDEX "KnowledgeImport_workspaceId_tenantId_shopId_status_idx" ON "KnowledgeImport"("workspaceId", "tenantId", "shopId", "status");
CREATE UNIQUE INDEX "KnowledgeImportRow_importId_rowNumber_key" ON "KnowledgeImportRow"("importId", "rowNumber");
CREATE INDEX "KnowledgeImportRow_workspaceId_tenantId_shopId_status_idx" ON "KnowledgeImportRow"("workspaceId", "tenantId", "shopId", "status");
CREATE INDEX "KnowledgeImportRow_workspaceId_tenantId_shopId_productId_fingerprint_idx" ON "KnowledgeImportRow"("workspaceId", "tenantId", "shopId", "productId", "fingerprint");
CREATE INDEX "KnowledgeCandidate_workspaceId_tenantId_shopId_status_idx" ON "KnowledgeCandidate"("workspaceId", "tenantId", "shopId", "status");
CREATE INDEX "KnowledgeCandidate_workspaceId_tenantId_shopId_productId_idx" ON "KnowledgeCandidate"("workspaceId", "tenantId", "shopId", "productId");
CREATE UNIQUE INDEX "KnowledgeConflict_workspaceId_tenantId_shopId_leftItemId_rightItemId_leftVersionId_rightVersionId_key" ON "KnowledgeConflict"("workspaceId", "tenantId", "shopId", "leftItemId", "rightItemId", "leftVersionId", "rightVersionId");
CREATE INDEX "KnowledgeConflict_workspaceId_tenantId_shopId_status_idx" ON "KnowledgeConflict"("workspaceId", "tenantId", "shopId", "status");
CREATE UNIQUE INDEX "ProductLearningJob_workspaceId_tenantId_shopId_sourceFingerprint_key" ON "ProductLearningJob"("workspaceId", "tenantId", "shopId", "sourceFingerprint");
CREATE INDEX "ProductLearningJob_workspaceId_tenantId_shopId_status_idx" ON "ProductLearningJob"("workspaceId", "tenantId", "shopId", "status");
CREATE UNIQUE INDEX "ProductLearningJobItem_jobId_productId_key" ON "ProductLearningJobItem"("jobId", "productId");
CREATE INDEX "ProductLearningJobItem_workspaceId_tenantId_shopId_productId_status_idx" ON "ProductLearningJobItem"("workspaceId", "tenantId", "shopId", "productId", "status");
CREATE UNIQUE INDEX "ConversationMemory_conversationId_key" ON "ConversationMemory"("conversationId");
CREATE INDEX "ConversationMemory_workspaceId_tenantId_shopId_status_idx" ON "ConversationMemory"("workspaceId", "tenantId", "shopId", "status");
CREATE UNIQUE INDEX "Attachment_workspaceId_tenantId_objectKey_key" ON "Attachment"("workspaceId", "tenantId", "objectKey");
CREATE INDEX "Attachment_workspaceId_tenantId_shopId_status_expiresAt_idx" ON "Attachment"("workspaceId", "tenantId", "shopId", "status", "expiresAt");
CREATE INDEX "Attachment_workspaceId_tenantId_conversationId_idx" ON "Attachment"("workspaceId", "tenantId", "conversationId");
CREATE INDEX "AIInvocation_workspaceId_tenantId_shopId_createdAt_idx" ON "AIInvocation"("workspaceId", "tenantId", "shopId", "createdAt");
CREATE INDEX "AIInvocation_workspaceId_tenantId_conversationId_createdAt_idx" ON "AIInvocation"("workspaceId", "tenantId", "conversationId", "createdAt");
CREATE INDEX "AIInvocation_purpose_provider_model_idx" ON "AIInvocation"("purpose", "provider", "model");
CREATE UNIQUE INDEX "AIInvocationEvidence_invocationId_itemId_versionId_key" ON "AIInvocationEvidence"("invocationId", "itemId", "versionId");
CREATE INDEX "AIInvocationEvidence_workspaceId_tenantId_shopId_invocationId_idx" ON "AIInvocationEvidence"("workspaceId", "tenantId", "shopId", "invocationId");
CREATE UNIQUE INDEX "AIUsage_invocationId_key" ON "AIUsage"("invocationId");
CREATE INDEX "AIUsage_workspaceId_tenantId_shopId_createdAt_idx" ON "AIUsage"("workspaceId", "tenantId", "shopId", "createdAt");
CREATE INDEX "AIUsage_purpose_provider_model_createdAt_idx" ON "AIUsage"("purpose", "provider", "model", "createdAt");

-- Keep product knowledge structurally constrained; it can never be detached
-- from its product, and store knowledge cannot accidentally inherit a product.
ALTER TABLE "KnowledgeItem" ADD CONSTRAINT "KnowledgeItem_scope_product_check"
CHECK (("scope" = 'PRODUCT' AND "productId" IS NOT NULL) OR ("scope" = 'STORE' AND "productId" IS NULL));
ALTER TABLE "KnowledgeImportRow" ADD CONSTRAINT "KnowledgeImportRow_scope_product_check"
CHECK (("scope" = 'PRODUCT' AND "productId" IS NOT NULL) OR ("scope" = 'STORE' AND "productId" IS NULL));

-- AddForeignKey
ALTER TABLE "KnowledgeImport" ADD CONSTRAINT "KnowledgeImport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeImport" ADD CONSTRAINT "KnowledgeImport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeImport" ADD CONSTRAINT "KnowledgeImport_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeImportRow" ADD CONSTRAINT "KnowledgeImportRow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeImportRow" ADD CONSTRAINT "KnowledgeImportRow_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeImportRow" ADD CONSTRAINT "KnowledgeImportRow_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeImportRow" ADD CONSTRAINT "KnowledgeImportRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "KnowledgeImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeImportRow" ADD CONSTRAINT "KnowledgeImportRow_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeImportRow" ADD CONSTRAINT "KnowledgeImportRow_committedKnowledgeItemId_fkey" FOREIGN KEY ("committedKnowledgeItemId") REFERENCES "KnowledgeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeCandidate" ADD CONSTRAINT "KnowledgeCandidate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeCandidate" ADD CONSTRAINT "KnowledgeCandidate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeCandidate" ADD CONSTRAINT "KnowledgeCandidate_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeCandidate" ADD CONSTRAINT "KnowledgeCandidate_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeCandidate" ADD CONSTRAINT "KnowledgeCandidate_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "KnowledgeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeCandidate" ADD CONSTRAINT "KnowledgeCandidate_conflictWithId_fkey" FOREIGN KEY ("conflictWithId") REFERENCES "KnowledgeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeConflict" ADD CONSTRAINT "KnowledgeConflict_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeConflict" ADD CONSTRAINT "KnowledgeConflict_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeConflict" ADD CONSTRAINT "KnowledgeConflict_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeConflict" ADD CONSTRAINT "KnowledgeConflict_leftItemId_fkey" FOREIGN KEY ("leftItemId") REFERENCES "KnowledgeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeConflict" ADD CONSTRAINT "KnowledgeConflict_rightItemId_fkey" FOREIGN KEY ("rightItemId") REFERENCES "KnowledgeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeConflict" ADD CONSTRAINT "KnowledgeConflict_leftVersionId_fkey" FOREIGN KEY ("leftVersionId") REFERENCES "KnowledgeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeConflict" ADD CONSTRAINT "KnowledgeConflict_rightVersionId_fkey" FOREIGN KEY ("rightVersionId") REFERENCES "KnowledgeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductLearningJob" ADD CONSTRAINT "ProductLearningJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductLearningJob" ADD CONSTRAINT "ProductLearningJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductLearningJob" ADD CONSTRAINT "ProductLearningJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductLearningJobItem" ADD CONSTRAINT "ProductLearningJobItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductLearningJobItem" ADD CONSTRAINT "ProductLearningJobItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductLearningJobItem" ADD CONSTRAINT "ProductLearningJobItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductLearningJobItem" ADD CONSTRAINT "ProductLearningJobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProductLearningJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductLearningJobItem" ADD CONSTRAINT "ProductLearningJobItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMemory" ADD CONSTRAINT "ConversationMemory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMemory" ADD CONSTRAINT "ConversationMemory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMemory" ADD CONSTRAINT "ConversationMemory_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMemory" ADD CONSTRAINT "ConversationMemory_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AIInvocation" ADD CONSTRAINT "AIInvocation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIInvocation" ADD CONSTRAINT "AIInvocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIInvocation" ADD CONSTRAINT "AIInvocation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AIInvocation" ADD CONSTRAINT "AIInvocation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AIInvocationEvidence" ADD CONSTRAINT "AIInvocationEvidence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIInvocationEvidence" ADD CONSTRAINT "AIInvocationEvidence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIInvocationEvidence" ADD CONSTRAINT "AIInvocationEvidence_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AIInvocationEvidence" ADD CONSTRAINT "AIInvocationEvidence_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "AIInvocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "AIInvocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
