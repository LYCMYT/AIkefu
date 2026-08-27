ALTER TABLE "ReplyIncident" ADD COLUMN "correctionSendOutboxId" TEXT;
CREATE UNIQUE INDEX "ReplyIncident_correctionSendOutboxId_key" ON "ReplyIncident"("correctionSendOutboxId");
ALTER TABLE "ReplyIncident" ADD CONSTRAINT "ReplyIncident_correctionSendOutboxId_fkey"
  FOREIGN KEY ("correctionSendOutboxId") REFERENCES "SendOutbox"("id") ON DELETE SET NULL;
