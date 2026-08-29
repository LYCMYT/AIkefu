ALTER TABLE "Shop" ADD COLUMN "settingsConfirmedAt" TIMESTAMP(3);

-- Frozen seed fixtures are already reviewed product scenarios. Runtime shops
-- intentionally remain NULL until an operator saves their copied settings.
UPDATE "Shop"
SET "settingsConfirmedAt" = CURRENT_TIMESTAMP
WHERE "seedKey" NOT LIKE 'runtime:%';
