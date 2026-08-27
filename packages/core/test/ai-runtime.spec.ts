import {
  AiRuntime,
  AiRuntimeFailure,
  type AiProvider,
  type AiProviderRequest,
  type AiProviderResponse,
} from '../src/ai-runtime';

class ScriptedProvider implements AiProvider {
  readonly calls: AiProviderRequest[] = [];

  constructor(
    readonly name: string,
    private readonly script: Array<AiProviderResponse | Error | 'TIMEOUT'>,
  ) {}

  async invoke(request: AiProviderRequest): Promise<AiProviderResponse> {
    this.calls.push(request);
    const next = this.script.shift();
    if (next === 'TIMEOUT') {
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      });
    }
    if (next instanceof Error) throw next;
    if (!next) throw new Error('script exhausted');
    return next;
  }
}

const ok = (output: unknown): AiProviderResponse => ({
  output,
  model: 'synthetic-model',
  usage: { inputTokens: 10, outputTokens: 5 },
});

describe('AI Runtime', () => {
  it('retries one transient failure then falls back once after timeout', async () => {
    const primary = new ScriptedProvider('primary', ['TIMEOUT', 'TIMEOUT']);
    const fallback = new ScriptedProvider('fallback', [ok({ tasks: ['PRODUCT_QUERY'] })]);
    const runtime = new AiRuntime({ providers: { primary, fallback }, routes: { INTENT_PLANNER: ['primary', 'fallback'] } });

    const result = await runtime.runStructured({
      purpose: 'INTENT_PLANNER',
      input: { text: '支持什么连接方式' },
      timeoutMs: 10,
      validate: (value): value is { tasks: string[] } =>
        typeof value === 'object' && value !== null && Array.isArray((value as { tasks?: unknown }).tasks),
    });

    expect(result.output.tasks).toEqual(['PRODUCT_QUERY']);
    expect(result.fallbackUsed).toBe(true);
    expect(primary.calls).toHaveLength(2);
    expect(fallback.calls).toHaveLength(1);
  });

  it('repairs invalid structured output exactly once and fails closed if still invalid', async () => {
    const provider = new ScriptedProvider('primary', [ok({ bad: true }), ok({ stillBad: true })]);
    const runtime = new AiRuntime({ providers: { primary: provider }, routes: { RISK_CLASSIFIER: ['primary'] } });

    await expect(
      runtime.runStructured({
        purpose: 'RISK_CLASSIFIER',
        input: { text: '退款' },
        validate: (value): value is { riskLevel: string } =>
          typeof value === 'object' && value !== null && typeof (value as { riskLevel?: unknown }).riskLevel === 'string',
      }),
    ).rejects.toMatchObject({
      code: 'SCHEMA_INVALID',
      audit: {
        purpose: 'RISK_CLASSIFIER',
        provider: 'primary',
        model: 'synthetic-model',
        fallbackUsed: false,
        status: 'FAILED',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
      },
    });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.repair).toBe(true);
  });

  it('does not retain full prompts in usage logs and propagates caller abort', async () => {
    const provider = new ScriptedProvider('primary', ['TIMEOUT']);
    const runtime = new AiRuntime({ providers: { primary: provider }, routes: { SUMMARY: ['primary'] } });
    const controller = new AbortController();
    const pending = runtime.runStructured({
      purpose: 'SUMMARY',
      input: { phone: '13800138000', secret: 'do-not-log' },
      signal: controller.signal,
      validate: (_value): _value is object => true,
    });
    controller.abort(new Error('stale'));

    await expect(pending).rejects.toMatchObject<Partial<AiRuntimeFailure>>({ code: 'ABORTED' });
    expect(runtime.usageLog()).toHaveLength(1);
    expect(JSON.stringify(runtime.usageLog())).not.toContain('13800138000');
    expect(JSON.stringify(runtime.usageLog())).not.toContain('do-not-log');
  });

  it('attaches only this invocation\'s safe usage metadata to an aborted failure', async () => {
    const provider = new ScriptedProvider('primary', ['TIMEOUT']);
    const runtime = new AiRuntime({ providers: { primary: provider }, routes: { SUMMARY: ['primary'] } });
    const controller = new AbortController();
    const pending = runtime.runStructured({
      purpose: 'SUMMARY',
      input: { phone: '13800138000', secret: 'do-not-log' },
      signal: controller.signal,
      validate: (_value): _value is object => true,
    });
    controller.abort(new Error('stale'));

    await expect(pending).rejects.toMatchObject({
      code: 'ABORTED',
      audit: {
        purpose: 'SUMMARY',
        provider: 'primary',
        model: null,
        fallbackUsed: false,
        status: 'ABORTED',
        tokenUsage: null,
      },
    });
    try {
      await pending;
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('13800138000');
      expect(JSON.stringify(error)).not.toContain('do-not-log');
      const audit = (error as AiRuntimeFailure).audit;
      expect(JSON.stringify(audit)).not.toContain('13800138000');
      expect(JSON.stringify(audit)).not.toContain('do-not-log');
      expect(Object.isFrozen(audit)).toBe(true);
    }
  });

  it('enforces its deadline even when a provider ignores AbortSignal', async () => {
    const hanging: AiProvider = {
      name: 'hanging',
      invoke: async () => new Promise<AiProviderResponse>(() => undefined),
    };
    const fallback = new ScriptedProvider('fallback', [ok({ tasks: ['SAFE_FALLBACK'] })]);
    const runtime = new AiRuntime({
      providers: { hanging, fallback },
      routes: { INTENT_PLANNER: ['hanging', 'fallback'] },
    });

    const result = await runtime.runStructured({
      purpose: 'INTENT_PLANNER',
      input: { text: '不会协作取消的 provider' },
      timeoutMs: 5,
      validate: (value): value is { tasks: string[] } =>
        typeof value === 'object' && value !== null && Array.isArray((value as { tasks?: unknown }).tasks),
    });

    expect(result).toMatchObject({ fallbackUsed: true, provider: 'fallback' });
  });
});
