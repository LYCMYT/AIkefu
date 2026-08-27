import { Injectable, NotFoundException } from '@nestjs/common';
import { sanitizeContext } from '@ai-customer-service/core';
import { PrismaService } from '../database/prisma.service';
import { AiRuntimeApplicationService } from '../ai/ai-runtime-application.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import type { Prisma } from '@prisma/client';
import { WorkspaceGateway } from '../websocket/workspace.gateway';
import { randomUUID } from 'node:crypto';
import { TraceService } from '../trace/trace.service';
import { containsDynamicCommerceFact } from '../knowledge/knowledge.policy';

type Scope = WorkspaceScope & { shopId: string };

/** Manual-only quality review over frozen, scoped facts. */
@Injectable()
export class QualityReviewService {
  constructor(private readonly prisma: PrismaService, private readonly judge: AiRuntimeApplicationService, private readonly gateway?: WorkspaceGateway, private readonly traces?: TraceService) {}

  async start(scope: Scope, input: { conversationId: string; createdBy?: string }) {
    const frozen = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const conversation = await tx.conversation.findFirst({ where: { id: input.conversationId, ...scope }, select: { id: true, contextVersion: true } });
      if (!conversation) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found in this Shop' });
      const replies = await tx.message.findMany({ where: { ...scope, conversationId: conversation.id, role: { in: ['ASSISTANT', 'HUMAN'] } }, orderBy: { sequence: 'asc' }, take: 20, select: { id: true, role: true, sequence: true, contentJson: true } });
      const evidence = await tx.replyEvidence.findMany({ where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, replyJob: { conversationId: conversation.id, shopId: scope.shopId } }, take: 20, select: { id: true, retrievedContentSnapshotJson: true, knowledgeVersionId: true } });
      const sendRepository = tx as unknown as { sendOutbox?: { findMany(input: unknown): Promise<Array<{ status: string; failureCode: string | null }>> } };
      const sends = sendRepository.sendOutbox ? await sendRepository.sendOutbox.findMany({ where: { ...scope, conversationId: conversation.id }, select: { status: true, failureCode: true } }) : [];
      const review = await tx.qualityReview.create({ data: { ...scope, conversationId: conversation.id, replySnapshotJson: replies, evidenceSnapshotJson: evidence, sampleSize: replies.length ? 1 : 0, status: 'PENDING', createdBy: input.createdBy } });
      return { review, replies, evidence, sends, contextVersion: conversation.contextVersion };
    });
    const checks = deterministic(frozen.replies, frozen.evidence, frozen.sends);
    const metrics = frozenMetrics(frozen.replies, frozen.evidence, frozen.sends, checks);
    try {
      const context = sanitizeContext({ quality: { replies: frozen.replies, evidence: frozen.evidence, checks } }, ['quality']).value;
      const judged = await this.judge.runStructured(scope, { purpose: 'QUALITY_JUDGE', schema: 'QualityReview', context, allowedDataClasses: ['quality'], promptVersion: 'quality-v1', contextVersion: frozen.contextVersion });
      await this.prisma.qualityReview.updateMany({ where: { id: frozen.review.id, ...scope, status: 'PENDING' }, data: { status: 'AUTO_REVIEWED', deterministicResultJson: { passed: checks.every((check) => check.passed), checks }, judgeResultJson: judged.output, metricsJson: metrics, completedAt: new Date() } });
      const review = { ...frozen.review, status: 'AUTO_REVIEWED', sampleSize: frozen.review.sampleSize ?? (frozen.replies.length ? 1 : 0), metricsJson: metrics };
      this.publish(scope, review); void this.recordTrace(scope, frozen.review.id, frozen.review.conversationId, review.status, checks.length); return toQualityReviewDto(review);
    } catch {
      await this.prisma.qualityReview.updateMany({ where: { id: frozen.review.id, ...scope, status: 'PENDING' }, data: { status: 'NEEDS_HUMAN', deterministicResultJson: { passed: checks.every((check) => check.passed), checks }, metricsJson: metrics, completedAt: new Date() } });
      const review = { ...frozen.review, status: 'NEEDS_HUMAN', sampleSize: frozen.review.sampleSize ?? (frozen.replies.length ? 1 : 0), metricsJson: metrics };
      this.publish(scope, review); void this.recordTrace(scope, frozen.review.id, frozen.review.conversationId, review.status, checks.length); return toQualityReviewDto(review);
    }
  }

  async scopeForConversation(scope: WorkspaceScope, conversationId: string): Promise<Scope> {
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, ...scope }, select: { shopId: true } });
    if (!conversation) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found in this Workspace' });
    return { ...scope, shopId: conversation.shopId };
  }
  async scopeForReview(scope: WorkspaceScope, reviewId: string): Promise<Scope> {
    const review = await this.prisma.qualityReview.findFirst({ where: { id: reviewId, ...scope }, select: { shopId: true } });
    if (!review) throw new NotFoundException({ code: 'QUALITY_REVIEW_NOT_FOUND', message: 'Quality review not found' });
    return { ...scope, shopId: review.shopId };
  }

  async list(scope: WorkspaceScope, conversationId?: string) { const rows = await this.prisma.qualityReview.findMany({ where: { ...scope, ...(conversationId ? { conversationId } : {}) }, orderBy: { createdAt: 'desc' } }); return rows.map(toQualityReviewDto); }
  async get(scope: WorkspaceScope, id: string) { const review = await this.prisma.qualityReview.findFirst({ where: { id, ...scope } }); if (!review) throw new NotFoundException({ code: 'QUALITY_REVIEW_NOT_FOUND', message: 'Quality review not found' }); return toQualityReviewDto(review); }

  async conclude(scope: Scope, reviewId: string, result: 'PASS' | 'FAIL' | 'NEEDS_HUMAN') {
    const review = await this.prisma.qualityReview.findFirst({ where: { id: reviewId, ...scope } });
    if (!review) throw new NotFoundException({ code: 'QUALITY_REVIEW_NOT_FOUND', message: 'Quality review not found in this Shop' });
    const metrics = canonicalMetrics(review.metricsJson);
    const updated = await this.prisma.qualityReview.updateMany({ where: { id: review.id, ...scope, status: { in: ['AUTO_REVIEWED', 'NEEDS_HUMAN'] } }, data: { status: result, humanResult: result, metricsJson: metrics, completedAt: new Date() } });
    if (!updated.count) throw new NotFoundException({ code: 'QUALITY_REVIEW_NOT_FOUND', message: 'Quality review is no longer actionable' });
    const value = { ...review, status: result, humanResult: result, metricsJson: metrics }; this.publish(scope, value); void this.recordTrace(scope, review.id, review.conversationId, result, 0); return toQualityReviewDto(value);
  }

  private publish(scope: Scope, review: object) { try { const dto = toQualityReviewDto(review); this.gateway?.publish({ eventId: randomUUID(), eventType: 'QUALITY_REVIEW_UPDATED', workspaceId: scope.workspaceId, entityType: 'QUALITY_REVIEW', entityId: String(dto.id), entityVersion: 1, occurredAt: new Date().toISOString(), payload: { review: dto } }); } catch {} }
  private async recordTrace(scope: Scope, reviewId: string, conversationId: string, status: string, checkCount: number): Promise<void> { try { await this.traces?.record({ ...scope, conversationId }, `quality:${reviewId}`, 'QUALITY_REVIEW_UPDATED', { status, checkCount }); } catch {} }
}

