export type AiPurpose =
  | 'INTENT_PLANNER'
  | 'RISK_CLASSIFIER'
  | 'SUMMARY'
  | 'KNOWLEDGE_EXTRACT'
  | 'REPLY_GENERATION'
  | 'IMAGE_ANALYSIS'
  | 'QUALITY_JUDGE';

export type AiProviderRequest = {
  purpose: AiPurpose;
  input: unknown;
  prompt?: AiPrompt;
  signal: AbortSignal;
  attempt: number;
  repair: boolean;
  previousOutput?: unknown;
};

export type AiPrompt = Readonly<{
  version: string;
  system: string;
  instructions: string;
}>;

export type AiProviderResponse = {
  output: unknown;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
};

export interface AiProvider {
  readonly name: string;
  invoke(request: AiProviderRequest): Promise<AiProviderResponse>;
}

export class AiProviderFailure extends Error {
  readonly status: number | undefined;

  constructor(
    readonly kind: 'NETWORK' | 'HTTP' | 'RESPONSE' | 'ABORTED',
    readonly retryable: boolean,
    message: string,
    options?: ErrorOptions & { status?: number },
  ) {
    super(message, options);
    this.name = 'AiProviderFailure';
    this.status = options?.status;
  }
}

export type AiRuntimeUsage = Readonly<{
  purpose: AiPurpose;
  provider: string | null;
  model: string | null;
  fallbackUsed: boolean;
  durationMs: number;
  status: 'SUCCEEDED' | 'FAILED' | 'ABORTED';
  tokenUsage: { inputTokens: number; outputTokens: number } | null;
}>;

function immutableUsage(usage: AiRuntimeUsage): AiRuntimeUsage {
  return Object.freeze({
    purpose: usage.purpose,
    provider: usage.provider,
    model: usage.model,
    fallbackUsed: usage.fallbackUsed,
    durationMs: usage.durationMs,
    status: usage.status,
    tokenUsage: usage.tokenUsage ? Object.freeze({ ...usage.tokenUsage }) : null,
  }) as AiRuntimeUsage;
}

export class AiRuntimeFailure extends Error {
  private auditMetadata: AiRuntimeUsage | undefined;

  constructor(
    readonly code: 'NO_ROUTE' | 'TIMEOUT' | 'PROVIDER_FAILED' | 'SCHEMA_INVALID' | 'ABORTED' | 'CIRCUIT_OPEN',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AiRuntimeFailure';
  }

  /** Safe, invocation-scoped metadata only; it never contains model input or output. */
  get audit(): AiRuntimeUsage | undefined {
    return this.auditMetadata;
  }

  withAudit(audit: AiRuntimeUsage): this {
    this.auditMetadata = immutableUsage(audit);
    return this;
  }
}

type RouteTable = Partial<Record<AiPurpose, readonly string[]>>;
type CircuitState = { consecutiveFailures: number; openedAt?: number };

export class AiRuntime {
  private readonly logs: AiRuntimeUsage[] = [];
  private readonly circuits = new Map<string, CircuitState>();
  private readonly usageLogLimit: number;

  constructor(
    private readonly options: {
      providers: Record<string, AiProvider>;
      routes: RouteTable;
      defaultTimeoutMs?: number;
      circuitFailureThreshold?: number;
      circuitResetMs?: number;
      usageLogLimit?: number;
    },
  ) {
    this.usageLogLimit = Number.isSafeInteger(options.usageLogLimit) && (options.usageLogLimit ?? -1) >= 0
      ? options.usageLogLimit!
      : 1_000;
  }

  usageLog(): readonly AiRuntimeUsage[] {
    return this.logs.map((entry) => ({ ...entry, tokenUsage: entry.tokenUsage ? { ...entry.tokenUsage } : null }));
  }

