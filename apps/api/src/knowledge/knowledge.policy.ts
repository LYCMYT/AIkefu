import { cosineSimilarity, deterministicKnowledgeEmbedding } from './knowledge.vector';

export type KnowledgeScopeValue = 'STORE' | 'PRODUCT';
export type KnowledgeBusinessStatusValue = 'ENABLED' | 'CONFLICTED' | 'DISABLED' | 'DELETED' | 'OUTDATED' | 'DRAFT';
export type KnowledgeIndexStatusValue = 'READY' | 'INDEXING' | 'PENDING' | 'FAILED';
export type KnowledgeSourceTypeValue = 'MANUAL' | 'HUMAN_REVIEWED' | 'AUTO_LEARNED';

export type ParsedKnowledgeCsvRow = {
  rowNumber: number;
  scope: KnowledgeScopeValue;
  productExternalId: string | null;
  question: string;
  answer: string;
  parseError?: string;
};

export type ParsedKnowledgeCsv = {
  headers: string[];
  rows: ParsedKnowledgeCsvRow[];
};

export type ImportRowDecision = {
  status: 'VALID' | 'DUPLICATE' | 'CONFLICT' | 'ERROR';
  reason?: string;
  fingerprint?: string;
};

export type RagCandidate = {
  id: string;
  itemId: string;
  versionId: string;
  version: number;
  workspaceId: string;
  tenantId: string;
  shopId: string;
  scope: KnowledgeScopeValue;
  productId: string | null;
  businessStatus: KnowledgeBusinessStatusValue;
  indexStatus: KnowledgeIndexStatusValue;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  question: string;
  answer: string;
  sourceType: KnowledgeSourceTypeValue;
  /** Optional pgvector similarity. A deterministic local similarity is used when absent. */
  vectorScore?: number;
};

export type RagSearchInput = {
  workspaceId: string;
  tenantId: string;
  shopId: string;
  productId?: string;
  query: string;
  now?: Date;
  topK?: number;
  queryEmbedding?: readonly number[];
};

export type RankedRagCandidate = RagCandidate & {
  /** Raw Okapi BM25 score calculated over the already metadata-filtered corpus. */
  bm25Score: number;
  lexicalScore: number;
  vectorScore: number;
  priorityScore: number;
  score: number;
};

