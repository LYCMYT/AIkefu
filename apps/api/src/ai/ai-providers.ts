import {
  AiProviderFailure,
  AiRuntime,
  type AiProvider,
  type AiProviderRequest,
  type AiProviderResponse,
  type AiPurpose,
} from '@ai-customer-service/core';

type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export type JsonModelGatewayOptions = {
  endpoint: string;
  /** Supplied by server configuration only; never placed in a request body or audit row. */
  secret: string;
  model: string;
  fetcher?: FetchLike;
};

type ServerAiRuntimeOptions = Partial<JsonModelGatewayOptions> & Partial<Record<
  | 'AI_BASE_URL'
  | 'AI_API_KEY'
  | 'AI_FAST_MODEL'
  | 'AI_QUALITY_MODEL'
  | 'AI_MULTIMODAL_MODEL'
  | 'AI_JUDGE_MODEL'
  | 'AI_TIMEOUT_MS'
  | 'AI_MODEL_GATEWAY_URL'
  | 'AI_MODEL_GATEWAY_SECRET'
  | 'AI_MODEL_NAME'
  | 'AI_RUNTIME_TIMEOUT_MS',
  string
>>;

/**
 * Optional server-side gateway. It has no environment lookup and is never
 * constructed by default, so the demo cannot accidentally contact a hosted
 * model or require a real credential.
 */
export class JsonModelGatewayProvider implements AiProvider {
  readonly name = 'configured-json-model-gateway';
  private readonly fetcher: FetchLike;

