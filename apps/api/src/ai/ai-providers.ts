import { readFileSync } from 'node:fs';

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
  | 'AI_PROVIDER'
  | 'AI_BASE_URL'
  | 'AI_API_KEY'
  | 'AI_API_KEY_FILE'
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

type DeepSeekChatCompletion = {
  choices?: Array<{ message?: { content?: unknown } }>;
  model?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

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

/**
 * DeepSeek's OpenAI-compatible Chat Completions boundary. The provider keeps
 * credentials in the Authorization header and asks for JSON mode; AiRuntime
 * remains the final authority that validates and, at most once, repairs the
 * purpose-specific structured output.
 */
export class DeepSeekJsonProvider implements AiProvider {
  readonly name = 'deepseek-openai-chat';
  private readonly fetcher: FetchLike;
  private readonly endpoint: string;

  constructor(private readonly options: JsonModelGatewayOptions) {
    this.endpoint = normalizeDeepSeekEndpoint(options.endpoint);
    if (!options.secret?.trim() || !options.model?.trim()) throw new Error('AI_GATEWAY_CONFIGURATION_INVALID');
    this.fetcher = options.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  }

  async invoke(request: AiProviderRequest): Promise<AiProviderResponse> {
    if (request.signal.aborted) throw abortedProviderFailure(request.signal);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: 'system', content: deepSeekSystemPrompt(request.purpose) },
            {
              role: 'user',
              content: JSON.stringify({
                input: request.input,
                repair: request.repair,
                ...(request.previousOutput === undefined ? {} : { previousOutput: request.previousOutput }),
              }),
            },
          ],
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
          temperature: 0,
          max_tokens: 2_048,
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
    let payload: DeepSeekChatCompletion;
    try {
      payload = await response.json() as DeepSeekChatCompletion;
    } catch (error) {
      throw new AiProviderFailure('RESPONSE', false, 'AI_GATEWAY_RESPONSE_INVALID', { cause: error });
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new AiProviderFailure('RESPONSE', false, 'AI_GATEWAY_RESPONSE_INVALID');
    }
    let output: unknown;
    try {
      output = JSON.parse(content);
    } catch (error) {
      throw new AiProviderFailure('RESPONSE', false, 'AI_GATEWAY_RESPONSE_INVALID', { cause: error });
    }
    return {
      output,
      model: typeof payload.model === 'string' && payload.model ? payload.model : this.options.model,
      ...(deepSeekUsage(payload.usage) ? { usage: deepSeekUsage(payload.usage) } : {}),
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
  const providerKind = options.AI_PROVIDER?.trim().toLowerCase();
  const endpoint = options.endpoint?.trim()
    || options.AI_BASE_URL?.trim()
    || options.AI_MODEL_GATEWAY_URL?.trim()
    || (providerKind === 'deepseek' ? 'https://api.deepseek.com' : undefined);
  const secret = options.secret?.trim()
    || options.AI_API_KEY?.trim()
    || options.AI_MODEL_GATEWAY_SECRET?.trim()
    || readSecretFile(options.AI_API_KEY_FILE);
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
      providers[key] = providerKind === 'deepseek' ? new DeepSeekJsonProvider({
        endpoint,
        secret,
        model,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      }) : new JsonModelGatewayProvider({
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

function normalizeDeepSeekEndpoint(rawEndpoint: string): string {
  const endpoint = new URL(rawEndpoint);
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
    throw new Error('AI_GATEWAY_HTTPS_REQUIRED');
  }
  if (endpoint.pathname === '/' || endpoint.pathname === '') endpoint.pathname = '/chat/completions';
  return endpoint.toString();
}

function readSecretFile(path: string | undefined): string | undefined {
  if (!path?.trim()) return undefined;
  let secret: string;
  try {
    secret = readFileSync(path.trim(), 'utf8').trim();
  } catch {
    throw new Error('AI_API_KEY_FILE_INVALID');
  }
  if (!secret || /[\r\n]/.test(secret)) throw new Error('AI_API_KEY_FILE_INVALID');
  return secret;
}

function deepSeekUsage(value: DeepSeekChatCompletion['usage']): AiProviderResponse['usage'] | undefined {
  if (!value || !Number.isSafeInteger(value.prompt_tokens) || Number(value.prompt_tokens) < 0
    || !Number.isSafeInteger(value.completion_tokens) || Number(value.completion_tokens) < 0) return undefined;
  return { inputTokens: Number(value.prompt_tokens), outputTokens: Number(value.completion_tokens) };
}

function deepSeekSystemPrompt(purpose: AiPurpose): string {
  return [
    'You are a structured JSON component in a customer-service safety system.',
    'Return exactly one JSON object and no markdown, prose, or chain-of-thought.',
    'Do not invent inventory, price, order, logistics, identity, or payment facts.',
    'When evidence is missing or risk is uncertain, choose the conservative human/manual outcome.',
    `Purpose: ${purpose}.`,
    `Example JSON shape: ${JSON.stringify(exampleForPurpose(purpose))}`,
  ].join(' ');
}

function exampleForPurpose(purpose: AiPurpose): Record<string, unknown> {
  switch (purpose) {
    case 'INTENT_PLANNER':
      return { tasks: [{ intent: 'UNKNOWN', riskLevel: 'MEDIUM', requiredContext: [], requiredKnowledge: [], requiredTools: ['TRANSFER_HUMAN'] }], summary: '' };
    case 'RISK_CLASSIFIER':
      return { riskLevel: 'MEDIUM', reasons: ['insufficient evidence'], recommendedMode: 'ASSIST', sensitiveIntent: false };
    case 'SUMMARY':
      return { narrativeSummary: '', activeTopic: '', activeProductId: null, activeOrderId: null, resolvedFacts: [], openQuestions: [], deprecatedFacts: [] };
    case 'KNOWLEDGE_EXTRACT':
      return { question: '', answer: '', scope: 'STORE', candidateType: 'NEW_KNOWLEDGE', shouldCreate: false, rejectionReason: 'insufficient evidence', containsTemporaryCommitment: false, containsPII: false };
    case 'REPLY_GENERATION':
      return { text: '', requiresHuman: true };
    case 'IMAGE_ANALYSIS':
      return { scene: 'UNKNOWN', observations: [], confidence: 0, containsPII: false, requiresHuman: true };
    case 'QUALITY_JUDGE':
      return { relevance: 0, completeness: 0, groundedness: 0, tone: 0, risk: 'MEDIUM', result: 'NEEDS_HUMAN', reasons: ['insufficient evidence'] };
  }
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
      return offlineIntentPlan(readString(input, ['turn', 'text']) ?? readString(input, ['text']) ?? '');
    case 'KNOWLEDGE_EXTRACT':
      return { question: '待人工审核', answer: '离线模式不自动生成知识。', scope: 'STORE', candidateType: 'NEW_KNOWLEDGE', shouldCreate: false, containsPII: false };
    case 'QUALITY_JUDGE':
      return { relevance: 0, completeness: 0, groundedness: 0, tone: 0, risk: 'LOW', result: 'NEEDS_HUMAN' };
    case 'REPLY_GENERATION':
      return { text: '', requiresHuman: true };
  }
}

function offlineIntentPlan(text: string): Record<string, unknown> {
  const normalized = text.trim();
  const tasks: Array<Record<string, unknown>> = [];
  const inventoryRequested = /库存|有货|还有|还剩|现货|缺货|售罄|(?:黑色|白色|红色|蓝色|绿色|灰色).{0,8}(?:有吗|有么|有货)/i.test(normalized);
  const sizeRequested = /尺码|尺寸|大小|身高|体重|公斤|(?:^|\s)(?:XXL|XL|XS|L|M|S)(?:\s|呢|吗|？|\?|$)/i.test(normalized);

  if (inventoryRequested) {
    tasks.push({
      intent: 'INVENTORY_QUERY',
      riskLevel: 'LOW',
      requiredContext: ['PRODUCT', 'SKU'],
      requiredTools: ['GET_INVENTORY'],
    });
  }
  if (sizeRequested) {
    tasks.push({
      intent: 'SIZE_RECOMMENDATION',
      riskLevel: 'LOW',
      requiredContext: ['PRODUCT', 'SKU', 'CUSTOMER_MEMORY'],
      requiredTools: ['GET_PRODUCT'],
    });
  }
  if (tasks.length === 0) {
    return { tasks: [{ intent: 'UNKNOWN', riskLevel: 'LOW', requiredContext: [], requiredTools: [] }], summary: '' };
  }
  return {
    tasks,
    summary: inventoryRequested && sizeRequested ? '库存与尺码咨询' : inventoryRequested ? '库存咨询' : '尺码咨询',
  };
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
