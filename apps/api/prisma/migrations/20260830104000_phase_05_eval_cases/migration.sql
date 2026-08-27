CREATE TABLE "EvalCase" ("id" TEXT PRIMARY KEY,"workspaceId" TEXT NOT NULL,"tenantId" TEXT NOT NULL,"shopId" TEXT,"key" TEXT NOT NULL,"source" TEXT NOT NULL,"inputJson" JSONB NOT NULL,"expectedJson" JSONB NOT NULL,"assertionsJson" JSONB NOT NULL,"status" TEXT NOT NULL DEFAULT 'ACTIVE',"createdFromIncidentId" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL);
ALTER TABLE "ReplyIncident" ADD COLUMN "regressionCaseId" TEXT;
CREATE UNIQUE INDEX "EvalCase_workspaceId_tenantId_key_key" ON "EvalCase"("workspaceId","tenantId","key");
CREATE INDEX "EvalCase_workspaceId_tenantId_shopId_source_status_idx" ON "EvalCase"("workspaceId","tenantId","shopId","source","status");
ALTER TABLE "EvalCase" ADD CONSTRAINT "EvalCase_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE;
ALTER TABLE "EvalCase" ADD CONSTRAINT "EvalCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
ALTER TABLE "EvalCase" ADD CONSTRAINT "EvalCase_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL;
ALTER TABLE "ReplyIncident" ADD CONSTRAINT "ReplyIncident_regressionCaseId_fkey" FOREIGN KEY ("regressionCaseId") REFERENCES "EvalCase"("id") ON DELETE SET NULL;
