ALTER TABLE "ReplyEvidence" ADD COLUMN "taskKey" TEXT;

CREATE UNIQUE INDEX "ReplyEvidence_replyJobId_taskKey_knowledgeVersionId_key"
ON "ReplyEvidence"("replyJobId", "taskKey", "knowledgeVersionId");
