CREATE TYPE "WorkflowRunStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING_APPROVAL', 'RECOVERING', 'COMPLETED', 'FAILED', 'STALE', 'CANCELLED');
CREATE TYPE "WorkflowNodeRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'WAITING_APPROVAL', 'STALE', 'SKIPPED');
CREATE TYPE "WorkflowProposalStatus" AS ENUM ('WAITING_APPROVAL', 'APPROVED', 'REJECTED', 'STALE', 'EXECUTED');

ALTER TABLE "Task" ADD COLUMN "ownerWorkflowRunId" TEXT;

CREATE TABLE "WorkflowRun" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "workflowVersionId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "taskIdsJson" JSONB NOT NULL,
  "contextVersion" INTEGER NOT NULL,
  "currentNodeId" TEXT,
  "completedNodesJson" JSONB NOT NULL DEFAULT '[]',
  "status" "WorkflowRunStatus" NOT NULL DEFAULT 'PENDING',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WorkflowNodeRun" (
  "id" TEXT NOT NULL, "workflowRunId" TEXT NOT NULL, "nodeId" TEXT NOT NULL,
  "status" "WorkflowNodeRunStatus" NOT NULL DEFAULT 'PENDING', "inputJson" JSONB, "outputJson" JSONB,
  "durationMs" INTEGER, "errorCode" TEXT, "retryCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowNodeRun_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WorkflowProposal" (
  "id" TEXT NOT NULL, "workflowRunId" TEXT NOT NULL, "nodeId" TEXT NOT NULL, "riskLevel" TEXT NOT NULL,
  "payloadJson" JSONB NOT NULL, "contextVersion" INTEGER NOT NULL,
  "status" "WorkflowProposalStatus" NOT NULL DEFAULT 'WAITING_APPROVAL', "receiptJson" JSONB,
  "decidedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowProposal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowNodeRun_workflowRunId_nodeId_key" ON "WorkflowNodeRun"("workflowRunId", "nodeId");
CREATE INDEX "WorkflowRun_workspaceId_tenantId_shopId_conversationId_status_idx" ON "WorkflowRun"("workspaceId", "tenantId", "shopId", "conversationId", "status");
CREATE INDEX "WorkflowRun_workflowVersionId_status_idx" ON "WorkflowRun"("workflowVersionId", "status");
CREATE INDEX "WorkflowProposal_workflowRunId_status_idx" ON "WorkflowProposal"("workflowRunId", "status");
ALTER TABLE "Task" ADD CONSTRAINT "Task_ownerWorkflowRunId_fkey" FOREIGN KEY ("ownerWorkflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkflowNodeRun" ADD CONSTRAINT "WorkflowNodeRun_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowProposal" ADD CONSTRAINT "WorkflowProposal_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
