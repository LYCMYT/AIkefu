import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  AI_INVOCATION_REPOSITORY,
  type AIInvocationEvidenceInput,
  type AIInvocationRepository,
  type AIInvocationScope,
  type CompleteAIInvocationInput,
  type RecordAIUsageInput,
  type StartAIInvocationInput,
} from './ai-invocation.repository';

export { AI_INVOCATION_REPOSITORY } from './ai-invocation.repository';

/**
 * Stable runtime-facing audit API. It deliberately accepts metadata and frozen
 * evidence only: full prompts, raw message bodies, provider credentials, and
 * response text have no field in this boundary.
 */
@Injectable()
export class AIInvocationService {
  constructor(@Inject(AI_INVOCATION_REPOSITORY) private readonly repository: AIInvocationRepository) {}

  async start(scope: AIInvocationScope, input: StartAIInvocationInput) {
    this.assertScope(scope);
    this.assertStart(input);
    const evidence = input.evidence.map((entry) => cloneEvidence(entry));
    return this.repository.create(scope, { ...input, evidence });
  }

  async get(scope: AIInvocationScope, invocationId: string) {
    this.assertScope(scope);
    return this.repository.findById(scope, invocationId);
  }

  async complete(scope: AIInvocationScope, invocationId: string, input: CompleteAIInvocationInput) {
    this.assertScope(scope);
    this.assertNonNegativeNumbers([input.durationMs, input.inputTokens, input.outputTokens]);
    for (const value of [input.provider, input.model]) {
      if (value !== undefined && (!value.trim() || value.length > 160)) {
        throw invalid('AI_INVOCATION_METADATA_INVALID', 'provider and model must be stable non-empty metadata');
      }
    }
    return this.repository.complete(scope, invocationId, input);
  }

  async recordUsage(scope: AIInvocationScope, invocationId: string, input: RecordAIUsageInput) {
    this.assertScope(scope);
    this.assertNonNegativeNumbers([input.inputTokens, input.outputTokens, input.durationMs]);
    if (input.errorCode && !/^[A-Z0-9_:-]{1,80}$/.test(input.errorCode)) {
      throw invalid('AI_USAGE_ERROR_CODE_INVALID', 'errorCode must be a stable non-sensitive program code');
    }
    return this.repository.recordUsage(scope, invocationId, { ...input, errorCode: input.errorCode?.trim() });
  }

  async listUsage(scope: AIInvocationScope, take?: number) {
    this.assertScope(scope);
    return this.repository.listUsage(scope, take);
  }

  private assertScope(scope: AIInvocationScope): void {
    if (!scope?.workspaceId || !scope.tenantId || !scope.shopId) {
      throw invalid('AI_INVOCATION_SCOPE_REQUIRED', 'workspace, tenant, and shop scope are required');
    }
  }

  private assertStart(input: StartAIInvocationInput): void {
    for (const [key, value] of Object.entries({
      purpose: input.purpose,
      provider: input.provider,
      model: input.model,
      promptVersion: input.promptVersion,
    })) {
      if (typeof value !== 'string' || !value.trim() || value.length > 160) {
        throw invalid('AI_INVOCATION_METADATA_INVALID', `${key} is required`);
      }
    }
    if (!Array.isArray(input.includedDataClasses) || !Array.isArray(input.excludedPII) || !Array.isArray(input.evidence)) {
      throw invalid('AI_INVOCATION_INPUT_INVALID', 'audit arrays are required');
    }
    input.evidence.forEach(assertEvidence);
  }

  private assertNonNegativeNumbers(values: Array<number | undefined>): void {
    if (values.some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
      throw invalid('AI_INVOCATION_METRICS_INVALID', 'usage metrics must be non-negative safe integers');
    }
  }
}

function assertEvidence(evidence: AIInvocationEvidenceInput): void {
  if (!evidence || !evidence.itemId || !evidence.versionId || !Number.isSafeInteger(evidence.version) || evidence.version < 1) {
    throw invalid('AI_EVIDENCE_INVALID', 'evidence item and version are required');
  }
  if (evidence.scope === 'PRODUCT' ? !evidence.productId : evidence.productId !== null) {
    throw invalid('AI_EVIDENCE_SCOPE_INVALID', 'evidence product scope must agree with productId');
  }
  if (!Number.isFinite(evidence.retrievalScore) || evidence.retrievalScore < 0 || evidence.retrievalScore > 1) {
    throw invalid('AI_EVIDENCE_SCORE_INVALID', 'evidence retrievalScore must be within [0,1]');
  }
  if (!evidence.contentSnapshot?.question?.trim() || !evidence.contentSnapshot?.answer?.trim()) {
    throw invalid('AI_EVIDENCE_SNAPSHOT_INVALID', 'evidence content snapshot is required');
  }
}

function cloneEvidence(evidence: AIInvocationEvidenceInput): AIInvocationEvidenceInput {
  return {
    ...evidence,
    productId: evidence.productId ?? null,
    contentSnapshot: { question: evidence.contentSnapshot.question, answer: evidence.contentSnapshot.answer },
  };
}

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}
