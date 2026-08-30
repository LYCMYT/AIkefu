ALTER TABLE "SendOutbox"
  ADD COLUMN "projectedAt" TIMESTAMP(3),
  ADD COLUMN "projectionFailureCode" TEXT;

-- Existing SENT rows are marked only when the durable buyer-visible Message
-- already exists. Interrupted receipts deliberately remain NULL so recovery
-- can project them after this migration.
UPDATE "SendOutbox" AS outbox
SET "projectedAt" = COALESCE(message."receivedAt", outbox."updatedAt")
FROM "Message" AS message
WHERE outbox."status" = 'SENT'
  AND outbox."receiptJson" IS NOT NULL
  AND message."shopId" = outbox."shopId"
  AND message."externalMessageId" = outbox."receiptJson" ->> 'externalMessageId';

CREATE INDEX "SendOutbox_status_projectedAt_projectionFailureCode_updatedAt_idx"
  ON "SendOutbox"("status", "projectedAt", "projectionFailureCode", "updatedAt");
