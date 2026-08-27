import {
  KNOWLEDGE_EMBEDDING_DIMENSION,
  JsonEmbeddingGatewayProvider,
  createKnowledgeEmbeddingProvider,
  cosineSimilarity,
  deterministicKnowledgeEmbedding,
  pgVectorLiteral,
} from '../src/knowledge/knowledge.vector';

describe('Phase 03 deterministic pgvector bridge', () => {
  it('creates stable normalized vectors at the frozen pgvector dimension', () => {
    const first = deterministicKnowledgeEmbedding('保温杯材质 316L 不锈钢');
    const second = deterministicKnowledgeEmbedding('保温杯材质 316L 不锈钢');

    expect(first).toHaveLength(KNOWLEDGE_EMBEDDING_DIMENSION);
    expect(first).toEqual(second);
    expect(cosineSimilarity(first, second)).toBeCloseTo(1, 8);
    expect(pgVectorLiteral(first)).toMatch(/^\[-?0\.\d{8}(,-?\d+\.\d{8}){1535}\]$/);
  });

  it('rejects incorrectly sized literals before SQL can be issued', () => {
    expect(() => pgVectorLiteral([0, 1])).toThrow('KNOWLEDGE_EMBEDDING_INVALID');
  });

  it('supports an explicitly configured server-side embedding gateway with offline fallback', async () => {
    const vector = Array(KNOWLEDGE_EMBEDDING_DIMENSION).fill(0);
    const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ embedding: vector }) });
    const provider = new JsonEmbeddingGatewayProvider({
      endpoint: 'https://models.example.test/embeddings',
      model: 'embedding-model',
      secret: 'server-only-secret',
      fetcher: fetcher as never,
    });

    await expect(provider.embed('材质')).resolves.toHaveLength(KNOWLEDGE_EMBEDDING_DIMENSION);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer server-only-secret' }));
    expect(String(init.body)).not.toContain('server-only-secret');
    expect(createKnowledgeEmbeddingProvider({}).mode).toBe('OFFLINE_FALLBACK');
    expect(createKnowledgeEmbeddingProvider({
      AI_BASE_URL: 'https://models.example.test/embeddings',
      AI_API_KEY: 'server-only-secret',
      AI_EMBEDDING_MODEL: 'embedding-model',
    }).mode).toBe('PROVIDER');
  });

  it('enforces a deadline even when an embedding gateway ignores abort', async () => {
    const provider = new JsonEmbeddingGatewayProvider({
      endpoint: 'https://models.example.test/embeddings',
      model: 'embedding-model',
      timeoutMs: 10,
      fetcher: (() => new Promise(() => undefined)) as never,
    });

    await expect(provider.embed('材质')).rejects.toThrow('timed out');
  });

  it('keeps the hard deadline while response JSON parsing never resolves', async () => {
    let signal: AbortSignal | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const provider = new JsonEmbeddingGatewayProvider({
      endpoint: 'https://models.example.test/embeddings',
      model: 'embedding-model',
      timeoutMs: 10,
      fetcher: jest.fn((_input: string | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return Promise.resolve({ ok: true, json: () => new Promise(() => undefined) });
      }) as never,
    });
    const testWatchdog = new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error('test watchdog elapsed before JSON deadline')), 100);
    });

    try {
      await expect(Promise.race([provider.embed('材质'), testWatchdog])).rejects.toThrow('timed out');
      expect(signal?.aborted).toBe(true);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  });
});
