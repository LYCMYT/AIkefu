ALTER TABLE "ReplyIncident" ADD CONSTRAINT "ReplyIncident_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE;
ALTER TABLE "ReplyIncident" ADD CONSTRAINT "ReplyIncident_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
ALTER TABLE "ReplyIncident" ADD CONSTRAINT "ReplyIncident_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE;
ALTER TABLE "ReplyIncident" ADD CONSTRAINT "ReplyIncident_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE;
ALTER TABLE "TraceEvent" ADD CONSTRAINT "TraceEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE;
ALTER TABLE "TraceEvent" ADD CONSTRAINT "TraceEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
ALTER TABLE "TraceEvent" ADD CONSTRAINT "TraceEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL;
ALTER TABLE "TraceEvent" ADD CONSTRAINT "TraceEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL;
