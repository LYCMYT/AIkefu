CREATE TYPE "CustomerMemoryType" AS ENUM ('PREFERENCE', 'PRODUCT_PREFERENCE', 'ONGOING_CASE');
CREATE TYPE "CustomerMemoryStatus" AS ENUM ('ACTIVE', 'DISABLED', 'DELETED');

CREATE TABLE "CustomerMemory" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "type" "CustomerMemoryType" NOT NULL,
    "key" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL,
    "status" "CustomerMemoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerMemory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerMemory_workspaceId_tenantId_shopId_buyerId_status_idx" ON "CustomerMemory"("workspaceId", "tenantId", "shopId", "buyerId", "status");
ALTER TABLE "CustomerMemory" ADD CONSTRAINT "CustomerMemory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemory" ADD CONSTRAINT "CustomerMemory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemory" ADD CONSTRAINT "CustomerMemory_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerMemory" ADD CONSTRAINT "CustomerMemory_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
