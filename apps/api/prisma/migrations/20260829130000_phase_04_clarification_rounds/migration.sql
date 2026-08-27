ALTER TABLE "Conversation"
  ADD COLUMN "clarificationRoundsJson" JSONB NOT NULL DEFAULT '{}'::jsonb;
