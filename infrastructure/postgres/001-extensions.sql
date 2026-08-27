-- Phase 01 only enables extensions. Phase 03 owns vector/trigram indexes after
-- the knowledge migration has introduced its retrieval columns.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
