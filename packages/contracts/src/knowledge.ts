export type KnowledgeScope = 'STORE' | 'PRODUCT';
export type KnowledgeSourceType = 'MANUAL' | 'HUMAN_REVIEWED' | 'AUTO_LEARNED';
export type KnowledgeBusinessStatus = 'DRAFT' | 'ENABLED' | 'DISABLED' | 'OUTDATED' | 'CONFLICTED' | 'DELETED';
export type KnowledgeIndexStatus = 'PENDING' | 'INDEXING' | 'READY' | 'FAILED';

export type KnowledgeVersion = {
  id: string;
  version: number;
  question: string;
  answer: string;
  sourceText: string | null;
  sourceVersion: string | null;
  confidence: number | null;
  indexStatus: KnowledgeIndexStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type KnowledgeItem = {
  id: string;
  workspaceId: string;
  tenantId: string;
  shopId: string;
  productId: string | null;
  scope: KnowledgeScope;
  sourceType: KnowledgeSourceType;
  businessStatus: KnowledgeBusinessStatus;
  activeVersionId: string | null;
  activeVersion: KnowledgeVersion | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeImportRowResult = 'VALID' | 'DUPLICATE' | 'CONFLICT' | 'ERROR' | 'COMMITTED' | 'SKIPPED';
export type KnowledgeImportRow = {
  rowNumber: number;
  scope: KnowledgeScope;
  productId: string | null;
  productExternalId: string | null;
  question: string;
  answer: string;
  status: KnowledgeImportRowResult;
  reason: string | null;
  committedKnowledgeItemId: string | null;
};

export type KnowledgeImportJob = {
  id: string;
  shopId: string;
  status: 'PREVIEWED' | 'COMMITTING' | 'COMMITTED' | 'FAILED';
  totals: {
    total: number;
    valid: number;
    duplicate: number;
    conflict: number;
    error: number;
  };
  committedAt: string | null;
  rows: KnowledgeImportRow[];
};

export type ProductLearningStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'OUTDATED';
export type ProductLearningJobStatus = 'PENDING' | 'RUNNING' | 'PARTIAL_SUCCESS' | 'SUCCEEDED' | 'FAILED';

export type ProductLearningJobItem = {
  productId: string;
  status: ProductLearningStatus;
  reason: string | null;
};

export type ProductLearningJobTotals = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
};

export type ProductLearningJob = {
  id: string;
  shopId: string;
  status: ProductLearningJobStatus;
  totals: ProductLearningJobTotals;
  items: ProductLearningJobItem[];
};

/** Compatibility name for clients that previously rendered a progress DTO. */
export type ProductLearningProgress = ProductLearningJob;

export type ReplyEvidenceSnapshot = {
  itemId: string;
  versionId: string;
  version: number;
  source: KnowledgeSourceType;
  scope: KnowledgeScope;
  productId: string | null;
  contentSnapshot: { question: string; answer: string };
  retrievalScore: number;
};

export type KnowledgeRetrievalResult =
  | { status: 'EVIDENCE'; evidence: ReplyEvidenceSnapshot[]; conflictItemIds: string[] }
  | { status: 'NO_EVIDENCE' | 'AMBIGUOUS' | 'CONFLICTED'; evidence: []; conflictItemIds: string[] }
  | { status: 'DYNAMIC_FACT_REQUIRED'; evidence: []; conflictItemIds: [] };
