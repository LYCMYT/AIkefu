export type KnowledgeScope = 'STORE' | 'PRODUCT';
export type KnowledgeSourceType = 'MANUAL' | 'HUMAN_REVIEWED' | 'AUTO_LEARNED';
export type KnowledgeBusinessStatus = 'DRAFT' | 'ENABLED' | 'DISABLED' | 'OUTDATED' | 'CONFLICTED' | 'DELETED';
export type KnowledgeIndexStatus = 'PENDING' | 'INDEXING' | 'READY' | 'FAILED';
export type RagFactClass = 'KNOWLEDGE' | 'INVENTORY' | 'ORDER' | 'LOGISTICS' | 'AFTER_SALES';

export type KnowledgeDocument = {
  itemId: string;
  versionId: string;
  version: number;
  workspaceId: string;
  tenantId: string;
  shopId: string;
  productId: string | null;
  scope: KnowledgeScope;
  sourceType: KnowledgeSourceType;
  businessStatus: KnowledgeBusinessStatus;
  indexStatus: KnowledgeIndexStatus;
  question: string;
  answer: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  vector?: readonly number[];
};

export type HybridRagQuery = {
  workspaceId: string;
  tenantId: string;
  shopId: string;
  productId?: string;
  query: string;
  queryVector?: readonly number[];
  factClass?: RagFactClass;
  now?: Date;
  topK?: number;
};

export type EvidenceSnapshot = Readonly<{
  itemId: string;
  versionId: string;
  version: number;
  source: KnowledgeSourceType;
  scope: KnowledgeScope;
  productId: string | null;
  contentSnapshot: Readonly<{ question: string; answer: string }>;
  retrievalScore: number;
}>;

export type HybridRagResult =
  | { status: 'EVIDENCE'; evidence: EvidenceSnapshot[]; conflictItemIds: string[] }
  | { status: 'NO_EVIDENCE'; evidence: []; conflictItemIds: string[] }
  | { status: 'CONFLICTED'; evidence: []; conflictItemIds: string[] }
  | { status: 'DYNAMIC_FACT_REQUIRED'; evidence: []; conflictItemIds: [] };

type Scored = { document: KnowledgeDocument; score: number };

const SOURCE_WEIGHT: Record<KnowledgeSourceType, number> = {
  MANUAL: 0.3,
  HUMAN_REVIEWED: 0.2,
  AUTO_LEARNED: 0.1,
};

export function retrieveHybridKnowledge(
  documents: readonly KnowledgeDocument[],
  query: HybridRagQuery,
): HybridRagResult {
  if (query.factClass && query.factClass !== 'KNOWLEDGE' && query.factClass !== 'AFTER_SALES') {
    return { status: 'DYNAMIC_FACT_REQUIRED', evidence: [], conflictItemIds: [] };
  }
  const now = query.now ?? new Date();
  const metadataCandidates = documents.filter((document) => metadataMatches(document, query, now));
  const conflictItemIds = metadataCandidates
    .filter((document) => document.businessStatus === 'CONFLICTED' && lexicalScore(query.query, document) > 0)
    .map((document) => document.itemId)
    .sort();
  if (conflictItemIds.length > 0) return { status: 'CONFLICTED', evidence: [], conflictItemIds };

  const eligible = metadataCandidates.filter(
    (document) => document.businessStatus === 'ENABLED' && document.indexStatus === 'READY',
  );
  const scored = eligible
    .map((document, stableIndex): Scored & { stableIndex: number } => ({
      document,
      stableIndex,
      score:
        lexicalScore(query.query, document) * 0.45 +
        vectorScore(query.queryVector, document.vector) * 0.35 +
        SOURCE_WEIGHT[document.sourceType] +
        (document.scope === 'PRODUCT' ? 0.2 : 0.05),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.stableIndex - right.stableIndex);

  const topK = Math.max(1, Math.min(query.topK ?? 3, 3));
  const evidence = scored.slice(0, topK).map(({ document, score }): EvidenceSnapshot =>
    Object.freeze({
      itemId: document.itemId,
      versionId: document.versionId,
      version: document.version,
      source: document.sourceType,
      scope: document.scope,
      productId: document.productId,
      contentSnapshot: Object.freeze({ question: document.question, answer: document.answer }),
      retrievalScore: Number(score.toFixed(6)),
    }),
  );
  return evidence.length > 0
    ? { status: 'EVIDENCE', evidence, conflictItemIds: [] }
    : { status: 'NO_EVIDENCE', evidence: [], conflictItemIds: [] };
}

function metadataMatches(document: KnowledgeDocument, query: HybridRagQuery, now: Date): boolean {
  if (
    document.workspaceId !== query.workspaceId ||
    document.tenantId !== query.tenantId ||
    document.shopId !== query.shopId
  ) {
    return false;
  }
  if (document.scope === 'PRODUCT' && (!query.productId || document.productId !== query.productId)) return false;
  const from = Date.parse(document.effectiveFrom);
  const to = document.effectiveTo ? Date.parse(document.effectiveTo) : Number.POSITIVE_INFINITY;
  return Number.isFinite(from) && from <= now.getTime() && now.getTime() < to;
}

function lexicalScore(query: string, document: KnowledgeDocument): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const documentTokens = tokenize(`${document.question} ${document.answer}`);
  const frequencies = new Map<string, number>();
  for (const token of documentTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const frequency = frequencies.get(token) ?? 0;
    if (frequency > 0) score += frequency / (frequency + 1.2);
  }
  return score / new Set(queryTokens).size;
}

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase().normalize('NFKC');
  const ascii = normalized.match(/[a-z0-9]+/g) ?? [];
  const chinese = normalized.match(/[\p{Script=Han}]/gu) ?? [];
  return [...ascii, ...chinese];
}

function vectorScore(queryVector?: readonly number[], documentVector?: readonly number[]): number {
  if (!queryVector || !documentVector || queryVector.length === 0 || queryVector.length !== documentVector.length) return 0;
  let dot = 0;
  let queryNorm = 0;
  let documentNorm = 0;
  for (let index = 0; index < queryVector.length; index += 1) {
    const left = queryVector[index] ?? 0;
    const right = documentVector[index] ?? 0;
    dot += left * right;
    queryNorm += left * left;
    documentNorm += right * right;
  }
  if (queryNorm === 0 || documentNorm === 0) return 0;
  return Math.max(0, dot / Math.sqrt(queryNorm * documentNorm));
}
