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

    try {
      const result = await this.runtime.runStructured<T>({
        purpose: input.purpose,
        input: sanitized.value,
        validate: (value: unknown): value is T => validateStructuredOutput(input.schema, value),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
      const durationMs = Date.now() - startedAt;
      const invocation = await this.invocations.start(scope, {
        purpose: input.purpose,
        provider: result.provider,
        model: result.model,
        promptVersion: input.promptVersion,
        ragStrategy: input.ragStrategy,
        fallbackUsed: result.fallbackUsed,
        contextVersion: input.contextVersion,
        includedDataClasses: sanitized.audit.includedDataClasses,
        excludedPII: sanitized.audit.excludedPII,
        evidence,
      });
      const invocationId = requireInvocationId(invocation);
      const inputTokens = result.usage?.inputTokens ?? 0;
      const outputTokens = result.usage?.outputTokens ?? 0;
      await this.invocations.complete(scope, invocationId, {
        status: 'SUCCEEDED',
        durationMs,
        inputTokens,
        outputTokens,
        fallbackUsed: result.fallbackUsed,
      });
      await this.invocations.recordUsage(scope, invocationId, {
        purpose: input.purpose,
        provider: result.provider,
        model: result.model,
        inputTokens,
        outputTokens,
        success: true,
        fallbackUsed: result.fallbackUsed,
        durationMs,
      });
      this.publishUsage(scope, invocationId, input.purpose, result.provider, result.model, true);
      return { ...result, invocationId };
    } catch (error) {
      await this.recordFailure(scope, input, sanitized.audit, evidence, startedAt, error);
      throw error;
    }
  }

  private async recordFailure(
    scope: AIInvocationScope,
    input: RunStructuredApplicationInput,
    audit: ReturnType<typeof sanitizeContext>['audit'],
    evidence: AIInvocationEvidenceInput[],
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
      const invocation = await this.invocations.start(scope, {
        purpose: input.purpose,
        provider,
        model,
        promptVersion: input.promptVersion,
        ragStrategy: input.ragStrategy,
        fallbackUsed,
        contextVersion: input.contextVersion,
        includedDataClasses: audit.includedDataClasses,
        excludedPII: audit.excludedPII,
        evidence,
      });
      const invocationId = requireInvocationId(invocation);
      await this.invocations.complete(scope, invocationId, {
        status,
        durationMs,
        inputTokens,
        outputTokens,
        fallbackUsed,
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