// “现货商品通常 24 小时内发出” is a stable policy, not inventory. Only
// current-stock assertions (for example “当前有货” / “现货仅剩 2 件”) are blocked.
const DYNAMIC_COMMERCE_FACT =
  /(?:\bsku\b|货号|条码|库存|余量|当前\s*(?:有货|无货|缺货|现货)|(?:有货|无货|缺货|补货)(?:中|了|时间|预计|数量|\s*\d)|(?:还\s*有|尚有|仅余|只剩)\s*(?:吗|\d+\s*(?:件|个|套|双|瓶|盒)?|货|现货)|现货\s*(?:仅剩|剩余|\d)|售价|价格|到手价|多少钱|折后价|¥|￥|\$\s*\d|(?:价格|售价|库存|余量)\s*[:：]?\s*\d|订单\s*(?:状态|号|#|\d)|物流\s*(?:单号|状态|轨迹|更新|到哪|什么时候(?:能)?到|何时(?:能)?到|多久(?:能)?到|几天(?:能)?到|预计[^。；;\n]{0,12}(?:到|送达))|快递\s*(?:单号|状态|到哪|什么时候(?:能)?到|何时(?:能)?到|多久(?:能)?到|预计[^。；;\n]{0,12}(?:到|送达))|运单(?:号|状态)?|退款\s*(?:状态|进度|到账|金额)|(?:已|待)发货|运输中|派送中|已签收)/i;

// Relative-date delivery promises and live promotions are dynamic even when
// the sentence omits explicit words such as “物流” or “订单”. Keep stable
// policies such as “通常 24 小时内发出” eligible for knowledge.
const DYNAMIC_RELATIVE_COMMITMENT =
  /(?:(?:今天|明天|后天|周末|本周|下周|近期|马上|即将|预计|当前|现在)[^。；;\n]{0,10}(?:发货|发出|送达|到达|配送|到货|补货|到账|优惠|促销|折扣|降价)|(?:发货|发出|送达|到达|配送|到货|补货|到账|优惠|促销|折扣|降价)[^。；;\n]{0,10}(?:今天|明天|后天|周末|本周|下周|近期|马上|即将|预计|当前|现在)|(?:当前|限时)\s*(?:优惠|促销|折扣|活动价)|(?:优惠|促销|折扣)(?:中|截止|到期))/i;

const DYNAMIC_FULFILLMENT_FACT =
  /(?:(?:多久|几天|什么时候|何时)(?:能)?\s*(?:到货|送达|到达)|(?:什么时候|何时)(?:能)?\s*发货|发货(?:了|了吗|没|状态)|配送[^。；;\n]{0,8}(?:什么时候|何时|多久|几天)[^。；;\n]{0,4}(?:到|送达|到达)|运费\s*(?:多少|几元|多少钱|价格|金额)|物流[^。；;\n]{0,12}(?:什么时候|何时|多久|几天)[^。；;\n]{0,6}(?:更新|到|送达|到达))/i;

// Presale fulfillment is tied to a live product batch and must not be frozen
// into knowledge, even when the promise omits words such as “预计”.
const DYNAMIC_PRESALE_FULFILLMENT =
  /(?:预售|预订|预约)[^。；;\n]{0,24}(?:(?:多久|几天|什么时候|何时)(?:能)?[^。；;\n]{0,6}(?:发货|发出|送达|到达|到货)|(?:\d+|[零〇一二两三四五六七八九十百千万]+)\s*(?:个)?(?:小时|天|日|周|月)(?:内|后)?[^。；;\n]{0,8}(?:发货|发出|送达|到达|到货)|(?:(?:今天|明天|后天|周末|近期)|(?:上|本|这|下|次)(?:周|月|个月|季度|年)(?:初|中|底|末)?)[^。；;\n]{0,8}(?:发货|发出|送达|到达|到货))/i;

// Numeric stock, freight and logistics promises are dynamic facts. Support
// both Arabic and Chinese numerals so synthetic/import text cannot bypass the
// same policy merely by changing number representation.
const DYNAMIC_QUANTIFIED_FACT =
  /(?:(?:还剩|还有|尚有|剩余|仅剩|只剩)\s*(?:\d+|[零〇一二两三四五六七八九十百千万]+)\s*(?:件|个|套|双|瓶|盒)|(?:本款|该款|这款|此款|本商品|该商品|这个商品)[^。；;\n]{0,4}(?:有|现有)\s*(?:\d+|[零〇一二两三四五六七八九十百千万]+)\s*(?:件|个|套|双|瓶|盒)\s*现货|(?:卖|只要|售价|价格|到手价|优惠价)\s*[¥￥]?\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+)\s*元|运费\s*[:：]?\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+)\s*元|(?:物流|快递|配送)[^。；;\n]{0,16}(?:\d+|[零〇一二两三四五六七八九十百千万]+)\s*(?:个)?(?:小时|天|日|周|月)(?:内|后)?[^。；;\n]{0,8}(?:发货|发出|送达|到达|到货))/i;

// These questions require a live product/order/logistics tool. Keeping them
// out of the static knowledge path prevents a stale vector hit from being
// presented as current inventory, price, or order truth.
const DYNAMIC_RUNTIME_QUERY =
  /(?:\bsku\b|货号|条码|库存|余量|(?:当前|现在)\s*(?:有货|无货|缺货|现货)|(?:有货|无货|缺货|补货)(?:吗|没|了|多少|数量|时间|预计)|(?:还\s*有|尚有|剩下|剩余)\s*(?:吗|多少|几(?:件|个|套|双|瓶|盒)?)|现货\s*(?:吗|还有|剩|多少|几件)|售价|价格|到手价|多少钱|订单\s*(?:状态|号|\d|查询|进度|物流|到了|发货|在哪|怎么样|如何)|物流\s*(?:状态|单号|轨迹|到哪|查询|进度|更新|什么时候(?:能)?到|何时(?:能)?到|多久(?:能)?到|几天(?:能)?到)|快递\s*(?:单号|状态|到哪|查询|进度|什么时候(?:能)?到|何时(?:能)?到|多久(?:能)?到)|运单(?:号|状态)?|发货状态|配送状态|退款\s*(?:状态|进度|到账|金额))/i;

