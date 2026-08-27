/**
 * A deterministic, local embedding used by the demo indexer. It deliberately
 * has no provider, credential, or network dependency. Production migrations
 * still persist it in pgvector, so replacing this implementation with a real
 * embedding provider does not change the retrieval contract.
 */
export const KNOWLEDGE_EMBEDDING_DIMENSION = 1536;
export const KNOWLEDGE_EMBEDDING_PROVIDER = Symbol('KNOWLEDGE_EMBEDDING_PROVIDER');

/**
 * Provider seam for production embeddings.  The checked-in implementation is
 * deliberately an offline deterministic fallback: it never receives a real
 * credential or performs network I/O, and callers can expose that fact in
 * runtime diagnostics instead of mistaking it for a semantic provider.
 */
export interface KnowledgeEmbeddingProvider {
  readonly id: string;
  readonly mode: 'OFFLINE_FALLBACK' | 'PROVIDER';
  embed(input: string): number[] | Promise<number[]>;
}

type EmbeddingGatewayResponse = { ok: boolean; json(): Promise<unknown> };
type EmbeddingGatewayFetch = (input: string | URL, init?: RequestInit) => Promise<EmbeddingGatewayResponse>;

export class JsonEmbeddingGatewayProvider implements KnowledgeEmbeddingProvider {
  readonly id = 'configured-json-embedding-gateway';
  readonly mode = 'PROVIDER' as const;
  private readonly endpoint: URL;
  private readonly fetcher: EmbeddingGatewayFetch;

  constructor(private readonly options: {
    endpoint: string;
    model: string;
    secret?: string;
    fetcher?: EmbeddingGatewayFetch;
    timeoutMs?: number;
  }) {
    this.endpoint = new URL(options.endpoint);
    if (this.endpoint.protocol !== 'https:' && this.endpoint.hostname !== 'localhost' && this.endpoint.hostname !== '127.0.0.1') {
      throw new Error('Embedding gateway must use HTTPS unless it is local');
    }
    if (!options.model.trim()) throw new Error('Embedding gateway model is required');
    this.fetcher = options.fetcher ?? (globalThis.fetch as EmbeddingGatewayFetch);
  }

  async embed(input: string): Promise<number[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.secret) headers.Authorization = `Bearer ${this.options.secret}`;
    const controller = new AbortController();
    const timeoutMs = positiveInteger(this.options.timeoutMs, 8_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Configured embedding gateway timed out'));
      }, timeoutMs);
    });
    try {
      // Keep one hard deadline around the entire untrusted gateway boundary.
      // fetch() may resolve while Response.json() stalls forever, so timing
      // only the initial request would leave a worker hung indefinitely.
      return await Promise.race([
        (async () => {
          const response = await this.fetcher(this.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: this.options.model, input }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('Configured embedding gateway request failed');
          const payload = await response.json();
          const embedding = isRecord(payload) && Array.isArray(payload.embedding) ? payload.embedding : undefined;
          if (!embedding || embedding.length !== KNOWLEDGE_EMBEDDING_DIMENSION || embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
            throw new Error('Configured embedding gateway returned an invalid vector');
          }
          return embedding as number[];
        })(),
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function createKnowledgeEmbeddingProvider(environment: NodeJS.ProcessEnv = process.env): KnowledgeEmbeddingProvider {
  const endpoint = environment.AI_EMBEDDING_GATEWAY_URL?.trim() || environment.AI_BASE_URL?.trim();
  const model = environment.AI_EMBEDDING_MODEL?.trim();
  if (!endpoint || !model) return deterministicOfflineEmbeddingProvider;
  return new JsonEmbeddingGatewayProvider({
    endpoint,
    model,
    ...((environment.AI_EMBEDDING_GATEWAY_SECRET || environment.AI_API_KEY)
      ? { secret: environment.AI_EMBEDDING_GATEWAY_SECRET || environment.AI_API_KEY }
      : {}),
    timeoutMs: positiveInteger(Number(environment.AI_EMBEDDING_TIMEOUT_MS || environment.AI_TIMEOUT_MS), 8_000),
  });
}

export function deterministicKnowledgeEmbedding(input: string): number[] {
  const vector = Array<number>(KNOWLEDGE_EMBEDDING_DIMENSION).fill(0);
  const normalized = input.trim().toLowerCase();
  if (!normalized) return vector;

  // Character and adjacent-character features behave consistently for mixed
  // Chinese/Latin knowledge text without needing an external tokenizer.
  const features = [...normalized].map((character, index, characters) =>
    index + 1 < characters.length ? `${character}${characters[index + 1]}` : character,
  );
  for (const feature of features) {
    const bucket = stableHash(feature) % KNOWLEDGE_EMBEDDING_DIMENSION;
    const direction = (stableHash(`sign:${feature}`) & 1) === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + direction;
  }
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

export const deterministicOfflineEmbeddingProvider: KnowledgeEmbeddingProvider = {
  id: 'deterministic-offline-v1',
  mode: 'OFFLINE_FALLBACK',
  embed: deterministicKnowledgeEmbedding,
};

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)));
}

/** Safe literal for a parameterized `$executeRaw` / `$queryRaw` vector cast. */
export function pgVectorLiteral(vector: readonly number[]): string {
  if (vector.length !== KNOWLEDGE_EMBEDDING_DIMENSION || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('KNOWLEDGE_EMBEDDING_INVALID');
  }
  return `[${vector.map((value) => value.toFixed(8)).join(',')}]`;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
