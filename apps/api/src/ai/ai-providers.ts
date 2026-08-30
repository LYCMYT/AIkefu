import { readFileSync } from 'node:fs';

import {
  AiProviderFailure,
  AiRuntime,
  inferExplicitIntentTasks,
  type AiProvider,
  type AiProviderRequest,
  type AiProviderResponse,
  type AiPurpose,
} from '@ai-customer-service/core';

type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status?: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export type JsonModelGatewayOptions = {
  endpoint: string;
  /** Supplied by server configuration only; never placed in a request body or audit row. */
  secret: string;
  model: string;
  fetcher?: FetchLike;
};

export type OpenAICompatibleOptions = JsonModelGatewayOptions & {
  apiStyle?: 'chat-completions' | 'responses';
};

type ServerAiRuntimeOptions = Partial<JsonModelGatewayOptions> & Partial<Record<
  | 'AI_PROVIDER'
  | 'AI_API_STYLE'
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
  | 'AI_OFFLINE_MODE'
  | 'AI_RUNTIME_TIMEOUT_MS'
  | 'NODE_ENV',
  string
>>;

type DeepSeekChatCompletion = {
  choices?: Array<{ message?: { content?: unknown } }>;
  model?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

type OpenAIResponsesPayload = {
  output_text?: unknown;
  output?: Array<{ content?: Array<{ text?: unknown }> }>;
  model?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
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
          ...(request.prompt ? { prompt: request.prompt } : {}),
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
      throw new AiProviderFailure('HTTP', isRetryableHttpStatus(status), `AI_GATEWAY_HTTP_${status}`, {
        status, retryAfterMs: retryAfterMilliseconds(response.headers?.get('retry-after')),
      });
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
 * Direct, explicit OpenAI-compatible boundary. It supports both the common
 * Chat Completions JSON mode and the Responses JSON-object shape; it is never
 * selected as an implicit fallback for the custom gateway contract.
 */
export class OpenAICompatibleProvider implements AiProvider {
  readonly name = 'openai-compatible-json';
  private readonly fetcher: FetchLike;
  private readonly endpoint: string;
  private readonly apiStyle: 'chat-completions' | 'responses';

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.apiStyle = options.apiStyle ?? (new URL(options.endpoint).pathname.endsWith('/responses') ? 'responses' : 'chat-completions');
    this.endpoint = normalizeOpenAICompatibleEndpoint(options.endpoint, this.apiStyle);
    if (!options.secret?.trim() || !options.model?.trim()) throw new Error('AI_PROVIDER_CONFIGURATION_INVALID');
    this.fetcher = options.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  }

  async invoke(request: AiProviderRequest): Promise<AiProviderResponse> {
    if (request.signal.aborted) throw abortedProviderFailure(request.signal);
    const system = request.prompt?.system ?? deepSeekSystemPrompt(request.purpose);
    const instructions = request.prompt?.instructions ?? 'Return one valid JSON object.';
    const providerInput = JSON.stringify({
      promptVersion: request.prompt?.version,
      instructions,
      input: request.input,
      repair: request.repair,
      ...(request.previousOutput === undefined ? {} : { previousOutput: request.previousOutput }),
    });
    const body = this.apiStyle === 'responses'
      ? {
          model: this.options.model,
          instructions: system,
          input: providerInput,
          text: { format: { type: 'json_object' } },
          store: false,
        }
      : {
          model: this.options.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: providerInput }],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 2_048,
        };
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw abortedProviderFailure(request.signal, error);
      throw new AiProviderFailure('NETWORK', true, 'AI_PROVIDER_NETWORK_ERROR', { cause: error });
    }
    if (!response.ok) {
      const status = response.status ?? 0;
      throw new AiProviderFailure('HTTP', isRetryableHttpStatus(status), `AI_PROVIDER_HTTP_${status}`, {
        status, retryAfterMs: retryAfterMilliseconds(response.headers?.get('retry-after')),
      });
    }
    let payload: DeepSeekChatCompletion | OpenAIResponsesPayload;
    try {
      payload = await response.json() as DeepSeekChatCompletion | OpenAIResponsesPayload;
    } catch (error) {
      throw new AiProviderFailure('RESPONSE', false, 'AI_PROVIDER_RESPONSE_INVALID', { cause: error });
    }
    const content = this.apiStyle === 'responses'
      ? responseText(payload as OpenAIResponsesPayload)
      : (payload as DeepSeekChatCompletion).choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new AiProviderFailure('RESPONSE', false, 'AI_PROVIDER_RESPONSE_INVALID');
    let output: unknown;
    try { output = JSON.parse(content); } catch (error) {
      throw new AiProviderFailure('RESPONSE', false, 'AI_PROVIDER_RESPONSE_INVALID', { cause: error });
    }
    const usage = this.apiStyle === 'responses'
      ? responsesUsage((payload as OpenAIResponsesPayload).usage)
      : deepSeekUsage((payload as DeepSeekChatCompletion).usage);
    return {
      output,
      model: typeof payload.model === 'string' && payload.model ? payload.model : this.options.model,
      ...(usage ? { usage } : {}),
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
            { role: 'system', content: request.prompt?.system ?? deepSeekSystemPrompt(request.purpose) },
            {
              role: 'user',
              content: JSON.stringify({
                input: request.input,
                promptVersion: request.prompt?.version,
                instructions: request.prompt?.instructions,
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
      throw new AiProviderFailure('HTTP', isRetryableHttpStatus(status), `AI_GATEWAY_HTTP_${status}`, {
        status, retryAfterMs: retryAfterMilliseconds(response.headers?.get('retry-after')),
      });
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
  const allowOffline = options.AI_OFFLINE_MODE === '1' || options.NODE_ENV !== 'production';
  const fallback = new OfflineStructuredProvider();
  const purposes: AiPurpose[] = [
    'INTENT_PLANNER', 'RISK_CLASSIFIER', 'SUMMARY', 'KNOWLEDGE_EXTRACT', 'REPLY_GENERATION', 'IMAGE_ANALYSIS', 'QUALITY_JUDGE',
  ];
  const providers: Record<string, AiProvider> = allowOffline ? { fallback } : {};
  const routes: Partial<Record<AiPurpose, string[]>> = {};
  for (const purpose of purposes) {
    const model = explicitModel || modelForPurpose(options, purpose);
    if (endpoint && secret && model) {
      const key = `primary:${purpose}`;
      const providerOptions = { endpoint, secret, model, ...(options.fetcher ? { fetcher: options.fetcher } : {}) };
      if (providerKind === 'deepseek') {
        providers[key] = new DeepSeekJsonProvider(providerOptions);
      } else if (providerKind === 'openai-compatible' || providerKind === 'openai' || providerKind === 'responses') {
        const apiStyle = providerKind === 'responses' || options.AI_API_STYLE?.trim().toLowerCase() === 'responses'
          ? 'responses' as const
          : 'chat-completions' as const;
        providers[key] = new OpenAICompatibleProvider({ ...providerOptions, apiStyle });
      } else if (providerKind === 'json-gateway' || providerKind === 'custom-gateway' || (!providerKind && options.endpoint)) {
        providers[key] = new JsonModelGatewayProvider(providerOptions);
      } else {
        // AI_BASE_URL is intentionally not guessed. A vendor-compatible API
        // and AIkefu's custom structured gateway have different wire formats.
        throw new Error('AI_PROVIDER_REQUIRED_FOR_CONFIGURED_ENDPOINT');
      }
      // A configured real provider never falls back to a synthetic answer.
      // A second provider may be added explicitly in the future, but it must
      // be another audited real provider rather than the demo fixture.
      routes[purpose] = [key];
    } else {
      if (!allowOffline) throw new Error('AI_PROVIDER_CONFIGURATION_REQUIRED');
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

function retryAfterMilliseconds(value: string | null | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function normalizeOpenAICompatibleEndpoint(rawEndpoint: string, style: 'chat-completions' | 'responses'): string {
  const endpoint = new URL(rawEndpoint);
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
    throw new Error('AI_GATEWAY_HTTPS_REQUIRED');
  }
  if (endpoint.pathname === '/' || endpoint.pathname === '') endpoint.pathname = style === 'responses' ? '/v1/responses' : '/v1/chat/completions';
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

function responsesUsage(value: OpenAIResponsesPayload['usage']): AiProviderResponse['usage'] | undefined {
  if (!value || !Number.isSafeInteger(value.input_tokens) || Number(value.input_tokens) < 0
    || !Number.isSafeInteger(value.output_tokens) || Number(value.output_tokens) < 0) return undefined;
  return { inputTokens: Number(value.input_tokens), outputTokens: Number(value.output_tokens) };
}

function responseText(value: OpenAIResponsesPayload): unknown {
  if (typeof value.output_text === 'string') return value.output_text;
  for (const item of value.output ?? []) {
    for (const content of item.content ?? []) if (typeof content.text === 'string') return content.text;
  }
  return undefined;
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
  if (purpose === 'IMAGE_ANALYSIS') return options.AI_MULTIMODAL_MODEL?.trim() || options.AI_QUALITY_MODEL?.trim() || options.AI_FAST_MODEL?.trim();
  if (purpose === 'QUALITY_JUDGE') return options.AI_JUDGE_MODEL?.trim() || options.AI_QUALITY_MODEL?.trim() || options.AI_FAST_MODEL?.trim();
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
      return offlineReplyGeneration(input);
  }
}

/**
 * The offline demo may join facts already produced by scoped resolvers or
 * frozen Evidence, but it must never invent a missing answer.  Partial work
 * stays in the human-review lane and names the unresolved customer need.
 */
function offlineReplyGeneration(input: unknown): { text: string; requiresHuman: boolean } {
  const tasks = readArray(input, 'tasks').map(objectRecord);
  const replies = [...new Set(tasks.flatMap((task) => {
    if (task.status !== 'RESOLVED') return [];
    const reply = readString(task.facts, ['reply'])?.trim();
    return reply ? [reply] : [];
  }))];
  const unresolved = tasks.filter((task) => task.status !== 'RESOLVED');
  if (!replies.length) {
    const product = offlineWorkflowProducts(input).find((entry) => (
      entry.recommendable === true
      && entry.status === 'ON_SHELF'
      && typeof entry.title === 'string'
      && entry.title.trim().length > 0
    ));
    if (product && typeof product.title === 'string') {
      return { text: `为你推荐 ${product.title.trim()}。`, requiresHuman: false };
    }
    const topic = customerQuestionTopic(readString(input, ['turn', 'text']) ?? '');
    return {
      text: `关于“${topic}”，暂时没有找到可靠依据，已转入人工确认。`,
      requiresHuman: true,
    };
  }
  if (!unresolved.length) return { text: replies.join('\n'), requiresHuman: false };
  const unresolvedLabels = [...new Set(unresolved.map((task) => offlineIntentLabel(typeof task.intent === 'string' ? task.intent : 'UNKNOWN')))];
  return {
    text: [...replies, `${unresolvedLabels.join('、')}还需要人工确认。`].join('\n'),
    requiresHuman: true,
  };
}

function customerQuestionTopic(value: string): string {
  const sanitized = value.normalize('NFKC')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/(?:system\s*prompt|developer\s*message|系统提示词|开发者消息)/giu, '')
    .replace(/^(?:(?:你好|您好|请问|想问一下|问一下|你们|这里|是否|可以|支持|有没有)[，,\s]*)+/u, '')
    .replace(/[吗呢呀啊？?!！。．]+$/gu, '')
    .trim();
  if (!sanitized || /(?:^|\D)1[3-9]\d{9}(?:\D|$)|\b\d{17}[\dXx]\b|@/u.test(sanitized)) return '这个问题';
  return sanitized.slice(0, 32);
}

function offlineWorkflowProducts(input: unknown): Record<string, unknown>[] {
  const workflow = objectRecord(objectRecord(input).workflow);
  const priorNodeOutputs = objectRecord(workflow.priorNodeOutputs);
  return Object.values(priorNodeOutputs).flatMap((output) => {
    const products = objectRecord(output).products;
    return Array.isArray(products) ? products.map(objectRecord) : [];
  });
}

function offlineIntentLabel(intent: string): string {
  const labels: Record<string, string> = {
    SIZE_RECOMMENDATION: '尺码建议',
    PRODUCT_RECOMMENDATION: '商品推荐',
    LOGISTICS_QUERY: '物流信息',
    ORDER_QUERY: '订单信息',
    SHIPPING_POLICY: '发货时效',
    AFTER_SALES_QUERY: '售后问题',
  };
  return labels[intent] ?? '其余问题';
}

function offlineIntentPlan(text: string): Record<string, unknown> {
  const tasks = inferExplicitIntentTasks(text);
  if (tasks.length === 0) {
    return { tasks: [{ intent: 'UNKNOWN', riskLevel: 'LOW', requiredContext: [], requiredTools: [] }], summary: '' };
  }
  const intents = tasks.map((task) => task.intent);
  const summary = intents.length === 2 && intents.includes('INVENTORY_QUERY') && intents.includes('SIZE_RECOMMENDATION')
    ? '库存与尺码咨询'
    : intents.length === 1 && intents[0] === 'INVENTORY_QUERY'
      ? '库存咨询'
      : intents.length === 1 && intents[0] === 'SIZE_RECOMMENDATION'
        ? '尺码咨询'
        : intents.join(',');
  return {
    tasks,
    summary,
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

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeDecode(value: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}
