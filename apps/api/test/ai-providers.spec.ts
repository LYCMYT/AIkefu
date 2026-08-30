import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AiProviderRequest } from '@ai-customer-service/core';
import {
  DeepSeekJsonProvider,
  JsonModelGatewayProvider,
  OpenAICompatibleProvider,
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

  it('plans the frozen inventory and size intents deterministically in offline demo mode', async () => {
    const provider = new OfflineStructuredProvider();

    const plan = await provider.invoke(request('INTENT_PLANNER', {
      turn: { text: '黑色有吗\nXL呢\n我165，55公斤' },
    }));

    expect(plan.output).toEqual({
      tasks: [
        { intent: 'INVENTORY_QUERY', riskLevel: 'LOW', requiredContext: ['PRODUCT', 'SKU'], requiredTools: ['GET_INVENTORY'] },
        { intent: 'SIZE_RECOMMENDATION', riskLevel: 'LOW', requiredContext: ['PRODUCT', 'SKU', 'CUSTOMER_MEMORY'], requiredTools: ['GET_PRODUCT'] },
      ],
      summary: '库存与尺码咨询',
    });
  });

  it('composes only durable task facts in offline mode and flags unresolved parts for human review', async () => {
    const provider = new OfflineStructuredProvider();

    const resolved = await provider.invoke(request('REPLY_GENERATION', {
      tasks: [
        { intent: 'INVENTORY_QUERY', status: 'RESOLVED', facts: { reply: '这个规格目前有现货。' } },
        { intent: 'SHIPPING_POLICY', status: 'RESOLVED', facts: { reply: '普通现货商品通常在24小时内发出。' } },
      ],
    }));
    const partial = await provider.invoke(request('REPLY_GENERATION', {
      tasks: [
        { intent: 'INVENTORY_QUERY', status: 'RESOLVED', facts: { reply: '这个规格目前有现货。' } },
        { intent: 'SIZE_RECOMMENDATION', status: 'FAILED', errorCode: 'NO_EVIDENCE' },
      ],
    }));
    const noEvidence = await provider.invoke(request('REPLY_GENERATION', {
      turn: { text: '你们支持线下试穿吗？' },
      tasks: [{ intent: 'FAQ_QUERY', status: 'FAILED', errorCode: 'NO_EVIDENCE' }],
    }));

    expect(resolved.output).toEqual({
      text: '这个规格目前有现货。\n普通现货商品通常在24小时内发出。',
      requiresHuman: false,
    });
    expect(partial.output).toEqual({
      text: '这个规格目前有现货。\n尺码建议还需要人工确认。',
      requiresHuman: true,
    });
    expect(noEvidence.output).toEqual({
      text: '关于“线下试穿”，暂时没有找到可靠依据，已转入人工确认。',
      requiresHuman: true,
    });
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

  it('adapts the DeepSeek Chat Completions JSON mode without placing its key in the body', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"riskLevel":"LOW","reasons":[],"recommendedMode":"AUTO"}' } }],
        model: 'deepseek-v4-flash',
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    });
    const provider = new DeepSeekJsonProvider({
      endpoint: 'https://api.deepseek.com',
      secret: 'server-only-deepseek-secret',
      model: 'deepseek-v4-flash',
      fetcher: fetcher as never,
    });

    const result = await provider.invoke(request('RISK_CLASSIFIER', { text: 'hello' }));

    expect(result).toEqual({
      output: { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' },
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    expect(fetcher).toHaveBeenCalledWith('https://api.deepseek.com/chat/completions', expect.any(Object));
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer server-only-deepseek-secret' }));
    expect(String(init.body)).not.toContain('server-only-deepseek-secret');
    expect(body).toEqual(expect.objectContaining({
      model: 'deepseek-v4-flash',
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
    }));
    expect(JSON.stringify(body.messages)).toContain('JSON');
  });

  it('adapts a generic OpenAI-compatible Chat Completions endpoint', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"riskLevel":"LOW","reasons":[],"recommendedMode":"AUTO"}' } }],
        model: 'compatible-model', usage: { prompt_tokens: 4, completion_tokens: 3 },
      }),
    });
    const provider = new OpenAICompatibleProvider({
      endpoint: 'https://models.example.test/v1/chat/completions', secret: 'secret', model: 'compatible-model', apiStyle: 'chat-completions', fetcher: fetcher as never,
    });

    const result = await provider.invoke({ ...request('RISK_CLASSIFIER', { tasks: [] }), prompt: { version: 'reply-risk-v1', system: 'Return safe JSON.', instructions: 'Classify risk.' } });

    expect(result.output).toMatchObject({ riskLevel: 'LOW' });
    expect(fetcher).toHaveBeenCalledWith('https://models.example.test/v1/chat/completions', expect.any(Object));
    expect(JSON.parse(String((fetcher.mock.calls[0]![1] as RequestInit).body)).messages[0].content).toContain('Return safe JSON');
  });

  it('adapts an OpenAI-compatible Responses endpoint and disables provider-side storage', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_text: '{"riskLevel":"LOW","reasons":[],"recommendedMode":"AUTO"}', model: 'responses-model', usage: { input_tokens: 7, output_tokens: 2 } }),
    });
    const provider = new OpenAICompatibleProvider({
      endpoint: 'https://models.example.test/v1/responses', secret: 'secret', model: 'responses-model', apiStyle: 'responses', fetcher: fetcher as never,
    });

    const result = await provider.invoke({ ...request('RISK_CLASSIFIER', { tasks: [] }), prompt: { version: 'reply-risk-v1', system: 'Return safe JSON.', instructions: 'Classify risk.' } });

    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    const body = JSON.parse(String((fetcher.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'responses-model', store: false, instructions: expect.stringContaining('Return safe JSON') });
  });

  it('can resolve a DeepSeek key from a server-only file without embedding it in environment values', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aikefu-model-key-'));
    const keyPath = join(directory, 'deepseek.key');
    writeFileSync(keyPath, 'test-deepseek-secret\n', { encoding: 'utf8', mode: 0o600 });
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"riskLevel":"LOW","reasons":[],"recommendedMode":"AUTO"}' } }],
        model: 'deepseek-v4-flash',
      }),
    });
    try {
      const runtime = createServerAiRuntime({
        AI_PROVIDER: 'deepseek',
        AI_API_KEY_FILE: keyPath,
        AI_FAST_MODEL: 'deepseek-v4-flash',
        fetcher: fetcher as never,
      });
      const result = await runtime.runStructured({
        purpose: 'RISK_CLASSIFIER',
        input: { text: 'hello' },
        validate: (value: unknown): value is { riskLevel: string } => Boolean(value && typeof value === 'object' && 'riskLevel' in value),
      });

      expect(result.provider).toBe('deepseek-openai-chat');
      expect((fetcher.mock.calls[0]![1] as RequestInit).headers).toEqual(expect.objectContaining({
        Authorization: 'Bearer test-deepseek-secret',
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [400, 1],
    [401, 1],
    [403, 1],
    [429, 2],
    [500, 2],
  ] as const)('classifies HTTP %s for bounded retry (%s call(s))', async (status, expectedCalls) => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => ({}),
    });
    const runtime = createServerAiRuntime({
      AI_PROVIDER: 'json-gateway',
      AI_BASE_URL: 'https://models.example.test/structured',
      AI_API_KEY: 'server-only-secret',
      AI_FAST_MODEL: 'fast-model',
      fetcher: fetcher as never,
    });

    await expect(runtime.runStructured({
      purpose: 'RISK_CLASSIFIER',
      input: { text: '需要判断风险' },
      validate: (_value: unknown): _value is object => true,
    })).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(expectedCalls);
  });

  it('uses the offline provider when no external model gateway is configured', async () => {
    const runtime = createServerAiRuntime({ AI_OFFLINE_MODE: '1' });
    const result = await runtime.runStructured({
      purpose: 'RISK_CLASSIFIER',
      input: { text: 'hello' },
      validate: (value: unknown): value is { riskLevel: string } => Boolean(value && typeof value === 'object' && 'riskLevel' in value),
    });

    expect(result.provider).toBe('offline-structured-demo');
  });

  it('grounds an offline workflow recommendation in the products returned by its scoped query', async () => {
    const runtime = createServerAiRuntime({ AI_OFFLINE_MODE: '1' });
    const result = await runtime.runStructured({
      purpose: 'REPLY_GENERATION',
      input: {
        workflow: {
          priorNodeOutputs: {
            query: {
              products: [
                { id: 'product-keyboard', title: 'SilentKey 84 静音键盘', status: 'ON_SHELF', recommendable: true },
                { id: 'product-screen', title: 'ViewGo 15.6英寸便携屏', status: 'ON_SHELF', recommendable: true },
              ],
            },
          },
        },
      },
      validate: (value: unknown): value is { text: string; requiresHuman: boolean } => Boolean(
        value && typeof value === 'object' && 'text' in value && 'requiresHuman' in value,
      ),
    });

    expect(result.output).toEqual({ text: '为你推荐 SilentKey 84 静音键盘。', requiresHuman: false });
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
        AI_PROVIDER: 'json-gateway',
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

  it.each(['RISK_CLASSIFIER', 'INTENT_PLANNER', 'SUMMARY', 'KNOWLEDGE_EXTRACT', 'REPLY_GENERATION', 'IMAGE_ANALYSIS', 'QUALITY_JUDGE'] as const)(
    'fails closed for %s when its configured primary provider fails',
    async (purpose) => {
      const fetcher = jest.fn().mockRejectedValue(new Error('configured provider unavailable'));
      const runtime = createServerAiRuntime({
        AI_PROVIDER: 'json-gateway',
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

  it('fails startup closed in production when neither a real provider nor explicit offline mode is configured', () => {
    expect(() => createServerAiRuntime({ NODE_ENV: 'production' })).toThrow('AI_PROVIDER_CONFIGURATION_REQUIRED');
  });

  it('parses provider Retry-After metadata without retaining response bodies', async () => {
    const provider = new JsonModelGatewayProvider({
      endpoint: 'https://models.example.test/structured', secret: 'server-only-secret', model: 'fast-model',
      fetcher: jest.fn().mockResolvedValue({
        ok: false, status: 429, headers: { get: () => '3' }, json: async () => ({ diagnostic: 'must-not-be-stored' }),
      }) as never,
    });
    await expect(provider.invoke(request('SUMMARY', {}))).rejects.toMatchObject({
      kind: 'HTTP', status: 429, retryAfterMs: 3_000,
    });
  });
});