const HEADER_ALIASES = {
  product: new Set(['product_id', 'productid', 'product-id', '商品id', '商品_id', '商品编号', '商品标识']),
  question: new Set(['question', '问题', '问句', 'faq_question']),
  answer: new Set(['answer', '答案', '回复', 'faq_answer']),
};

/**
 * Deliberately small RFC-4180-compatible parser. Import content stays in the
 * database preview; no file system or external storage is involved in the demo.
 */
export function parseKnowledgeCsv(source: string): ParsedKnowledgeCsv {
  const matrix = parseCsvMatrix(source);
  const rawHeaders = matrix.shift() ?? [];
  const headers = rawHeaders.map((value) => value.trim().replace(/^\uFEFF/, ''));
  const productIndex = findHeader(headers, HEADER_ALIASES.product);
  const questionIndex = findHeader(headers, HEADER_ALIASES.question);
  const answerIndex = findHeader(headers, HEADER_ALIASES.answer);

  return {
    headers,
    rows: matrix
      .filter((row) => row.some((cell) => cell.trim().length > 0))
      .map((row, index) => {
        const productExternalId = valueAt(row, productIndex) || null;
        const question = valueAt(row, questionIndex);
        const answer = valueAt(row, answerIndex);
        const missing: string[] = [];
        if (questionIndex === -1) missing.push('question column');
        if (answerIndex === -1) missing.push('answer column');
        if (!question) missing.push('question');
        if (!answer) missing.push('answer');
        return {
          rowNumber: index + 2,
          scope: productExternalId ? 'PRODUCT' : 'STORE',
          productExternalId,
          question,
          answer,
          ...(missing.length > 0 ? { parseError: `Missing ${missing.join(', ')}` } : {}),
        };
      }),
  };
}

export function classifyImportRow(
  row: Pick<ParsedKnowledgeCsvRow, 'rowNumber' | 'scope' | 'productExternalId' | 'question' | 'answer'> & {
    parseError?: string;
  },
  existingAnswers: readonly string[] = [],
): ImportRowDecision {
  if (row.parseError || !row.question.trim() || !row.answer.trim()) {
    return { status: 'ERROR', reason: row.parseError ?? 'QUESTION_AND_ANSWER_REQUIRED' };
  }
  if (row.scope === 'PRODUCT' && !row.productExternalId) {
    return { status: 'ERROR', reason: 'PRODUCT_ID_REQUIRED' };
  }
  if (containsForbiddenKnowledgeText(row.question, row.answer)) {
    return { status: 'ERROR', reason: 'DYNAMIC_COMMERCE_FACT_FORBIDDEN' };
  }
  const fingerprint = knowledgeFingerprint(row.question);
  if (existingAnswers.some((answer) => normalizeKnowledgeText(answer) === normalizeKnowledgeText(row.answer))) {
    return { status: 'DUPLICATE', reason: 'DUPLICATE_QUESTION_AND_ANSWER', fingerprint };
  }
  if (existingAnswers.length > 0) {
    return { status: 'CONFLICT', reason: 'EXPLICIT_ANSWER_CONFLICT', fingerprint };
  }
  return { status: 'VALID', fingerprint };
}

/** Dynamic commerce truth must never enter vector/index input. */
export function buildProductKnowledgeSource(input: { title: string; description: string }): string {
  const stableSegments = `${input.title}\n${input.description}`
    .split(/(?<=[。！？!?；;])|\r?\n/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !containsDynamicCommerceFact(segment));
  return stableSegments.join('\n');
}

export function containsDynamicCommerceFact(value: string): boolean {
  return DYNAMIC_COMMERCE_FACT.test(value)
    || DYNAMIC_RELATIVE_COMMITMENT.test(value)
    || DYNAMIC_FULFILLMENT_FACT.test(value)
    || DYNAMIC_PRESALE_FULFILLMENT.test(value)
    || DYNAMIC_QUANTIFIED_FACT.test(value);
}

/** A stable policy answer may legitimately use a generic question such as
 * “什么时候发货”. Block live entity lookups from the question and all dynamic
 * claims from the answer, rather than rejecting a reusable policy solely
 * because its FAQ wording resembles a runtime query. */
