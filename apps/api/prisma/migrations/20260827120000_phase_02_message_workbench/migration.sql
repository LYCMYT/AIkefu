-- CreateEnum
CREATE TYPE "ConversationSyncState" AS ENUM ('CONNECTED', 'RECONNECTING', 'RECONCILING', 'DEGRADED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ReorderBufferStatus" AS ENUM ('BUFFERED', 'COMMITTED', 'DROPPED');

-- CreateEnum
CREATE TYPE "ProcessingOutboxStatus" AS ENUM ('PENDING', 'DISPATCHING', 'DISPATCHED', 'FAILED');

-- CreateEnum
CREATE TYPE "TurnBufferStatus" AS ENUM ('BUFFERING', 'FLUSHING', 'FLUSHED', 'CANCELLED', 'RECOVERY_PENDING');

-- CreateEnum
CREATE TYPE "UserTurnStatus" AS ENUM ('OPEN', 'PLANNED', 'RESOLVED', 'SUPERSEDED', 'CANCELLED', 'FAILED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "lastMessageAt" TIMESTAMP(3),
ADD COLUMN     "syncState" "ConversationSyncState" NOT NULL DEFAULT 'CONNECTED',
ADD COLUMN     "unreadCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MessageVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "contentJson" JSONB NOT NULL,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReorderBufferEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "firstBufferedAt" TIMESTAMP(3) NOT NULL,
    "reconcileAttempted" BOOLEAN NOT NULL DEFAULT false,
    "status" "ReorderBufferStatus" NOT NULL DEFAULT 'BUFFERED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReorderBufferEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingOutbox" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" "ProcessingOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingReceipt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationTurnBuffer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "idleDeadline" TIMESTAMP(3) NOT NULL,
    "hardDeadline" TIMESTAMP(3) NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "firstSequence" INTEGER NOT NULL,
    "latestSequence" INTEGER NOT NULL,
    "status" "TurnBufferStatus" NOT NULL DEFAULT 'BUFFERING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationTurnBuffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserTurn" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sourceMessageIdsJson" JSONB NOT NULL,
    "firstSequence" INTEGER NOT NULL,
    "lastSequence" INTEGER NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "multimodalSummaryJson" JSONB,
    "status" "UserTurnStatus" NOT NULL DEFAULT 'OPEN',
    "turnKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageVersion_workspaceId_tenantId_messageId_idx" ON "MessageVersion"("workspaceId", "tenantId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageVersion_messageId_version_key" ON "MessageVersion"("messageId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ReorderBufferEntry_eventId_key" ON "ReorderBufferEntry"("eventId");

-- CreateIndex
CREATE INDEX "ReorderBufferEntry_workspaceId_tenantId_conversationId_stat_idx" ON "ReorderBufferEntry"("workspaceId", "tenantId", "conversationId", "status", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ReorderBufferEntry_platform_shopId_externalMessageId_key" ON "ReorderBufferEntry"("platform", "shopId", "externalMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ReorderBufferEntry_conversationId_sequence_key" ON "ReorderBufferEntry"("conversationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingOutbox_eventId_key" ON "ProcessingOutbox"("eventId");

-- CreateIndex
CREATE INDEX "ProcessingOutbox_workspaceId_tenantId_status_availableAt_idx" ON "ProcessingOutbox"("workspaceId", "tenantId", "status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingReceipt_eventId_key" ON "ProcessingReceipt"("eventId");

-- CreateIndex
CREATE INDEX "ProcessingReceipt_workspaceId_tenantId_consumedAt_idx" ON "ProcessingReceipt"("workspaceId", "tenantId", "consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTurnBuffer_conversationId_key" ON "ConversationTurnBuffer"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationTurnBuffer_workspaceId_tenantId_status_idleDead_idx" ON "ConversationTurnBuffer"("workspaceId", "tenantId", "status", "idleDeadline", "hardDeadline");

-- CreateIndex
CREATE UNIQUE INDEX "UserTurn_turnKey_key" ON "UserTurn"("turnKey");

-- CreateIndex
CREATE INDEX "UserTurn_workspaceId_tenantId_conversationId_firstSequence__idx" ON "UserTurn"("workspaceId", "tenantId", "conversationId", "firstSequence", "lastSequence");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_sequence_key" ON "Message"("conversationId", "sequence");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageVersion" ADD CONSTRAINT "MessageVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageVersion" ADD CONSTRAINT "MessageVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageVersion" ADD CONSTRAINT "MessageVersion_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderBufferEntry" ADD CONSTRAINT "ReorderBufferEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderBufferEntry" ADD CONSTRAINT "ReorderBufferEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderBufferEntry" ADD CONSTRAINT "ReorderBufferEntry_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderBufferEntry" ADD CONSTRAINT "ReorderBufferEntry_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingOutbox" ADD CONSTRAINT "ProcessingOutbox_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingOutbox" ADD CONSTRAINT "ProcessingOutbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingOutbox" ADD CONSTRAINT "ProcessingOutbox_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingReceipt" ADD CONSTRAINT "ProcessingReceipt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingReceipt" ADD CONSTRAINT "ProcessingReceipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingReceipt" ADD CONSTRAINT "ProcessingReceipt_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTurnBuffer" ADD CONSTRAINT "ConversationTurnBuffer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTurnBuffer" ADD CONSTRAINT "ConversationTurnBuffer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTurnBuffer" ADD CONSTRAINT "ConversationTurnBuffer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTurnBuffer" ADD CONSTRAINT "ConversationTurnBuffer_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTurn" ADD CONSTRAINT "UserTurn_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTurn" ADD CONSTRAINT "UserTurn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTurn" ADD CONSTRAINT "UserTurn_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTurn" ADD CONSTRAINT "UserTurn_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
