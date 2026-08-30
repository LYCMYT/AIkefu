import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AiRuntime,
  AiRuntimeFailure,
  sanitizeContext,
  validateStructuredOutput,
  type AiPurpose,
  type StructuredOutputSchemaName,
} from '@ai-customer-service/core';
import {
  AIInvocationService,
} from './ai-invocation.service';
import type {
  AIInvocationEvidenceInput,
  AIInvocationScope,
} from './ai-invocation.repository';
import { WorkspaceGateway } from '../websocket/workspace.gateway';
import { getPromptDefinition } from './prompt-registry';
import { AiEvalFaultRegistry, AiEvalSimulatedCrash } from '../eval/ai-eval-fault-registry';

export const AI_RUNTIME = Symbol('AI_RUNTIME');

export type RunStructuredApplicationInput = {
  purpose: AiPurpose;
  schema: StructuredOutputSchemaName;
  context: Record<string, unknown>;
  allowedDataClasses: readonly string[];
  promptVersion: string;
  evidence?: readonly AIInvocationEvidenceInput[];
  ragStrategy?: string;
  contextVersion?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/**
 * Server-side boundary around the provider runtime. It is the only place that
 * sends application context to a model and it persists audit metadata without
 * storing prompts, raw provider diagnostics, credentials, or response text.
 */
@Injectable()
export class AiRuntimeApplicationService {
  constructor(
    @Inject(AI_RUNTIME) private readonly runtime: AiRuntime,
    private readonly invocations: AIInvocationService,
    @Optional() private readonly gateway?: WorkspaceGateway,
    @Optional() private readonly evalFaults?: AiEvalFaultRegistry,
  ) {}

  async runStructured<T = { riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; reasons: string[]; recommendedMode: 'AUTO' | 'ASSIST' | 'MANUAL' }>(scope: AIInvocationScope, input: RunStructuredApplicationInput): Promise<{
    output: T;
    provider: string;
    model: string;
    fallbackUsed: boolean;
    invocationId: string;
  }> {
    const startedAt = Date.now();
    const sanitized = sanitizeContext(input.context, input.allowedDataClasses);
    const evidence = cloneEvidence(input.evidence ?? []);
    const prompt = getPromptDefinition(input.purpose, input.promptVersion);
    const evalScenario = this.evalFaults?.consume(scope.workspaceId, input.purpose);
    if (evalScenario && evalScenario !== 'CRASH_ONCE') {
      await this.recordInjectedTimeout(scope, input, sanitized.audit, evidence, 'eval-primary-timeout');
      if (evalScenario === 'TOTAL_TIMEOUT') {
        await this.recordInjectedTimeout(scope, input, sanitized.audit, evidence, 'eval-fallback-timeout', true);
        throw new AiRuntimeFailure('TIMEOUT', 'Configured evaluation providers timed out');
      }
    }
    const invocation = await this.invocations.start(scope, {
      purpose: input.purpose,
      provider: 'unresolved',
      model: 'unresolved',
      promptVersion: input.promptVersion,
      ragStrategy: input.ragStrategy,
      fallbackUsed: false,
      contextVersion: input.contextVersion,
      includedDataClasses: sanitized.audit.includedDataClasses,
      excludedPII: sanitized.audit.excludedPII,
      evidence,
    });
    const invocationId = requireInvocationId(invocation);
    // The isolated production-eval restart case intentionally leaves this
    // durable RUNNING row and its GENERATING ReplyJob for recovery to claim.
    if (evalScenario === 'CRASH_ONCE') throw new AiEvalSimulatedCrash();

    try {
      const result = await this.runtime.runStructured<T>({
        purpose: input.purpose,
        input: sanitized.value,
        prompt,
        validate: (value: unknown): value is T => validateStructuredOutput(input.schema, value),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
      const durationMs = Date.now() - startedAt;
      const inputTokens = result.usage?.inputTokens ?? 0;
      const outputTokens = result.usage?.outputTokens ?? 0;
      await this.invocations.complete(scope, invocationId, {
        status: 'SUCCEEDED',
        durationMs,
        inputTokens,
        outputTokens,
        fallbackUsed: result.fallbackUsed || evalScenario === 'PRIMARY_TIMEOUT_FALLBACK_SUCCESS',
        provider: result.provider,
        model: result.model,
      });
      await this.invocations.recordUsage(scope, invocationId, {
        purpose: input.purpose,
        provider: result.provider,
        model: result.model,
        inputTokens,
        outputTokens,
        success: true,
        fallbackUsed: result.fallbackUsed || evalScenario === 'PRIMARY_TIMEOUT_FALLBACK_SUCCESS',
        durationMs,
      });
      this.publishUsage(scope, invocationId, input.purpose, result.provider, result.model, true);
      return {
        ...result,
        fallbackUsed: result.fallbackUsed || evalScenario === 'PRIMARY_TIMEOUT_FALLBACK_SUCCESS',
        invocationId,
      };
    } catch (error) {
      await this.recordFailure(scope, invocationId, input, startedAt, error);
      throw error;
    }
  }

  private async recordInjectedTimeout(
    scope: AIInvocationScope,
    input: RunStructuredApplicationInput,
    audit: ReturnType<typeof sanitizeContext>['audit'],
    evidence: AIInvocationEvidenceInput[],
    provider: string,
    fallbackUsed = false,
  ): Promise<void> {
    const invocation = await this.invocations.start(scope, {
      purpose: input.purpose, provider, model: 'unresolved', promptVersion: input.promptVersion,
      ragStrategy: input.ragStrategy, fallbackUsed, contextVersion: input.contextVersion,
      includedDataClasses: audit.includedDataClasses, excludedPII: audit.excludedPII, evidence,
    });
    const invocationId = requireInvocationId(invocation);
    await this.invocations.complete(scope, invocationId, {
      status: 'FAILED', durationMs: input.timeoutMs ?? 8_000, inputTokens: 0, outputTokens: 0,
      fallbackUsed, provider, model: 'unresolved',
    });
    await this.invocations.recordUsage(scope, invocationId, {
      purpose: input.purpose, provider, model: 'unresolved', inputTokens: 0, outputTokens: 0,
      success: false, fallbackUsed, durationMs: input.timeoutMs ?? 8_000, errorCode: 'TIMEOUT',
    });
    this.publishUsage(scope, invocationId, input.purpose, provider, 'unresolved', false);
  }

  private async recordFailure(
    scope: AIInvocationScope,
    invocationId: string,
    input: RunStructuredApplicationInput,
    startedAt: number,
    error: unknown,
  ): Promise<void> {
    const runtimeAudit = error instanceof AiRuntimeFailure ? error.audit : undefined;
    const durationMs = runtimeAudit?.durationMs ?? Date.now() - startedAt;
    const provider = runtimeAudit?.provider ?? 'unresolved';
    const model = runtimeAudit?.model ?? 'unresolved';
    const fallbackUsed = runtimeAudit?.fallbackUsed ?? false;
    const inputTokens = runtimeAudit?.tokenUsage?.inputTokens ?? 0;
    const outputTokens = runtimeAudit?.tokenUsage?.outputTokens ?? 0;
    const status = runtimeAudit?.status === 'ABORTED' || (error instanceof AiRuntimeFailure && error.code === 'ABORTED')
      ? 'ABORTED'
      : 'FAILED';
    const errorCode = error instanceof AiRuntimeFailure ? error.code : 'AI_RUNTIME_FAILED';

    // Preserve the original runtime failure if persistence itself is unavailable.
    try {
      await this.invocations.complete(scope, invocationId, {
        status,
        durationMs,
        inputTokens,
        outputTokens,
        fallbackUsed,
        provider,
        model,
      });
      await this.invocations.recordUsage(scope, invocationId, {
        purpose: input.purpose,
        provider,
        model,
        inputTokens,
        outputTokens,
        success: false,
        fallbackUsed,
        durationMs,
        errorCode,
      });
      this.publishUsage(scope, invocationId, input.purpose, provider, model, false);
    } catch {
      // An audit outage must not replace the stable runtime failure presented to
      // the caller. Operational monitoring owns reporting the persistence error.
    }
  }

  private publishUsage(
    scope: AIInvocationScope,
    invocationId: string,
    purpose: AiPurpose,
    provider: string,
    model: string,
    success: boolean,
  ): void {
    try {
      this.gateway?.publish({
        eventId: randomUUID(),
        eventType: 'USAGE_UPDATED',
        workspaceId: scope.workspaceId,
        entityType: 'USAGE',
        entityId: invocationId,
        entityVersion: 1,
        occurredAt: new Date().toISOString(),
        payload: {
          workspaceId: scope.workspaceId,
          summary: { invocationId, purpose, provider, model, success },
        },
      });
    } catch {
      // WebSocket refresh is advisory; the durable usage ledger is canonical.
    }
  }
}

function cloneEvidence(evidence: readonly AIInvocationEvidenceInput[]): AIInvocationEvidenceInput[] {
  return evidence.map((entry) => ({
    ...entry,
    productId: entry.productId ?? null,
    contentSnapshot: {
      question: entry.contentSnapshot.question,
      answer: entry.contentSnapshot.answer,
    },
  }));
}

function requireInvocationId(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && value.id) {
    return value.id;
  }
  throw new Error('AI invocation repository did not return an id');
}
