-- A durable upload intent closes the storage-write/metadata-write crash gap.
-- Existing rows remain ACTIVE; new uploads are explicitly created PENDING.
ALTER TYPE "AttachmentStatus" ADD VALUE IF NOT EXISTS 'PENDING';