export function containsForbiddenKnowledgeText(question: string, answer: string): boolean {
  return DYNAMIC_RUNTIME_QUERY.test(question) || containsDynamicCommerceFact(answer);
}

export function requiresDynamicFactLookup(query: string): boolean {
  return DYNAMIC_RUNTIME_QUERY.test(query) || containsDynamicCommerceFact(query);
}

export function tokenizeKnowledge(value: string): string[] {
  const normalized = normalizeKnowledgeText(value).toLowerCase();
  const latin = normalized.match(/[a-z0-9]+/g) ?? [];
  const han = [...normalized.replace(/[^\u3400-\u9fff]/g, '')];
  const ngrams = new Set<string>(han);
  for (let index = 0; index < han.length - 1; index += 1) ngrams.add(`${han[index]}${han[index + 1]}`);
  return [...new Set([...latin, ...ngrams])];
}

export function knowledgeFingerprint(question: string): string {
  return tokenizeKnowledge(question).sort().join('|');
}

export function normalizeKnowledgeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').replace(/[？?！!。．,，、:：;；]/g, '').toLowerCase();
}

/** Product id is the authoritative scope signal for the public create contract. */
export function inferKnowledgeScope(productId?: string, explicitScope?: KnowledgeScopeValue): KnowledgeScopeValue {
  const inferred: KnowledgeScopeValue = productId?.trim() ? 'PRODUCT' : 'STORE';
  if (explicitScope && explicitScope !== inferred) {
    throw new Error('KNOWLEDGE_SCOPE_PRODUCT_MISMATCH');
  }
  return inferred;
}

/**
 * The data-layer equivalent of RAG metadata filtering. PRODUCT knowledge never
 * participates unless its exact product id was supplied by the caller.
 */
export function rankKnowledgeCandidates(candidates: readonly RagCandidate[], input: RagSearchInput): RankedRagCandidate[] {
  const now = input.now ?? new Date();
  const queryTokens = expandBm25QueryTerms(input.query);
  if (queryTokens.size === 0) return [];
  const queryEmbedding = input.queryEmbedding ?? deterministicKnowledgeEmbedding(input.query);

  // Metadata filtering happens before corpus statistics.  Besides enforcing
  // tenancy, this stops another shop's document frequencies from influencing
  // relevance in this shop.
  const eligible = candidates.filter((candidate) => {
      if (candidate.workspaceId !== input.workspaceId || candidate.tenantId !== input.tenantId) return false;
      if (candidate.shopId !== input.shopId) return false;
      if (candidate.businessStatus !== 'ENABLED' || candidate.indexStatus !== 'READY') return false;
      if (candidate.effectiveFrom > now || (candidate.effectiveTo && candidate.effectiveTo <= now)) return false;
      if (candidate.scope === 'PRODUCT') return Boolean(input.productId) && candidate.productId === input.productId;
      return candidate.productId === null;
    });
  if (eligible.length === 0) return [];

  const documents = eligible.map((candidate) => ({
    candidate,
    tokens: tokenizeKnowledgeForBm25(`${candidate.question}\n${candidate.answer}`),
  }));
  const averageDocumentLength = documents.reduce((total, document) => total + document.tokens.length, 0) / documents.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    const unique = new Set(document.tokens);
    for (const term of queryTokens) {
      if (unique.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const rawBm25 = documents.map(({ tokens }) => bm25Score(tokens, queryTokens, documentFrequency, documents.length, averageDocumentLength));
  const maxBm25 = Math.max(...rawBm25, 0);

  return documents
    .map(({ candidate }, index) => {
      const bm25 = rawBm25[index] ?? 0;
      // Fusion needs a bounded lexical component, while bm25Score remains
      // available for observability and testable retrieval semantics.
      const lexicalScore = maxBm25 > 0 ? bm25 / maxBm25 : 0;
      // pgvector `<=>` returns cosine distance. If the DB score was not
      // supplied (unit tests / migration-less local development), use the same
      // deterministic local embedding to exercise the fusion decision.
      const vectorScore = Math.max(
        0,
        Math.min(
          1,
          candidate.vectorScore ?? (cosineSimilarity(queryEmbedding, deterministicKnowledgeEmbedding(`${candidate.question}\n${candidate.answer}`)) + 1) / 2,
        ),
      );
      const sourcePriority = candidate.sourceType === 'MANUAL' ? 0.15 : candidate.sourceType === 'HUMAN_REVIEWED' ? 0.1 : 0.05;
      const scopePriority = candidate.scope === 'PRODUCT' ? 0.08 : 0;
      const priorityScore = sourcePriority + scopePriority;
      return {
        ...candidate,
        bm25Score: bm25,
        lexicalScore,
        vectorScore,
        priorityScore,
        score: lexicalScore * 0.55 + vectorScore * 0.35 + priorityScore,
      };
    })
    // Hybrid retrieval takes the union of keyword and vector candidates. A
    // vector-only hit needs a meaningful score; low collision scores from the
    // deterministic fallback are not allowed to fabricate evidence.
    .filter((candidate) => candidate.lexicalScore > 0 || candidate.vectorScore >= 0.7)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.min(Math.max(input.topK ?? 3, 1), 3));
}

const BM25_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  '退货': ['退换'],
  '退换': ['退货'],
  '发货': ['配送'],
  '配送': ['发货'],
  '保温': ['保暖'],
  '保暖': ['保温'],
};

