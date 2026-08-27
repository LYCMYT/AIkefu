-- Run after the Prisma migration.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- If Prisma already created the embedding column, the ALTER may be skipped.
-- Replace 1536 with the selected embedding dimension before production use.
ALTER TABLE "KnowledgeVersion"
  ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

-- Only READY versions should be queried by the application.
CREATE INDEX IF NOT EXISTS knowledge_version_embedding_hnsw
  ON "KnowledgeVersion"
  USING hnsw ("embedding" vector_cosine_ops)
  WHERE "indexStatus" = 'READY';

CREATE INDEX IF NOT EXISTS knowledge_version_question_trgm
  ON "KnowledgeVersion"
  USING gin ("question" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS knowledge_version_answer_trgm
  ON "KnowledgeVersion"
  USING gin ("answer" gin_trgm_ops);

-- V1 keyword/BM25 scoring is intentionally application-side after metadata
-- filtering because the seed corpus is small. This avoids an extra search service.
