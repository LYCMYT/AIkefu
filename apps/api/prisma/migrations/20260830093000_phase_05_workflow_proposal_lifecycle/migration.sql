-- Durable, scoped ActionProposal lifecycle for the finite workflow engine.
ALTER TYPE "WorkflowProposalStatus" RENAME TO "WorkflowProposalStatus_old";
CREATE TYPE "WorkflowProposalStatus" AS ENUM (
  'PROPOSED', 'POLICY_CHECKED', 'WAITING_APPROVAL', 'APPROVED',
  'REVALIDATING', 'EXECUTING', 'SUCCEEDED', 'REJECTED', 'STALE',
  'FAILED', 'UNCERTAIN', 'CANCELLED'
);
ALTER TABLE "WorkflowProposal" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "WorkflowProposal"
  ALTER COLUMN "status" TYPE "WorkflowProposalStatus"
  USING (CASE "status"::text WHEN 'EXECUTED' THEN 'SUCCEEDED' ELSE "status"::text END)::"WorkflowProposalStatus";
DROP TYPE "WorkflowProposalStatus_old";
ALTER TABLE "WorkflowProposal" ALTER COLUMN "status" SET DEFAULT 'WAITING_APPROVAL';

ALTER TABLE "WorkflowProposal"
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "tenantId" TEXT,
  ADD COLUMN "shopId" TEXT,
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "type" TEXT NOT NULL DEFAULT 'PROPOSE_COMPENSATION',
  ADD COLUMN "targetEntityType" TEXT NOT NULL DEFAULT 'WORKFLOW_RUN',
  ADD COLUMN "targetEntityId" TEXT,
  ADD COLUMN "evidenceIdsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "approvedBy" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedReason" TEXT,
  ADD COLUMN "executionJson" JSONB,
  ADD COLUMN "executedAt" TIMESTAMP(3),
  ADD COLUMN "failureCode" TEXT;

UPDATE "WorkflowProposal" proposal
SET
  "workspaceId" = run."workspaceId",
  "tenantId" = run."tenantId",
  "shopId" = run."shopId",
  "conversationId" = run."conversationId",
  "targetEntityId" = run."conversationId"
FROM "WorkflowRun" run
WHERE proposal."workflowRunId" = run."id";

ALTER TABLE "WorkflowProposal"
  ALTER COLUMN "workspaceId" SET NOT NULL,
  ALTER COLUMN "tenantId" SET NOT NULL,
  ALTER COLUMN "shopId" SET NOT NULL,
  ALTER COLUMN "conversationId" SET NOT NULL,
  ALTER COLUMN "targetEntityId" SET NOT NULL;
ALTER TABLE "WorkflowProposal" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "WorkflowProposal" ALTER COLUMN "targetEntityType" DROP DEFAULT;

ALTER TABLE "WorkflowProposal"
  ADD CONSTRAINT "WorkflowProposal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "WorkflowProposal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "WorkflowProposal_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "WorkflowProposal_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "WorkflowProposal_workspaceId_tenantId_shopId_conversationId_status_idx"
  ON "WorkflowProposal"("workspaceId", "tenantId", "shopId", "conversationId", "status");
