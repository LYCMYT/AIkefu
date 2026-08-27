import type { AiProviderRequest } from '@ai-customer-service/core';
import {
  JsonModelGatewayProvider,
  OfflineStructuredProvider,
  createServerAiRuntime,
} from '../src/ai/ai-providers';

function request(purpose: AiProviderRequest['purpose'], input: unknown = {}): AiProviderRequest {
  return { purpose, input, signal: new AbortController().signal, attempt: 1, repair: false };
}

describe('server AI providers', () => {
  it('keeps the demo deterministic and returns frozen structured image/summary shapes', async () => {
    const provider = new OfflineStructuredProvider();
    const image = await provider.invoke(request('IMAGE_ANALYSIS', {
      image: { base64: Buffer.from('AICS_FIXTURE:DAMAGED_SLEEVE').toString('base64') },
    }));
    const summary = await provider.invoke(request('SUMMARY', {
      messages: [{ id: 'message-1', text: '想换货', sequence: 1 }],
    }));

    expect(image.output).toEqual(expect.objectContaining({ scene: 'PRODUCT_DAMAGE', requiresHuman: true }));
    expect(summary.output).toEqual(expect.objectContaining({
      narrativeSummary: expect.any(String),
      resolvedFacts: expect.any(Array),
      openQuestions: expect.any(Array),
    }));
  });

  it('calls an explicitly configured server-side JSON model gateway without leaking its secret into the body', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' },
        model: 'remote-model',
        usage: { inputTokens: 3, outputTokens: 2 },
      }),
    });
    const provider = new JsonModelGatewayProvider({
      endpoint: 'https://models.example.test/structured',
      secret: 'server-only-secret',
      model: 'remote-model',
      fetcher: fetcher as never,
    });

    await provider.invoke(request('RISK_CLASSIFIER', { text: 'hello' }));

    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer server-only-secret' }));
    expect(String(init.body)).not.toContain('server-only-secret');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the offline provider when no external model gateway is configured', async () => {
    const runtime = createServerAiRuntime({});
    const result = await runtime.runStructured({
      purpose: 'RISK_CLASSIFIER',
      input: { text: 'hello' },
      validate: (value: unknown): value is { riskLevel: string } => Boolean(value && typeof value === 'object' && 'riskLevel' in value),
    });

    expect(result.provider).toBe('offline-structured-demo');
  });

  it('activates the frozen AI_BASE_URL/API_KEY/model environment contract by purpose', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' },
        model: 'fast-model',
      }),
    } as Response);
    try {
      const runtime = createServerAiRuntime({
        AI_BASE_URL: 'https://models.example.test/structured',
        AI_API_KEY: 'server-only-secret',
        AI_FAST_MODEL: 'fast-model',
        AI_TIMEOUT_MS: '8000',
      });
      const result = await runtime.runStructured({
        purpose: 'RISK_CLASSIFIER',
        input: { text: 'hello' },
        validate: (value: unknown): value is { riskLevel: string } => Boolean(value && typeof value === 'object' && 'riskLevel' in value),
      });

      expect(result.provider).toBe('configured-json-model-gateway');
      const init = fetcher.mock.calls[0]![1] as RequestInit;
      expect(init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer server-only-secret' }));
      expect(String(init.body)).toContain('"model":"fast-model"');
    } finally {
      fetcher.mockRestore();
    }
  });

  it.each(['RISK_CLASSIFIER', 'INTENT_PLANNER'] as const)(
    'fails closed for %s when its configured primary provider fails',
    async (purpose) => {
      const fetcher = jest.fn().mockRejectedValue(new Error('configured provider unavailable'));
      const runtime = createServerAiRuntime({
        AI_BASE_URL: 'https://models.example.test/structured',
        AI_API_KEY: 'server-only-secret',
        AI_FAST_MODEL: 'fast-model',
        fetcher: fetcher as never,
      });

      await expect(runtime.runStructured({
        purpose,
        input: { text: '请处理这个请求' },
        validate: (_value: unknown): _value is object => true,
      })).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });

      // One transient retry is allowed, but a configured decision provider
      // must never silently switch to the permissive demo result.
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
});
