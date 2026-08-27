-- Phase 05 release lifecycle: scheduled retention scans and an explicit
-- anonymization marker for idempotent Delete Customer Data requests.
ALTER TABLE "Buyer" ADD COLUMN "anonymizedAt" TIMESTAMP(3);

CREATE INDEX "Buyer_workspaceId_tenantId_anonymizedAt_idx" ON "Buyer"("workspaceId", "tenantId", "anonymizedAt");
CREATE INDEX "ConversationMemory_updatedAt_idx" ON "ConversationMemory"("updatedAt");
CREATE INDEX "ReorderBufferEntry_createdAt_idx" ON "ReorderBufferEntry"("createdAt");
CREATE INDEX "ProcessingOutbox_createdAt_idx" ON "ProcessingOutbox"("createdAt");
CREATE INDEX "ReplyDraft_createdAt_idx" ON "ReplyDraft"("createdAt");
CREATE INDEX "SendOutbox_createdAt_idx" ON "SendOutbox"("createdAt");
CREATE INDEX "CustomerMemory_status_expiresAt_idx" ON "CustomerMemory"("status", "expiresAt");
CREATE INDEX "QualityReview_createdAt_idx" ON "QualityReview"("createdAt");
CREATE INDEX "ReplyIncident_createdAt_idx" ON "ReplyIncident"("createdAt");
CREATE INDEX "EvalCase_source_createdAt_idx" ON "EvalCase"("source", "createdAt");

CREATE INDEX "Message_sentAt_idx" ON "Message"("sentAt");
CREATE INDEX "MessageVersion_editedAt_idx" ON "MessageVersion"("editedAt");
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");
CREATE INDEX "WorkflowNodeRun_createdAt_idx" ON "WorkflowNodeRun"("createdAt");
CREATE INDEX "WorkflowProposal_createdAt_idx" ON "WorkflowProposal"("createdAt");
CREATE INDEX "TraceEvent_createdAt_idx" ON "TraceEvent"("createdAt");