export function toQualityReviewDto(review: object): Record<string, unknown> {
  const { deterministicResultJson, judgeResultJson, replySnapshotJson, evidenceSnapshotJson, metricsJson, ...rest } = review as Record<string, unknown>;
  return { ...rest, deterministicResult: deterministicResultJson ?? undefined, judgeResult: judgeResultJson ?? undefined, replySnapshot: replySnapshotJson ?? undefined, evidenceSnapshot: evidenceSnapshotJson ?? undefined, metrics: canonicalMetrics(metricsJson) };
}

/** Snapshot counts and deterministic check results only; these are not online KPIs. */
function frozenMetrics(replies: unknown[], evidence: unknown[], sends: unknown[], checks: Array<{ passed: boolean }>): Record<string, number> {
  const deterministicCheckPassedCount = checks.filter((check) => check.passed).length;
  return {
    frozenReplyCount: replies.length,
    frozenEvidenceCount: evidence.length,
    frozenSendCount: sends.length,
    deterministicCheckCount: checks.length,
    deterministicCheckPassedCount,
    deterministicCheckPassRate: checks.length ? deterministicCheckPassedCount / checks.length : 0,
  };
}

function canonicalMetrics(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const metrics: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) metrics[key] = entry;
  }
  return metrics;
}

function deterministic(replies: Array<{ contentJson: Prisma.JsonValue }>, evidence: unknown[], sends: Array<{ status: string; failureCode: string | null }>) {
  return [
    { key: 'REPLY_PRESENT', passed: replies.length > 0, reason: replies.length ? undefined : 'No projected reply exists' },
    { key: 'GROUNDING_EVIDENCE', passed: evidence.length > 0, reason: evidence.length ? undefined : 'No frozen evidence exists' },
    { key: 'DYNAMIC_FACT_SOURCE', passed: evidence.every((entry) => !containsDynamicCommerceFact(JSON.stringify(entry))), reason: 'Dynamic commerce facts must be sourced from live scoped context, never frozen RAG evidence' },
    { key: 'SEND_GUARD', passed: sends.every((send) => !(send.status === 'SENT' && Boolean(send.failureCode))), reason: 'Confirmed sends cannot retain a guard failure' },
    { key: 'FORBIDDEN_TERM_SCAN', passed: replies.every((reply) => !/违禁|保证退款/i.test(messageText(reply.contentJson))), reason: 'Deterministic forbidden-term scan' },
    { key: 'STRUCTURED_OUTPUT', passed: replies.every((reply) => Boolean(messageText(reply.contentJson).trim())), reason: 'Projected reply content must preserve a structured text field' },
  ];
}

function messageText(value: Prisma.JsonValue): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const text = (value as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }
  return '';
}
