import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AIInvocationStatus, type KnowledgeScope, type KnowledgeSourceType } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';

export const AI_INVOCATION_REPOSITORY = Symbol('AI_INVOCATION_REPOSITORY');

export type AIInvocationScope = WorkspaceScope & { shopId: string; conversationId?: string };

export type AIInvocationEvidenceInput = {
  itemId: string;
  versionId: string;
  version: number;
  source: KnowledgeSourceType;
  scope: KnowledgeScope;
  productId: string | null;
  contentSnapshot: { question: string; answer: string };
  retrievalScore: number;
};

export type StartAIInvocationInput = {
  purpose: string;
  provider: string;
  model: string;
  promptVersion: string;
  ragStrategy?: string;
  fallbackUsed?: boolean;
  contextVersion?: number;
  includedDataClasses: string[];
  excludedPII: string[];
  evidence: AIInvocationEvidenceInput[];
};

export type CompleteAIInvocationInput = {
  status: Extract<AIInvocationStatus, 'SUCCEEDED' | 'FAILED' | 'ABORTED'>;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  fallbackUsed?: boolean;
};

export type RecordAIUsageInput = {
  purpose: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  success: boolean;
  fallbackUsed?: boolean;
  durationMs?: number;
  /** Stable program code only; provider diagnostics and prompt content are forbidden. */
  errorCode?: string;
};

export interface AIInvocationRepository {
  create(scope: AIInvocationScope, input: StartAIInvocationInput): Promise<unknown>;
  findById(scope: AIInvocationScope, invocationId: string): Promise<unknown | null>;
  complete(scope: AIInvocationScope, invocationId: string, input: CompleteAIInvocationInput): Promise<unknown>;
  recordUsage(scope: AIInvocationScope, invocationId: string, input: RecordAIUsageInput): Promise<unknown>;
  listUsage(scope: AIInvocationScope, take?: number): Promise<unknown[]>;
}

/** Every read/write is bound to workspace, tenant, and shop. */
@Injectable()
export class PrismaAIInvocationRepository implements AIInvocationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(scope: AIInvocationScope, input: StartAIInvocationInput) {
    return this.prisma.aIInvocation.create({
      data: {
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        shopId: scope.shopId,
        conversationId: scope.conversationId ?? null,
        purpose: input.purpose,
        provider: input.provider,
        model: input.model,
        promptVersion: input.promptVersion,
        ragStrategy: input.ragStrategy ?? null,
        fallbackUsed: Boolean(input.fallbackUsed),
        contextVersion: input.contextVersion ?? null,
        evidenceIdsJson: input.evidence.map((evidence) => evidence.versionId),
        includedDataClassesJson: input.includedDataClasses,
        excludedPIIJson: input.excludedPII,
        evidence: {
          create: input.evidence.map((evidence) => ({
            workspaceId: scope.workspaceId,
            tenantId: scope.tenantId,
            shopId: scope.shopId,
            itemId: evidence.itemId,
            versionId: evidence.versionId,
            version: evidence.version,
            source: evidence.source,
            scope: evidence.scope,
            productId: evidence.productId,
            contentSnapshotJson: evidence.contentSnapshot as Prisma.InputJsonValue,
            retrievalScore: evidence.retrievalScore,
          })),
        },
      },
      include: { evidence: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async findById(scope: AIInvocationScope, invocationId: string) {
    return this.prisma.aIInvocation.findFirst({
      where: { id: invocationId, workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId },
      include: { evidence: { orderBy: { createdAt: 'asc' } }, usage: true },
    });
  }

  async complete(scope: AIInvocationScope, invocationId: string, input: CompleteAIInvocationInput) {
    const changed = await this.prisma.aIInvocation.updateMany({
      where: { id: invocationId, workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId },
      data: {
        status: input.status,
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
        ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
        ...(input.fallbackUsed === undefined ? {} : { fallbackUsed: input.fallbackUsed }),
      },
    });
    if (changed.count !== 1) throw missingInvocation();
    const result = await this.findById(scope, invocationId);
    if (!result) throw missingInvocation();
    return result;
  }

  async recordUsage(scope: AIInvocationScope, invocationId: string, input: RecordAIUsageInput) {
    // Never upsert a usage record until its invocation has passed the same
    // triple-scope ownership predicate.
    const invocation = await this.findById(scope, invocationId);
    if (!invocation) throw missingInvocation();
    return this.prisma.aIUsage.upsert({
      where: { invocationId },
      create: {
        workspaceId: scope.workspaceId,
        tenantId: scope.tenantId,
        shopId: scope.shopId,
        conversationId: scope.conversationId ?? null,
        invocationId,
        purpose: input.purpose,
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        success: input.success,
        fallbackUsed: Boolean(input.fallbackUsed),
        durationMs: input.durationMs ?? null,
        errorCode: input.errorCode ?? null,
      },
      update: {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        success: input.success,
        fallbackUsed: Boolean(input.fallbackUsed),
        durationMs: input.durationMs ?? null,
        errorCode: input.errorCode ?? null,
      },
    });
  }

  async listUsage(scope: AIInvocationScope, take = 100) {
    return this.prisma.aIUsage.findMany({
      where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 500),
    });
  }
}

function missingInvocation(): NotFoundException {
  return new NotFoundException({ code: 'AI_INVOCATION_NOT_FOUND', message: 'AI invocation not found in this Workspace' });
}