function expandBm25QueryTerms(query: string): Set<string> {
  const terms = new Set(tokenizeKnowledgeForBm25(query));
  const normalized = normalizeKnowledgeText(query);
  for (const [source, synonyms] of Object.entries(BM25_SYNONYMS)) {
    if (!normalized.includes(source)) continue;
    for (const synonym of synonyms) for (const token of tokenizeKnowledgeForBm25(synonym)) terms.add(token);
  }
  return terms;
}

/** Keep term frequency for BM25; tokenizeKnowledge intentionally de-duplicates. */
function tokenizeKnowledgeForBm25(value: string): string[] {
  const normalized = normalizeKnowledgeText(value).toLowerCase();
  const latin = normalized.match(/[a-z0-9]+/g) ?? [];
  const han = [...normalized.replace(/[^\u3400-\u9fff]/g, '')];
  const terms = [...latin, ...han];
  for (let index = 0; index < han.length - 1; index += 1) terms.push(`${han[index]}${han[index + 1]}`);
  return terms;
}

function bm25Score(
  documentTokens: readonly string[],
  queryTerms: ReadonlySet<string>,
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
  averageDocumentLength: number,
): number {
  const frequencies = new Map<string, number>();
  for (const token of documentTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const normalization = k1 * (1 - b + b * (documentTokens.length / averageDocumentLength));
  let score = 0;
  for (const term of queryTerms) {
    const frequency = frequencies.get(term) ?? 0;
    if (frequency === 0) continue;
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
    score += idf * ((frequency * (k1 + 1)) / (frequency + normalization));
  }
  return score;
}

export function decideRagResult(input: {
  candidates: readonly RankedRagCandidate[] | readonly RagCandidate[];
  conflicts: readonly RagCandidate[];
}): { status: 'OK' | 'NO_EVIDENCE' | 'CONFLICTED'; candidates: readonly RagCandidate[]; autoSelectable: boolean } {
  if (input.conflicts.length > 0) return { status: 'CONFLICTED', candidates: [], autoSelectable: false };
  if (input.candidates.length === 0) return { status: 'NO_EVIDENCE', candidates: [], autoSelectable: false };
  return { status: 'OK', candidates: input.candidates, autoSelectable: true };
}

export function versionSwitchDecision(input: {
  currentActiveVersionId: string | null;
  nextVersionId: string;
  nextIndexStatus: KnowledgeIndexStatusValue;
}): { activeVersionId: string | null; switched: boolean } {
  if (input.nextIndexStatus !== 'READY') {
    return { activeVersionId: input.currentActiveVersionId, switched: false };
  }
  return { activeVersionId: input.nextVersionId, switched: true };
}

function findHeader(headers: readonly string[], aliases: ReadonlySet<string>): number {
  return headers.findIndex((header) => aliases.has(header.trim().toLowerCase()));
}

function valueAt(row: readonly string[], index: number): string {
  return index >= 0 ? (row[index] ?? '').trim() : '';
}

function parseCsvMatrix(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === ',' && !quoted) {
      row.push(cell);
      cell = '';
      continue;
    }
    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += character;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