  async runStructured<T>(request: {
    purpose: AiPurpose;
    input: unknown;
    prompt?: AiPrompt;
    validate: (value: unknown) => value is T;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<{
    output: T;
    provider: string;
    model: string;
    fallbackUsed: boolean;
    usage: AiProviderResponse['usage'];
  }> {
    const startedAt = Date.now();
    const route = this.options.routes[request.purpose] ?? [];
    let usedProvider: string | null = null;
    let usedModel: string | null = null;
    let fallbackUsed = false;
    let tokenUsage: AiProviderResponse['usage'];
    let finalStatus: AiRuntimeUsage['status'] = 'FAILED';
    let terminalFailure: AiRuntimeFailure | undefined;
    try {
      if (route.length === 0) throw new AiRuntimeFailure('NO_ROUTE', `No provider route for ${request.purpose}`);
      let lastFailure: AiRuntimeFailure | undefined;
      for (let providerIndex = 0; providerIndex < Math.min(route.length, 2); providerIndex += 1) {
        const providerName = route[providerIndex]!;
        const provider = this.options.providers[providerName];
        if (!provider) {
          lastFailure = new AiRuntimeFailure('NO_ROUTE', `Provider ${providerName} is not configured`);
          continue;
        }
        usedProvider = provider.name;
        fallbackUsed = providerIndex > 0;
        try {
          this.assertCircuit(providerName);
          let response = await this.invokeWithRetry(provider, request, request.timeoutMs);
          usedModel = response.model;
          tokenUsage = response.usage;
          if (!request.validate(response.output)) {
            response = await this.invokeOnce(
              provider,
              {
                ...request,
                repair: true,
                previousOutput: response.output,
                attempt: 1,
              },
              request.timeoutMs,
            );
            usedModel = response.model;
            tokenUsage = response.usage;
            if (!request.validate(response.output)) {
              throw new AiRuntimeFailure('SCHEMA_INVALID', `${request.purpose} output failed schema validation after repair`);
            }
          }
          this.recordSuccess(providerName);
          finalStatus = 'SUCCEEDED';
          return {
            output: response.output,
            provider: provider.name,
            model: response.model,
            fallbackUsed,
            usage: response.usage,
          };
        } catch (error) {
          const failure = this.normalizeFailure(error, request.signal);
          if (failure.code === 'ABORTED') {
            finalStatus = 'ABORTED';
            throw failure;
          }
          this.recordFailure(providerName);
          lastFailure = failure;
          if (failure.code === 'SCHEMA_INVALID' && route.length === 1) throw failure;
        }
      }
      throw lastFailure ?? new AiRuntimeFailure('PROVIDER_FAILED', `${request.purpose} failed without a provider response`);
    } catch (error) {
      const failure = this.normalizeFailure(error, request.signal);
      terminalFailure = failure;
      throw failure;
    } finally {
      const audit = immutableUsage({
        purpose: request.purpose,
        provider: usedProvider,
        model: usedModel,
        fallbackUsed,
        durationMs: Date.now() - startedAt,
        status: finalStatus,
        tokenUsage: tokenUsage ? { ...tokenUsage } : null,
      });
      this.recordUsage(audit);
      terminalFailure?.withAudit(audit);
    }
  }

  private async invokeWithRetry(
    provider: AiProvider,
    request: { purpose: AiPurpose; input: unknown; prompt?: AiPrompt; signal?: AbortSignal },
    timeoutMs?: number,
  ): Promise<AiProviderResponse> {
    let failure: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.invokeOnce(provider, { ...request, attempt, repair: false }, timeoutMs);
      } catch (error) {
        failure = error;
        if (!this.shouldRetry(error, request.signal)) throw error;
      }
    }
    throw failure;
  }

  private async invokeOnce(
    provider: AiProvider,
    request: {
      purpose: AiPurpose;
      input: unknown;
      prompt?: AiPrompt;
      signal?: AbortSignal;
      attempt: number;
      repair: boolean;
      previousOutput?: unknown;
    },
    timeoutMs?: number,
  ): Promise<AiProviderResponse> {
    const controller = new AbortController();
    const effectiveTimeout = timeoutMs ?? this.options.defaultTimeoutMs ?? 8_000;
    const onCallerAbort = () => controller.abort(request.signal?.reason ?? new Error('aborted'));
    if (request.signal?.aborted) onCallerAbort();
    else request.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new AiRuntimeFailure('TIMEOUT', `${provider.name} timed out`)), effectiveTimeout);
    let onEffectiveAbort: (() => void) | undefined;
    try {
      const invocation = provider.invoke({
        purpose: request.purpose,
        input: request.input,
        ...(request.prompt ? { prompt: request.prompt } : {}),
        signal: controller.signal,
        attempt: request.attempt,
        repair: request.repair,
        ...(request.previousOutput === undefined ? {} : { previousOutput: request.previousOutput }),
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        onEffectiveAbort = () => {
          const reason = controller.signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new AiRuntimeFailure('ABORTED', `${provider.name} invocation was aborted`),
          );
        };
        if (controller.signal.aborted) onEffectiveAbort();
        else controller.signal.addEventListener('abort', onEffectiveAbort, { once: true });
      });
      return await Promise.race([invocation, deadline]);
    } finally {
      clearTimeout(timer);
      if (onEffectiveAbort) controller.signal.removeEventListener('abort', onEffectiveAbort);
      request.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private normalizeFailure(error: unknown, callerSignal?: AbortSignal): AiRuntimeFailure {
    if (callerSignal?.aborted) return new AiRuntimeFailure('ABORTED', 'AI call aborted because its context became stale', { cause: error });
    if (error instanceof AiRuntimeFailure) return error;
    return new AiRuntimeFailure('PROVIDER_FAILED', error instanceof Error ? error.message : String(error), { cause: error });
  }

  private shouldRetry(error: unknown, callerSignal?: AbortSignal): boolean {
    if (callerSignal?.aborted) return false;
    if (error instanceof AiProviderFailure) return error.retryable;
    return error instanceof AiRuntimeFailure && error.code === 'TIMEOUT';
  }

  private recordUsage(audit: AiRuntimeUsage): void {
    if (this.usageLogLimit === 0) return;
    this.logs.push(audit);
    const overflow = this.logs.length - this.usageLogLimit;
    if (overflow > 0) this.logs.splice(0, overflow);
  }

  private assertCircuit(providerName: string): void {
    const state = this.circuits.get(providerName);
    if (!state?.openedAt) return;
    if (Date.now() - state.openedAt >= (this.options.circuitResetMs ?? 30_000)) {
      this.circuits.delete(providerName);
      return;
    }
    throw new AiRuntimeFailure('CIRCUIT_OPEN', `${providerName} circuit is open`);
  }

  private recordFailure(providerName: string): void {
    const state = this.circuits.get(providerName) ?? { consecutiveFailures: 0 };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 3)) state.openedAt = Date.now();
    this.circuits.set(providerName, state);
  }

  private recordSuccess(providerName: string): void {
    this.circuits.delete(providerName);
  }
}