  constructor(private readonly options: JsonModelGatewayOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
      throw new Error('AI_GATEWAY_HTTPS_REQUIRED');
    }
    if (!options.secret?.trim() || !options.model?.trim()) throw new Error('AI_GATEWAY_CONFIGURATION_INVALID');
    this.fetcher = options.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  }

  async invoke(request: AiProviderRequest): Promise<AiProviderResponse> {
    if (request.signal.aborted) throw abortedProviderFailure(request.signal);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetcher(this.options.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.secret}`,
          'Content-Type': 'application/json',
        },
        // Secret/credentials remain exclusively in the Authorization header.
        body: JSON.stringify({
          model: this.options.model,
          purpose: request.purpose,
          input: request.input,
          attempt: request.attempt,
          repair: request.repair,
          ...(request.previousOutput === undefined ? {} : { previousOutput: request.previousOutput }),
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw abortedProviderFailure(request.signal, error);
      throw new AiProviderFailure('NETWORK', true, 'AI_GATEWAY_NETWORK_ERROR', { cause: error });
    }
    if (!response.ok) {
      const status = response.status ?? 0;
      throw new AiProviderFailure('HTTP', isRetryableHttpStatus(status), `AI_GATEWAY_HTTP_${status}`, { status });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new AiProviderFailure('RESPONSE', false, 'AI_GATEWAY_RESPONSE_INVALID', { cause: error });
    }
    if (!payload || typeof payload !== 'object' || !('output' in payload)) throw new Error('AI_GATEWAY_RESPONSE_INVALID');
    const record = payload as { output: unknown; model?: unknown; usage?: unknown };
    return {
      output: record.output,
      model: typeof record.model === 'string' && record.model ? record.model : this.options.model,
      ...(validUsage(record.usage) ? { usage: record.usage } : {}),
    };
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function abortedProviderFailure(signal: AbortSignal, cause?: unknown): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new AiProviderFailure('ABORTED', false, 'AI_REQUEST_ABORTED', { cause });
}

/** Offline-only fixture provider used unless a caller explicitly injects a gateway. */
export class OfflineStructuredProvider implements AiProvider {
  readonly name = 'offline-structured-demo';

  async invoke(request: AiProviderRequest): Promise<AiProviderResponse> {
    if (request.signal.aborted) throw new Error('AI_REQUEST_ABORTED');
    return {
      output: offlineOutput(request.purpose, request.input),
      model: 'offline-structured-v1',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

export function createServerAiRuntime(options: ServerAiRuntimeOptions = process.env): AiRuntime {
  const endpoint = options.endpoint?.trim() || options.AI_BASE_URL?.trim() || options.AI_MODEL_GATEWAY_URL?.trim();
  const secret = options.secret?.trim() || options.AI_API_KEY?.trim() || options.AI_MODEL_GATEWAY_SECRET?.trim();
  const explicitModel = options.model?.trim() || options.AI_MODEL_NAME?.trim();
  const fallback = new OfflineStructuredProvider();
  const purposes: AiPurpose[] = [
    'INTENT_PLANNER', 'RISK_CLASSIFIER', 'SUMMARY', 'KNOWLEDGE_EXTRACT', 'REPLY_GENERATION', 'IMAGE_ANALYSIS', 'QUALITY_JUDGE',
  ];
  const providers: Record<string, AiProvider> = { fallback };
  const routes: Partial<Record<AiPurpose, string[]>> = {};
  for (const purpose of purposes) {
    const model = explicitModel || modelForPurpose(options, purpose);
    if (endpoint && secret && model) {
      const key = `primary:${purpose}`;
      providers[key] = new JsonModelGatewayProvider({
        endpoint,
        secret,
        model,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      });
      // Intent and risk decide whether the system may act automatically. Once
      // an operator has configured their primary decision provider, silently
      // falling back to the demo's permissive synthetic result is unsafe.
      // Offline output remains available only when no primary route exists.
      routes[purpose] = purpose === 'INTENT_PLANNER' || purpose === 'RISK_CLASSIFIER'
        ? [key]
        : [key, 'fallback'];
    } else {
      routes[purpose] = ['fallback'];
    }
  }
  return new AiRuntime({
    providers,
    routes,
    defaultTimeoutMs: positiveInteger(options.AI_TIMEOUT_MS ?? options.AI_RUNTIME_TIMEOUT_MS, 8_000),
  });
}

function modelForPurpose(options: ServerAiRuntimeOptions, purpose: AiPurpose): string | undefined {
  if (purpose === 'IMAGE_ANALYSIS') return options.AI_MULTIMODAL_MODEL?.trim();
  if (purpose === 'QUALITY_JUDGE') return options.AI_JUDGE_MODEL?.trim() || options.AI_QUALITY_MODEL?.trim();
  if (purpose === 'REPLY_GENERATION') return options.AI_QUALITY_MODEL?.trim() || options.AI_FAST_MODEL?.trim();
  return options.AI_FAST_MODEL?.trim() || options.AI_QUALITY_MODEL?.trim();
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function offlineOutput(purpose: AiPurpose, input: unknown): unknown {
  switch (purpose) {
    case 'RISK_CLASSIFIER':
      return { riskLevel: 'LOW', reasons: [], recommendedMode: 'AUTO' };
    case 'IMAGE_ANALYSIS': {
      const encoded = readString(input, ['image', 'base64']) ?? '';
      const marker = safeDecode(encoded);
      if (marker.includes('AICS_FIXTURE:DAMAGED_SLEEVE')) {
        return { scene: 'PRODUCT_DAMAGE', observations: ['疑似商品破损'], confidence: 0.98, containsPII: false, recommendedIntent: 'AFTER_SALES_QUERY', requiresHuman: true };
      }
      if (marker.includes('AICS_FIXTURE:SHIPPING_LABEL')) {
        return { scene: 'SHIPPING_LABEL', observations: [], confidence: 0.98, containsPII: true, recommendedIntent: 'ORDER_QUERY', requiresHuman: true };
      }
      return { scene: 'UNKNOWN', observations: [], confidence: 0, containsPII: false, requiresHuman: true };
    }
    case 'SUMMARY': {
      const messages = readArray(input, 'messages');
      const text = messages.length > 0 ? '已整理本轮会话要点。' : '';
      return { narrativeSummary: text, activeTopic: 'UNKNOWN', activeProductId: null, activeOrderId: null, resolvedFacts: [], openQuestions: [], deprecatedFacts: [] };
    }
    case 'INTENT_PLANNER':
      return { tasks: [{ intent: 'UNKNOWN', riskLevel: 'LOW', requiredContext: [], requiredTools: [] }], summary: '' };
    case 'KNOWLEDGE_EXTRACT':
      return { question: '待人工审核', answer: '离线模式不自动生成知识。', scope: 'STORE', candidateType: 'NEW_KNOWLEDGE', shouldCreate: false, containsPII: false };
    case 'QUALITY_JUDGE':
      return { relevance: 0, completeness: 0, groundedness: 0, tone: 0, risk: 'LOW', result: 'NEEDS_HUMAN' };
    case 'REPLY_GENERATION':
      return { text: '', requiresHuman: true };
  }
}

function validUsage(value: unknown): value is { inputTokens: number; outputTokens: number } {
  return Boolean(value && typeof value === 'object' && Number.isSafeInteger((value as { inputTokens?: unknown }).inputTokens) && Number.isSafeInteger((value as { outputTokens?: unknown }).outputTokens));
}

function readString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function readArray(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate) ? candidate : [];
}

function safeDecode(value: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}
