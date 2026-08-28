import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { ReplyEvidenceSnapshot } from '@ai-customer-service/contracts';
import { buildReply, checkForbiddenTerms, createTaskBundle, decideReplyPolicy, executeTaskBundle, resolveContext, sanitizeContext, type TaskBundleExecution, type TaskState } from '@ai-customer-service/core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AiRuntimeApplicationService } from '../ai/ai-runtime-application.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ReplyDraftService } from './reply-draft.service';
import type { ReplyJobScope } from './reply-job.service';
import { SendOutboxService } from './send-outbox.service';
import { WorkspaceGateway } from '../websocket/workspace.gateway';
import { randomUUID } from 'node:crypto';
import { ConversationTransportMutex, localConversationTransportMutex, transportShopMutexKey } from './conversation-transport-mutex.service';
import { TraceService } from '../trace/trace.service';
import { WorkflowRouterService } from '../workflow/workflow-router.service';

type ReplyGeneration = { text: string; requiresHuman: boolean };
type IntentPlanTask = {
  intent: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  requiredContext: string[];
  requiredTools: string[];
};

/**
 * The durable reply executor. Network/model work happens only after a
 * PENDING claim and every consumer-facing transition rechecks the source
 * context so a late user message or takeover can only discard stale work.
 */
@Injectable()
export class ReplyRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    private readonly runtime: AiRuntimeApplicationService,
    private readonly drafts: ReplyDraftService,
    private readonly sendOutboxes: SendOutboxService,
    private readonly gateway?: WorkspaceGateway,
    private readonly transportMutex: ConversationTransportMutex = localConversationTransportMutex,
    private readonly traces?: TraceService,
    @Optional() private readonly workflowRouter?: WorkflowRouterService,
  ) {}

  async process(scope: ReplyJobScope, replyJobId: string): Promise<{
    status: 'WAITING_HUMAN' | 'READY_TO_SEND' | 'STALE'; draftId?: string; reason?: string;
  }> {
    const job = await this.prisma.replyJob.findFirst({
      where: { id: replyJobId, ...scope },
      include: { evidences: true, conversation: true, userTurn: true },
    });
    if (!job) throw new NotFoundException({ code: 'REPLY_JOB_NOT_FOUND', message: 'Reply job not found in this Shop' });
    if (!['PENDING', 'RECOVERY_PENDING'].includes(job.status)) {
      throw new ConflictException({ code: 'REPLY_JOB_NOT_RUNNABLE', message: 'Reply job is not runnable' });
    }
    const staleReason = staleReasonFor(job);
    if (staleReason) return this.stale(scope, job.id, job.status, staleReason);
    if (job.mode === 'MANUAL' || job.mode === 'HOLD') {
      return this.waitForHuman(scope, job, 'MANUAL_REQUIRED');
    }

    const claimed = await this.prisma.replyJob.updateMany({
      where: { id: job.id, ...scope, status: job.status, sourceContextVersion: job.sourceContextVersion },
      data: { status: 'GENERATING' },
    });
    if (claimed.count !== 1) return { status: 'STALE', reason: 'REPLY_JOB_CLAIM_LOST' };
    void this.recordTrace(scope, job, 'REPLY_JOB_CLAIMED', { sourceContextVersion: job.sourceContextVersion, sourceSequence: job.sourceSequence });
    void this.recordTrace(scope, job, 'USER_TURN', { userTurnId: job.userTurnId, sourceSequence: job.sourceSequence, sourceMessageCount: Array.isArray(job.userTurn.sourceMessageIdsJson) ? job.userTurn.sourceMessageIdsJson.length : 0 });
    this.publishRefresh(scope, job.conversationId, 'REPLY_JOB_STARTED', job.id);

    const lookup = job.evidences.length > 0
      ? { evidence: job.evidences.map(toEvidence), hasConflict: false, conflictItemIds: [] }
      : await this.retrieveAndFreezeEvidence(scope, job.id, job.userTurn.normalizedText);
    const evidence = lookup.evidence;
    void this.recordTrace(scope, job, 'EVIDENCE', { evidenceCount: evidence.length, knowledgeVersionIds: evidence.map((entry) => entry.versionId), conflicted: lookup.hasConflict });
    // Conflicted scoped knowledge is a hard stop.  It must not be included in
    // a planner/risk prompt merely to arrive at the same manual outcome.
    if (lookup.hasConflict) return this.waitForHuman(scope, job, 'CONTEXT_CONFLICT');
    let output: ReplyGeneration | undefined;
    try {
      const contextSupport = await this.buildContextSupport(scope, job);
      const intent = await this.runtime.runStructured<{ tasks: IntentPlanTask[] }>(scope, {
        purpose: 'INTENT_PLANNER', schema: 'IntentPlan', context: { turn: { text: job.userTurn.normalizedText }, ...contextSupport },
        allowedDataClasses: ['turn', 'conversationSummary', 'customerMemory'], promptVersion: 'reply-intent-plan-v1', evidence: [], ragStrategy: 'NONE', contextVersion: job.sourceContextVersion,
      });
      const plannedTasks = augmentExplicitIntentTasks(job.userTurn.normalizedText, intent.output.tasks);
      const risk = await this.runtime.runStructured<{ riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; reasons: string[]; recommendedMode: 'AUTO' | 'ASSIST' | 'MANUAL' }>(scope, {
        purpose: 'RISK_CLASSIFIER', schema: 'RiskResult',
        context: { tasks: plannedTasks.map((task) => ({ intent: task.intent, riskLevel: task.riskLevel })) },
        allowedDataClasses: ['tasks'], promptVersion: 'reply-risk-v1', evidence: [], ragStrategy: 'NONE', contextVersion: job.sourceContextVersion,
      });
      void this.recordTrace(scope, job, 'AI_USAGE', { invocations: [intent, risk].map((result) => ({ invocationId: result.invocationId, provider: result.provider, model: result.model, fallbackUsed: result.fallbackUsed })) });
      const taskBundle = createTaskBundle({
        tasks: plannedTasks.slice(0, 4).map((task, index) => ({
          id: `${job.id}:${index}`, intent: task.intent, operation: 'READ' as const, riskLevel: maxRisk(task.riskLevel, risk.output.riskLevel),
          requiredContext: task.requiredContext, requiredTools: task.requiredTools, blocking: task.requiredTools.length > 0,
        })),
      });
      // Dynamic fact reads and the selected entity persistence share the same
      // short shop mutex as fact invalidation. Models are deliberately outside
      // this critical section: only live read -> selection CAS is serialized.
      const resolvedContexts = await this.transportMutex.runMany([transportShopMutexKey(scope)], async () => {
        const taskContexts = await this.resolveTaskContexts(scope, job, taskBundle.tasks);
        const clarification = clarificationText(taskContexts);
        if (!clarification) await this.persistResolvedContexts(scope, job, taskContexts);
        return { taskContexts, clarification };
      });
      const { taskContexts, clarification } = resolvedContexts;
      void this.recordTrace(scope, job, 'CONTEXT', { contexts: [...taskContexts.entries()].map(([taskId, context]) => ({ taskId, status: context.status, entitySelected: Boolean(context.entity), manualRequired: context.manualRequired })) });
      if (clarification) {
        const shop = await this.prisma.shop.findFirst({ where: { id: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId }, select: { aiMode: true } });
        if (shop?.aiMode === 'MANUAL_ONLY') return this.waitForHuman(scope, job, 'CONTEXT_AMBIGUOUS');
        return this.enqueueClarification(scope, job, taskContexts, clarification);
      }
      let execution = await executeTaskBundle(taskBundle, async (task) => {
        const context = taskContexts.get(task.id);
        if (context && context.status !== 'RESOLVED') {
          return { status: 'AMBIGUOUS' as const, errorCode: `CONTEXT_${context.status}` };
        }
        const dynamicReplyText = context?.entity ? dynamicReply(task.intent, context.entity as unknown as Record<string, unknown>) : undefined;
        if (evidence.length === 0 && !dynamicReplyText) return { status: 'FAILED' as const, errorCode: 'NO_EVIDENCE' };
        return {
          status: 'RESOLVED' as const,
          facts: { reply: dynamicReplyText ?? evidence[0]!.contentSnapshot.answer, ...(context?.entity ? { context: context.entity } : {}) },
          evidence: evidence.map((entry) => entry.versionId),
        };
      });
      const persistedTaskIds = await this.persistTasks(scope, job.id, job.conversationId, job.userTurnId, execution.tasks);
      const workflow = await this.resolveWorkflowTasks(scope, job.conversationId, persistedTaskIds, execution);
      if (workflow.waitingApproval) return this.waitForHuman(scope, job, 'WORKFLOW_APPROVAL_REQUIRED');
      if (workflow.failed) return this.waitForHuman(scope, job, 'WORKFLOW_FAILED');
      execution = workflow.execution;
      void this.recordTrace(scope, job, 'TASKS', { tasks: execution.tasks.map((task) => ({ id: task.id, status: task.status, riskLevel: task.riskLevel, errorCode: task.errorCode ?? null })) });
      const [shop, settings] = await Promise.all([
        this.prisma.shop.findFirst({ where: { id: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId }, select: { aiMode: true } }),
        this.prisma.shopSettings.findFirst({ where: { shopId: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId }, select: { forbiddenTermsJson: true, transferKeywordsJson: true } }),
      ]);
      const policy = decideReplyPolicy({
        shopMode: shop?.aiMode ?? 'ASSIST_ONLY',
        conversationOverride: job.conversation.overrideMode ?? (job.mode === 'ASSIST' ? 'ASSIST' : undefined),
        syncState: job.conversation.syncState,
        humanActive: job.conversation.humanActive,
        taskRisks: execution.tasks.map((task) => task.riskLevel),
        contextStatus: contextPolicyStatus(taskContexts, evidence.length > 0 || workflow.hasWorkflowResult || execution.tasks.some((task) => typeof task.facts?.reply === 'string')),
        contextManualRequired: [...taskContexts.values()].some((context) => context.manualRequired),
        hasEvidence: evidence.length > 0 || workflow.hasWorkflowResult || execution.tasks.some((task) => typeof task.facts?.reply === 'string'),
        hasBlockingFailure: execution.hasBlockingFailure,
        hasPartialFailure: execution.tasks.some((task) => task.status === 'FAILED' || task.status === 'AMBIGUOUS'),
        userRequestedHuman: transferRequested(job.userTurn.normalizedText, settings?.transferKeywordsJson),
        hasConflict: lookup.hasConflict,
        recommendedMode: conservativeRecommendation(risk.output.recommendedMode),
      });
      void this.recordTrace(scope, job, 'REPLY_POLICY', { mode: policy.mode, reasons: policy.reasons, evidenceCount: evidence.length, taskStatuses: execution.tasks.map((task) => task.status) });
      if (policy.mode === 'MANUAL') {
        return this.waitForHuman(scope, job, policy.reasons.join(',') || 'MANUAL_REQUIRED');
      }
      const composeFinalReply = async () => {
          const result = await this.runtime.runStructured<ReplyGeneration>(scope, {
            purpose: 'REPLY_GENERATION', schema: 'ReplyGeneration',
            context: {
              turn: { text: job.userTurn.normalizedText },
              knowledge: evidence.map((entry) => ({ question: entry.contentSnapshot.question, answer: entry.contentSnapshot.answer, source: entry.source })),
              taskResults: execution.tasks.map((task) => ({ id: task.id, status: task.status, facts: task.facts, errorCode: task.errorCode ?? null })),
              ...contextSupport,
            },
            allowedDataClasses: ['turn', 'knowledge', 'taskResults', 'conversationSummary', 'customerMemory'], promptVersion: 'reply-composer-v1', evidence,
            ragStrategy: evidence.length ? 'SCOPED_KNOWLEDGE_SNAPSHOT' : 'NO_EVIDENCE', contextVersion: job.sourceContextVersion,
          });
          output = result.output;
          void this.recordTrace(scope, job, 'AI_USAGE', { invocationId: result.invocationId, provider: result.provider, model: result.model, fallbackUsed: result.fallbackUsed, purpose: 'REPLY_GENERATION' });
          return result.output.text;
      };
      // A Workflow is a Task execution owner, never a parallel reply writer.
      // Its durable TaskResult must pass through this one final Composer even
      // when the bundle would otherwise qualify for the local fast path.
      const built = workflow.hasWorkflowResult
        ? { strategy: 'COMPOSER' as const, text: (await composeFinalReply()).trim() }
        : await buildReply({ tasks: execution.tasks }, { compose: composeFinalReply });
      const checked = checkForbiddenTerms(built.text, forbiddenRules(settings?.forbiddenTermsJson));
      if (!checked.allowed) {
        await this.prisma.replyJob.updateMany({
          where: { id: job.id, ...scope, status: 'GENERATING', sourceContextVersion: job.sourceContextVersion },
          data: { status: 'WAITING_HUMAN', staleReason: 'FORBIDDEN_TERM' },
        });
      this.publishRefresh(scope, job.conversationId, 'REPLY_JOB_WAITING_HUMAN', job.id);
      return { status: 'WAITING_HUMAN', reason: 'FORBIDDEN_TERM' };
      }
      output = output ?? { text: checked.text, requiresHuman: policy.mode === 'ASSIST' };
      output.text = checked.text;
      output.requiresHuman = output.requiresHuman || policy.mode === 'ASSIST';
    } catch {
      return this.waitForHuman(scope, job, 'AI_RUNTIME_FAILED');
    }

    const current = await this.prisma.replyJob.findFirst({
      where: { id: job.id, ...scope, status: 'GENERATING', sourceContextVersion: job.sourceContextVersion },
      include: { conversation: true },
    });
    const finalStaleReason = current ? staleReasonFor(current) : 'REPLY_JOB_CLAIM_LOST';
    if (finalStaleReason) return this.stale(scope, job.id, 'GENERATING', finalStaleReason);
    const text = output!.text.trim();
    if (!text) {
      await this.prisma.replyJob.updateMany({
        where: { id: job.id, ...scope, status: 'GENERATING' }, data: { status: 'WAITING_HUMAN', staleReason: 'EMPTY_REPLY' },
      });
      return { status: 'WAITING_HUMAN', reason: 'EMPTY_REPLY' };
    }
    if (output!.requiresHuman) {
      try {
        const draft = await this.drafts.createWaitingHuman(scope, {
          replyJobId: job.id, aiDraft: text, sourceContextVersion: job.sourceContextVersion,
          sourceLastMessageId: job.sourceLastMessageId ?? undefined, sourceSequence: job.sourceSequence,
        });
        return { status: 'WAITING_HUMAN', draftId: draft.id };
      } catch (error) {
        return this.draftRaceResult(error);
      }
    }

    if (!(await this.commitAutoSend(scope, job, text))) return { status: 'STALE', reason: 'REPLY_JOB_CLAIM_LOST' };
    this.publishRefresh(scope, job.conversationId, 'CONVERSATION_UPDATED', job.id);
    return { status: 'READY_TO_SEND' };
  }

  /** READY is never durable without its matching immutable send intent. */
  private async commitAutoSend(
    scope: ReplyJobScope,
    job: { id: string; conversationId: string; sourceContextVersion: number; sourceLastMessageId?: string | null; sourceSequence: number },
    text: string,
  ): Promise<boolean> {
    type AutoSendInput = {
      replyJobId: string; conversationId: string; text: string; idempotencyKey: string;
      expectedLastMessageId?: string; expectedSequence: number; expectedContextVersion: number;
    };
    const input: AutoSendInput = {
      replyJobId: job.id, conversationId: job.conversationId, text,
      idempotencyKey: `reply-send:${job.id}`,
      expectedLastMessageId: job.sourceLastMessageId ?? undefined,
      expectedSequence: job.sourceSequence,
      expectedContextVersion: job.sourceContextVersion,
    };
    const client = this.prisma as unknown as { $transaction?: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> };
    const outboxes = this.sendOutboxes as unknown as { enqueueInTransaction?: (tx: Prisma.TransactionClient, scope: ReplyJobScope, input: AutoSendInput) => Promise<unknown> };
    // Focused in-memory unit ports predate the transactional seam. Production
    // Prisma always has both collaborators, and takes the atomic branch.
    if (!client.$transaction || !outboxes.enqueueInTransaction) {
      const marked = await this.prisma.replyJob.updateMany({
        where: { id: job.id, ...scope, status: 'GENERATING', sourceContextVersion: job.sourceContextVersion }, data: { status: 'FAST_PATH_READY' },
      });
      if (!marked.count) return false;
      await this.sendOutboxes.enqueue(scope, input);
      return true;
    }
    return client.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT 1 FROM "Conversation" WHERE "id" = ${job.conversationId}
          AND "workspaceId" = ${scope.workspaceId} AND "tenantId" = ${scope.tenantId} AND "shopId" = ${scope.shopId}
        FOR UPDATE
      `);
      const conversation = await tx.conversation.findFirst({
        where: { id: job.conversationId, ...scope }, select: { contextVersion: true, humanActive: true, state: true },
      });
      if (!conversation || conversation.contextVersion !== job.sourceContextVersion || conversation.humanActive || conversation.state !== 'ACTIVE') {
        await tx.replyJob.updateMany({
          where: { id: job.id, ...scope, status: 'GENERATING', sourceContextVersion: job.sourceContextVersion },
          data: { status: 'STALE', staleReason: 'SEND_CONTEXT_STALE' },
        });
        return false;
      }
      const marked = await tx.replyJob.updateMany({
        where: { id: job.id, ...scope, status: 'GENERATING', sourceContextVersion: job.sourceContextVersion }, data: { status: 'FAST_PATH_READY' },
      });
      if (!marked.count) return false;
      // A throw rolls back the READY transition with the missing outbox,
      // leaving only the original GENERATING job for recovery to claim/stale.
      await outboxes.enqueueInTransaction!(tx, scope, input);
      return true;
    });
  }

  private async retrieveAndFreezeEvidence(scope: ReplyJobScope, replyJobId: string, query: string): Promise<{ evidence: ReplyEvidenceSnapshot[]; hasConflict: boolean; conflictItemIds: string[] }> {
    const result = await this.knowledge.search(scope, { shopId: scope.shopId, query, topK: 3 });
    if (result.status !== 'EVIDENCE') return { evidence: [], hasConflict: result.status === 'CONFLICTED', conflictItemIds: [...result.conflictItemIds] };
    const evidence = result.evidence.map((entry) => ({ ...entry, contentSnapshot: { ...entry.contentSnapshot } }));
    if (evidence.length > 0) {
      await this.prisma.replyEvidence.createMany({
        data: evidence.map((entry) => ({
          ...scope, replyJobId, knowledgeItemId: entry.itemId, knowledgeVersionId: entry.versionId,
          knowledgeVersionNumber: entry.version, sourceType: entry.source, scope: entry.scope,
          productId: entry.productId, retrievedContentSnapshotJson: cloneJson(entry.contentSnapshot), retrievalScore: entry.retrievalScore,
        })),
      });
    }
    return { evidence, hasConflict: result.conflictItemIds.length > 0, conflictItemIds: [...result.conflictItemIds] };
  }

  /** P5/P6 context is read-only, scoped, expired rows excluded, then sanitized before any provider call. */
  private async buildContextSupport(
    scope: ReplyJobScope,
    job: { conversationId: string; conversation: { buyerId: string } },
  ): Promise<Record<string, unknown>> {
    const repository = this.prisma as unknown as {
      conversationMemory?: { findFirst(input: unknown): Promise<{ narrative: string; structuredFactsJson: unknown; status: string } | null> };
      customerMemory?: { findMany(input: unknown): Promise<Array<{ type: string; key: string; valueJson: unknown }>> };
    };
    const [memory, memories] = await Promise.all([
      repository.conversationMemory?.findFirst({
        where: { ...scope, conversationId: job.conversationId, status: 'CLEAN' },
        select: { narrative: true, structuredFactsJson: true, status: true },
      }) ?? Promise.resolve(null),
      repository.customerMemory?.findMany({
        where: { ...scope, buyerId: job.conversation.buyerId, status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        orderBy: { updatedAt: 'desc' }, take: 6, select: { type: true, key: true, valueJson: true },
      }) ?? Promise.resolve([]),
    ]);
    const safeCustomerMemory = memories.flatMap((entry) => {
      const sanitized = sanitizeContext({ customerMemory: { type: entry.type, key: entry.key, value: entry.valueJson } }, ['customerMemory']);
      return sanitized.audit.excludedPII.length === 0 ? [sanitized.value.customerMemory] : [];
    });
    const safe = sanitizeContext({
      ...(memory ? { conversationSummary: {
        ...(stableNarrative(memory.narrative) ? { narrative: stableNarrative(memory.narrative) } : {}),
        structuredFacts: withoutDynamicFacts(memory.structuredFactsJson),
      } } : {}),
      ...(safeCustomerMemory.length ? { customerMemory: safeCustomerMemory } : {}),
    }, ['conversationSummary', 'customerMemory']);
    return safe.value;
  }

  private async resolveTaskContexts(
    scope: ReplyJobScope,
    job: { sourceContextVersion: number; conversation: { id?: string; contextVersion: number; buyerId: string; currentProductId?: string | null; currentOrderId?: string | null; clarificationRoundsJson?: unknown }; userTurn: { normalizedText?: string; sourceMessageIdsJson?: unknown } },
    tasks: Array<{ id: string; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; requiredContext: string[] }>,
  ): Promise<Map<string, ReturnType<typeof resolveContext>>> {
    const result = new Map<string, ReturnType<typeof resolveContext>>();
    // Dynamic answers need the most specific live entity.  A planner commonly
    // asks for PRODUCT+SKU; choosing PRODUCT first loses inventory entirely.
    const kindFor = (requirements: string[]) => requirements.includes('ORDER') ? 'ORDER' as const
      : requirements.includes('SKU') ? 'SKU' as const
        : requirements.includes('PRODUCT') ? 'PRODUCT' as const : undefined;
    const sourceMessageIds = Array.isArray(job.userTurn.sourceMessageIdsJson)
      ? job.userTurn.sourceMessageIdsJson.filter((id): id is string => typeof id === 'string')
      : [];
    const repository = this.prisma as unknown as {
      message?: { findMany(input: unknown): Promise<Array<{ kind: string; contentJson: unknown }>> };
      product?: { findMany(input: unknown): Promise<Array<{ id: string; title: string }>>; findFirst?: (input: unknown) => Promise<{ id: string; title: string } | null> };
      productSku?: { findMany(input: unknown): Promise<Array<{ id: string; productId: string; externalSkuId: string; inventory: number; price: unknown; attributesJson: unknown }>>; findFirst?: (input: unknown) => Promise<{ id: string; productId: string; externalSkuId: string; inventory: number; price: unknown; attributesJson: unknown } | null> };
      order?: { findMany(input: unknown): Promise<Array<{ id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number }>>; findFirst?: (input: unknown) => Promise<{ id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number } | null> };
    };
    const cards = sourceMessageIds.length && repository.message
      ? await repository.message.findMany({
          where: { ...scope, id: { in: sourceMessageIds }, status: { not: 'RECALLED' }, kind: { in: ['GOODS_CARD', 'ORDER_CARD'] } },
          orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }], select: { kind: true, contentJson: true },
        })
      : [];
    for (const task of tasks) {
      const kind = kindFor(task.requiredContext);
      if (!kind) continue;
      const cardId = cardContextId(cards, kind);
      const preferredId = kind === 'ORDER' ? job.conversation.currentOrderId : job.conversation.currentProductId;
      const choiceId = clarificationChoiceId(job.conversation.clarificationRoundsJson, kind, job.userTurn.normalizedText ?? '');
      const candidates = await this.contextCandidates(repository, scope, job.conversation.buyerId, kind, {
        preferredId, cardId, choiceId, text: job.userTurn.normalizedText ?? '',
      });
      const useCard = Boolean(cardId);
      result.set(task.id, resolveContext({
        kind, riskLevel: task.riskLevel, candidates,
        ...(useCard && cardId ? { card: { id: cardId, kind } } : {}),
        clarificationRounds: clarificationRounds(job.conversation.clarificationRoundsJson, kind),
        contextVersion: job.sourceContextVersion, currentContextVersion: job.conversation.contextVersion,
      }));
    }
    return result;
  }

  private async contextCandidates(
    repository: {
      product?: { findMany(input: unknown): Promise<Array<{ id: string; title: string }>>; findFirst?: (input: unknown) => Promise<{ id: string; title: string } | null> };
      productSku?: { findMany(input: unknown): Promise<Array<{ id: string; productId: string; externalSkuId: string; inventory: number; price: unknown; attributesJson: unknown }>>; findFirst?: (input: unknown) => Promise<{ id: string; productId: string; externalSkuId: string; inventory: number; price: unknown; attributesJson: unknown } | null> };
      order?: { findMany(input: unknown): Promise<Array<{ id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number }>>; findFirst?: (input: unknown) => Promise<{ id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number } | null> };
    },
    scope: ReplyJobScope,
    buyerId: string,
    kind: 'PRODUCT' | 'SKU' | 'ORDER',
    options: { preferredId?: string | null; cardId?: string; choiceId?: string; text: string },
  ): Promise<Array<{ id: string; kind: 'PRODUCT' | 'SKU' | 'ORDER'; label: string }>> {
    // A current-turn card is an explicit user selection and wins over the
    // conversation's older active entity.
    const exactId = options.cardId || options.choiceId;
    if (kind === 'ORDER' && repository.order) {
      if (exactId && repository.order.findFirst) {
        const row = await repository.order.findFirst({ where: { id: exactId, ...scope, buyerId }, select: { id: true, externalOrderId: true, status: true, logisticsSnapshotJson: true, version: true } });
        return row ? [orderCandidate(row)] : [];
      }
      // A buyer who explicitly names another scoped order in this turn wins
      // over the older conversation selection.  Keep this bounded, but broad
      // enough that a recently selected order cannot hide the named one.
      const rows = await repository.order.findMany({ where: { ...scope, buyerId, ...(exactId ? { id: exactId } : {}) }, orderBy: { orderedAt: 'desc' }, take: exactId ? 1 : 25, select: { id: true, externalOrderId: true, status: true, logisticsSnapshotJson: true, version: true } });
      const textMatches = explicitOrderMatches(rows, options.text);
      if (textMatches.length) return textMatches.map(orderCandidate);
      if (options.preferredId && repository.order.findFirst) {
        const row = await repository.order.findFirst({ where: { id: options.preferredId, ...scope, buyerId }, select: { id: true, externalOrderId: true, status: true, logisticsSnapshotJson: true, version: true } });
        return row ? [orderCandidate(row)] : [];
      }
      return rows.map(orderCandidate);
    }
    if (kind === 'SKU' && repository.productSku) {
      if (exactId && repository.productSku.findFirst) {
        const row = await repository.productSku.findFirst({ where: { id: exactId, ...scope }, select: { id: true, productId: true, externalSkuId: true, inventory: true, price: true, attributesJson: true } });
        return row ? [skuCandidate(row)] : [];
      }
      const select = { id: true, productId: true, externalSkuId: true, inventory: true, price: true, attributesJson: true };
      // Textual attributes (for example “黑色 XL”) are a current-turn
      // selection.  Match them across the scoped SKU set before falling back
      // to the conversation's older product.  `preferredId` is a product id,
      // never a SKU id, so it must only be used as a productId filter.
      const scopedRows = await repository.productSku.findMany({
        where: { ...scope }, orderBy: { updatedAt: 'desc' }, take: 25, select,
      });
      const textMatches = explicitSkuMatches(scopedRows, options.text);
      if (textMatches.length) return textMatches.map(skuCandidate);
      if (options.preferredId) {
        const preferredRows = await repository.productSku.findMany({
          where: { ...scope, productId: options.preferredId }, orderBy: { updatedAt: 'desc' }, take: 25, select,
        });
        return selectSkuMatches(preferredRows, options.text).map(skuCandidate);
      }
      return selectSkuMatches(scopedRows, options.text).map(skuCandidate);
    }
    if (kind === 'PRODUCT' && repository.product) {
      if (exactId && repository.product.findFirst) {
        const row = await repository.product.findFirst({ where: { id: exactId, ...scope }, select: { id: true, title: true } });
        return row ? [{ id: row.id, kind, label: row.title }] : [];
      }
      const rows = await repository.product.findMany({ where: { ...scope, ...(exactId ? { id: exactId } : {}) }, orderBy: { updatedAt: 'desc' }, take: exactId ? 1 : 3, select: { id: true, title: true } });
      return rows.map((row) => ({ id: row.id, kind, label: row.title }));
    }
    return [];
  }

  private async persistResolvedContexts(
    scope: ReplyJobScope,
    job: { conversationId: string; sourceContextVersion: number; conversation: { clarificationRoundsJson?: unknown } },
    contexts: Map<string, ReturnType<typeof resolveContext>>,
  ): Promise<void> {
    const values = [...contexts.values()].filter((context) => context.status === 'RESOLVED' && context.entity);
    const order = values.find((context) => context.entity!.kind === 'ORDER')?.entity;
    const product = values.find((context) => context.entity!.kind === 'PRODUCT' || context.entity!.kind === 'SKU')?.entity;
    if (!order && !product) return;
    const dynamic = product ? jsonRecord((product as unknown as Record<string, unknown>).dynamic) : null;
    const states = clarificationStates(job.conversation.clarificationRoundsJson);
    for (const context of values) delete states[context.entity!.kind];
    await this.prisma.conversation.updateMany({
      where: { id: job.conversationId, ...scope, contextVersion: job.sourceContextVersion },
      data: {
        ...(order ? { currentOrderId: order.id } : {}),
        ...(product ? { currentProductId: typeof dynamic?.productId === 'string' ? dynamic.productId : product.id } : {}),
        clarificationRoundsJson: cloneJson(states),
      },
    });
  }

  private async enqueueClarification(
    scope: ReplyJobScope,
    job: { id: string; conversationId: string; userTurnId: string; sourceContextVersion: number; sourceLastMessageId?: string | null; sourceSequence: number; conversation: { clarificationRoundsJson?: unknown } },
    contexts: Map<string, ReturnType<typeof resolveContext>>,
    text: string,
  ): Promise<{ status: 'READY_TO_SEND' | 'STALE'; reason?: string }> {
    const rounds = clarificationStates(job.conversation.clarificationRoundsJson);
    for (const context of contexts.values()) {
      if (context.clarification) {
        for (const request of context.clarification.requests) {
          rounds[request.kind] = { round: context.clarification.round, choices: request.choices };
        }
      }
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const persisted = await tx.conversation.updateMany({
        where: { id: job.conversationId, ...scope, contextVersion: job.sourceContextVersion, humanActive: false },
        data: { clarificationRoundsJson: cloneJson(rounds) },
      });
      if (!persisted.count) return false;
      const ready = await tx.replyJob.updateMany({
        where: { id: job.id, ...scope, status: 'GENERATING', sourceContextVersion: job.sourceContextVersion },
        data: { status: 'FAST_PATH_READY', staleReason: 'CLARIFICATION_ROUND' },
      });
      if (!ready.count) return false;
      const taskRepository = tx as unknown as { task?: { createMany(input: unknown): Promise<unknown> } };
      const clarificationTasks = [...contexts.values()].flatMap((context, index) => context.clarification ? [{
        id: `reply-task:${job.id}:clarification:${index}`, ...scope, conversationId: job.conversationId, userTurnId: job.userTurnId,
        intent: 'CLARIFICATION', operation: 'READ', riskLevel: 'LOW', requiredContextJson: context.clarification.requests.map((request) => request.kind),
        requiredKnowledgeJson: [], requiredToolsJson: [], status: 'AMBIGUOUS', blocking: false,
        resultJson: cloneJson({ clarification: context.clarification }),
      }] : []);
      if (clarificationTasks.length && taskRepository.task) await taskRepository.task.createMany({ data: clarificationTasks, skipDuplicates: true });
      await this.sendOutboxes.enqueueInTransaction(tx, scope, {
        replyJobId: job.id, conversationId: job.conversationId, text,
        idempotencyKey: `clarification:${job.id}:${JSON.stringify(rounds)}`,
        expectedLastMessageId: job.sourceLastMessageId ?? undefined, expectedSequence: job.sourceSequence,
        expectedContextVersion: job.sourceContextVersion,
      });
      return true;
    });
    if (!result) return { status: 'STALE', reason: 'CLARIFICATION_CAS_LOST' };
    this.publishRefresh(scope, job.conversationId, 'CONVERSATION_UPDATED', job.id);
    return { status: 'READY_TO_SEND' };
  }

  private async stale(scope: ReplyJobScope, id: string, status: string, reason: string) {
    await this.prisma.replyJob.updateMany({
      where: { id, ...scope, status: status as never }, data: { status: 'STALE', staleReason: reason },
    });
    return { status: 'STALE' as const, reason };
  }

  private async waitForHuman(
    scope: ReplyJobScope,
    job: { id: string; conversationId: string; sourceContextVersion: number; sourceLastMessageId?: string | null; sourceSequence: number },
    reason: string,
  ): Promise<{ status: 'WAITING_HUMAN'; draftId: string; reason: string } | { status: 'STALE'; reason: string }> {
    // ReplyDraftService owns the atomic GENERATING/PENDING -> WAITING_HUMAN
    // transition.  Updating it first would make the draft deliberately reject
    // its own source job and strand a worker in an inconsistent state.
    let draft: { id: string };
    try {
      draft = await this.drafts.createWaitingHuman(scope, {
        replyJobId: job.id, aiDraft: '请人工处理此会话。', sourceContextVersion: job.sourceContextVersion,
        sourceLastMessageId: job.sourceLastMessageId ?? undefined, sourceSequence: job.sourceSequence,
      });
    } catch (error) {
      return this.draftRaceResult(error);
    }
    await this.prisma.replyJob.updateMany({
      where: { id: job.id, ...scope, status: 'WAITING_HUMAN', sourceContextVersion: job.sourceContextVersion },
      data: { staleReason: reason },
    });
    this.publishRefresh(scope, job.conversationId, 'REPLY_JOB_WAITING_HUMAN', job.id);
    return { status: 'WAITING_HUMAN', draftId: draft.id, reason };
  }

  /** A source-context mutation may win after generation but before the draft
   * transaction.  ReplyDraftService correctly rejects that stale writer; the
   * durable queue consumer must treat the rejection as an idempotent no-op,
   * not retry the same obsolete generation forever. */
  private draftRaceResult(error: unknown): { status: 'STALE'; reason: string } {
    if (error instanceof ConflictException) {
      const response = error.getResponse();
      const code = typeof response === 'object' && response !== null && 'code' in response
        ? String((response as { code?: unknown }).code ?? '')
        : '';
      if (['REPLY_JOB_NOT_DRAFTABLE', 'REPLY_CONTEXT_STALE'].includes(code)) {
        return { status: 'STALE', reason: 'REPLY_DRAFT_RACE_LOST' };
      }
    }
    throw error;
  }

  private publishRefresh(scope: ReplyJobScope, conversationId: string, _eventType: 'CONVERSATION_UPDATED' | 'REPLY_JOB_STARTED' | 'REPLY_JOB_WAITING_HUMAN', _replyJobId: string): void {
    this.gateway?.publish({
      eventId: randomUUID(), eventType: 'CONVERSATION_UPDATED', workspaceId: scope.workspaceId,
      entityType: 'CONVERSATION', entityId: conversationId, entityVersion: 1, occurredAt: new Date().toISOString(),
      payload: { conversationId, refresh: true },
    });
  }

  private async recordTrace(scope: ReplyJobScope, job: { id: string; conversationId: string }, stage: string, payload: Record<string, unknown>): Promise<void> {
    try { await this.traces?.record({ ...scope, conversationId: job.conversationId, replyJobId: job.id }, `reply-job:${job.id}`, stage, payload); } catch { /* tracing is advisory */ }
  }

  private async persistTasks(
    scope: ReplyJobScope,
    replyJobId: string,
    conversationId: string,
    userTurnId: string,
    tasks: Array<{ id: string; intent: string; operation: 'READ' | 'WRITE'; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; requiredContext: string[]; requiredTools: string[]; status: string; facts?: Record<string, unknown>; errorCode?: string; blocking: boolean }>,
  ): Promise<string[]> {
    const persistedTaskIds = tasks.map((task) => `reply-task:${replyJobId}:${task.id}`);
    const repository = this.prisma as unknown as {
      task?: { createMany(input: unknown): Promise<unknown> };
      processingOutbox?: { create(input: unknown): Promise<unknown>; upsert?(input: unknown): Promise<unknown> };
      $transaction?: <T>(work: (tx: { task?: { createMany(input: unknown): Promise<unknown> }; processingOutbox?: { create(input: unknown): Promise<unknown>; upsert?(input: unknown): Promise<unknown> } }) => Promise<T>) => Promise<T>;
    };
    if (!repository.task) return [];
    const persist = async (tx: { task?: { createMany(input: unknown): Promise<unknown> }; processingOutbox?: { create(input: unknown): Promise<unknown>; upsert?(input: unknown): Promise<unknown> } }) => {
      if (!tx.task) return;
      await tx.task.createMany({
        data: tasks.map((task) => ({
          ...scope, id: `reply-task:${replyJobId}:${task.id}`, conversationId, userTurnId, intent: task.intent,
          operation: task.operation, riskLevel: task.riskLevel, requiredContextJson: task.requiredContext,
          requiredKnowledgeJson: [], requiredToolsJson: task.requiredTools, status: task.status,
          ...(task.facts ? { resultJson: task.facts } : {}), errorCode: task.errorCode, blocking: task.blocking,
        })),
        skipDuplicates: true,
      });
      // This route intent is committed in the same short transaction as the
      // Task rows. A restart can therefore claim it later; no in-memory only
      // callback owns a workflow task.
      if (tx.processingOutbox) {
        const data = { ...scope, eventId: `workflow-route:${replyJobId}`, aggregateType: 'TASK_BUNDLE', aggregateId: replyJobId, eventType: 'WORKFLOW_ROUTE', payloadJson: { conversationId, taskIds: persistedTaskIds } };
        if (tx.processingOutbox.upsert) await tx.processingOutbox.upsert({ where: { eventId: data.eventId }, update: {}, create: data });
        else await tx.processingOutbox.create({ data });
      }
    };
    if (repository.$transaction) await repository.$transaction(persist);
    else await persist(repository);
    return persistedTaskIds;
  }

  private async resolveWorkflowTasks(
    scope: ReplyJobScope,
    conversationId: string,
    persistedTaskIds: string[],
    execution: TaskBundleExecution,
  ): Promise<{ execution: TaskBundleExecution; hasWorkflowResult: boolean; waitingApproval: boolean; failed: boolean }> {
    if (!persistedTaskIds.length || !this.workflowRouter) {
      return { execution, hasWorkflowResult: false, waitingApproval: false, failed: false };
    }
    const routed = await this.workflowRouter.route(scope, { conversationId, taskIds: persistedTaskIds });
    const repository = this.prisma as unknown as {
      task?: { findMany(input: unknown): Promise<Array<{ id: string; status: string; resultJson: unknown; errorCode: string | null; ownerWorkflowRunId: string | null; ownerWorkflowRun?: { status: string } | null }>> };
    };
    const rows = repository.task?.findMany
      ? await repository.task.findMany({
          where: { ...scope, conversationId, id: { in: persistedTaskIds } },
          include: { ownerWorkflowRun: { select: { status: true } } },
        })
      : [];
    const runStatuses = new Set<string>([
      ...routed.map((entry) => entry.status),
      ...rows.flatMap((row) => row.ownerWorkflowRun ? [row.ownerWorkflowRun.status] : []),
    ]);
    const waitingApproval = runStatuses.has('WAITING_APPROVAL') || runStatuses.has('RUNNING') || runStatuses.has('RECOVERING');
    const failed = ['FAILED', 'STALE', 'CANCELLED'].some((status) => runStatuses.has(status));
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    let hasWorkflowResult = false;
    const tasks = execution.tasks.map((task, index) => {
      const row = rowsById.get(persistedTaskIds[index] ?? '') ?? rows.find((candidate) => candidate.id.endsWith(`:${task.id}`));
      if (!row?.ownerWorkflowRunId) return task;
      const facts = asPlainRecord(row.resultJson);
      if (row.status === 'RESOLVED' && row.ownerWorkflowRun?.status === 'COMPLETED') hasWorkflowResult = true;
      return {
        ...task,
        status: taskStatus(row.status),
        ...(Object.keys(facts).length ? { facts } : {}),
        ...(row.errorCode ? { errorCode: row.errorCode } : { errorCode: undefined }),
      } satisfies TaskState;
    });
    return {
      execution: {
        ...execution,
        tasks,
        hasBlockingFailure: tasks.some((task) => task.blocking && task.status === 'FAILED'),
        canAutoReply: tasks.every((task) => task.status === 'RESOLVED' && task.riskLevel !== 'HIGH'),
      },
      hasWorkflowResult,
      waitingApproval,
      failed,
    };
  }
}

function taskStatus(value: string): TaskState['status'] {
  return ['OPEN', 'RUNNING', 'RESOLVED', 'AMBIGUOUS', 'FAILED', 'SUPERSEDED', 'CANCELLED'].includes(value)
    ? value as TaskState['status']
    : 'FAILED';
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function staleReasonFor(job: { conversation: { contextVersion: number; humanActive: boolean; state: string }; sourceContextVersion: number }): string | undefined {
  if (job.conversation.humanActive) return 'HUMAN_ACTIVE';
  if (job.conversation.state !== 'ACTIVE') return 'CONVERSATION_CLOSED';
  if (job.conversation.contextVersion !== job.sourceContextVersion) return 'CONTEXT_STALE';
  return undefined;
}

function toEvidence(value: {
  knowledgeItemId: string; knowledgeVersionId: string; knowledgeVersionNumber: number; sourceType: ReplyEvidenceSnapshot['source'];
  scope: ReplyEvidenceSnapshot['scope']; productId: string | null; retrievedContentSnapshotJson: unknown; retrievalScore: number | null;
}): ReplyEvidenceSnapshot {
  const snapshot = value.retrievedContentSnapshotJson as { question?: unknown; answer?: unknown };
  return {
    itemId: value.knowledgeItemId, versionId: value.knowledgeVersionId, version: value.knowledgeVersionNumber,
    source: value.sourceType, scope: value.scope, productId: value.productId,
    contentSnapshot: { question: String(snapshot.question ?? ''), answer: String(snapshot.answer ?? '') },
    retrievalScore: value.retrievalScore ?? 0,
  };
}

function cloneJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function forbiddenRules(value: unknown): Array<{ term: string; replacement: string }> {
  if (Array.isArray(value)) return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    return typeof record.term === 'string' ? [{ term: record.term, replacement: typeof record.replacement === 'string' ? record.replacement : '' }] : [];
  });
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([term, replacement]) => typeof replacement === 'string' ? [{ term, replacement }] : []);
}

function transferRequested(text: string, configured: unknown): boolean {
  const keywords = stringValues(configured);
  return ['人工', '客服', ...keywords].some((keyword) => keyword && text.includes(keyword));
}

function conservativeRecommendation(value: unknown): 'AUTO' | 'ASSIST' | 'MANUAL' | undefined {
  return value === 'AUTO' || value === 'ASSIST' || value === 'MANUAL' ? value : undefined;
}

function maxRisk(left: 'LOW' | 'MEDIUM' | 'HIGH', right: 'LOW' | 'MEDIUM' | 'HIGH'): 'LOW' | 'MEDIUM' | 'HIGH' {
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

/** A model may merge two explicit low-risk questions into one task. Keep its
 * plan, but deterministically restore obvious inventory/size intents so a
 * multi-intent turn cannot silently drop one of the buyer's questions. */
function augmentExplicitIntentTasks(text: string, tasks: IntentPlanTask[]): IntentPlanTask[] {
  const inventoryRequested = /库存|有货|还有|还剩|现货|缺货|售罄|(?:黑色|白色|红色|蓝色|绿色|灰色).{0,8}(?:有吗|有么|有货)/i.test(text);
  const sizeRequested = /尺码|尺寸|大小|合身|身高|体重|公斤|(?:^|[\s，,])(?:XXL|XL|XS|L|M|S)\s*(?:呢|多大|适合|怎么选|推荐|穿|吗|？|\?|$)/i.test(text);
  if (!inventoryRequested && !sizeRequested) return tasks.slice(0, 4);

  const augmented = tasks.filter((task) => task.intent !== 'UNKNOWN');
  if (inventoryRequested && !augmented.some((task) => /(?:^|_)INVENTORY(?:_|$)/.test(task.intent))) {
    augmented.push({ intent: 'INVENTORY_QUERY', riskLevel: 'LOW', requiredContext: ['PRODUCT', 'SKU'], requiredTools: ['GET_INVENTORY'] });
  }
  if (sizeRequested && !augmented.some((task) => task.intent === 'SIZE_RECOMMENDATION')) {
    augmented.push({ intent: 'SIZE_RECOMMENDATION', riskLevel: 'LOW', requiredContext: ['PRODUCT', 'SKU', 'CUSTOMER_MEMORY'], requiredTools: ['GET_PRODUCT'] });
  }
  return augmented.slice(0, 4);
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>)
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function cardContextId(cards: Array<{ kind: string; contentJson: unknown }>, kind: 'PRODUCT' | 'SKU' | 'ORDER'): string | undefined {
  const card = cards.find((entry) => (kind === 'ORDER' ? entry.kind === 'ORDER_CARD' : entry.kind === 'GOODS_CARD'));
  if (!card?.contentJson || typeof card.contentJson !== 'object' || Array.isArray(card.contentJson)) return undefined;
  const content = card.contentJson as Record<string, unknown>;
  const key = kind === 'ORDER' ? 'orderId' : kind === 'PRODUCT' ? 'productId' : 'skuId';
  return typeof content[key] === 'string' ? content[key] : undefined;
}

function contextPolicyStatus(
  contexts: Map<string, ReturnType<typeof resolveContext>>,
  hasEvidence: boolean,
): 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND' | 'STALE' {
  const values = [...contexts.values()];
  if (values.some((context) => context.status === 'STALE')) return 'STALE';
  if (values.some((context) => context.status === 'AMBIGUOUS')) return 'AMBIGUOUS';
  if (values.some((context) => context.status === 'NOT_FOUND')) return 'NOT_FOUND';
  return hasEvidence ? 'RESOLVED' : 'NOT_FOUND';
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function orderCandidate(row: { id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number }) {
  return {
    id: row.id, kind: 'ORDER' as const, label: row.externalOrderId,
    dynamic: { externalOrderId: row.externalOrderId, status: row.status, logistics: jsonRecord(row.logisticsSnapshotJson), version: row.version },
  };
}

function skuCandidate(row: { id: string; productId: string; externalSkuId: string; inventory: number; price: unknown; attributesJson: unknown }) {
  return {
    id: row.id, kind: 'SKU' as const, label: row.externalSkuId,
    dynamic: { productId: row.productId, externalSkuId: row.externalSkuId, inventory: row.inventory, price: String(row.price), attributes: jsonRecord(row.attributesJson) },
  };
}

/** Deterministic attribute selection: choose a unique highest token score; tie means clarification. */
function selectSkuMatches<T extends { attributesJson: unknown }>(rows: T[], text: string): T[] {
  const normalized = text.toLocaleLowerCase();
  const scored = rows.map((row) => {
    const attributes = jsonRecord(row.attributesJson);
    const score = attributes
      ? Object.values(attributes).filter((value) => typeof value === 'string' && value.trim().length > 0 && normalized.includes(value.trim().toLocaleLowerCase())).length
      : 0;
    return { row, score };
  });
  const maximum = Math.max(0, ...scored.map((entry) => entry.score));
  return maximum > 0 ? scored.filter((entry) => entry.score === maximum).map((entry) => entry.row) : rows;
}

/** Unlike the fallback selector, only return a current-turn explicit match. */
function explicitSkuMatches<T extends { externalSkuId: string; attributesJson: unknown }>(rows: T[], text: string): T[] {
  const normalized = text.toLocaleLowerCase();
  const scored = rows.map((row) => {
    const attributes = jsonRecord(row.attributesJson);
    const score = (row.externalSkuId.trim().length > 0 && normalized.includes(row.externalSkuId.trim().toLocaleLowerCase()) ? 1 : 0)
      + (attributes
        ? Object.values(attributes).filter((value) => typeof value === 'string' && value.trim().length > 0 && normalized.includes(value.trim().toLocaleLowerCase())).length
        : 0);
    return { row, score };
  });
  const maximum = Math.max(0, ...scored.map((entry) => entry.score));
  return maximum > 0 ? scored.filter((entry) => entry.score === maximum).map((entry) => entry.row) : [];
}

/** Summaries never supply operational truth; preserve only non-dynamic facts/open questions. */
function withoutDynamicFacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDynamicFacts);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(?:inventory|stock|price|order.?status|logistics|tracking|refund|payment|库存|价格|订单|物流|支付)/i.test(key))
    .map(([key, item]) => [key, withoutDynamicFacts(item)]));
}

function stableNarrative(value: string): string | undefined {
  // A summary may be stale. Do not let even a redacted old operational claim
  // reach the provider; live Resolver facts are the sole source for it.
  return /(?:库存\s*\d|\d\s*件|订单.{0,12}(?:已发货|待发货|物流|退款)|物流.{0,12}(?:单号|已|到)|价格\s*\d|支付)/i.test(value)
    ? undefined
    : value;
}

function clarificationRounds(value: unknown, kind: 'PRODUCT' | 'SKU' | 'ORDER'): number {
  const round = clarificationStates(value)[kind]?.round;
  return typeof round === 'number' && Number.isSafeInteger(round) && round >= 0 ? round : 0;
}

function clarificationStates(value: unknown): Record<string, { round: number; choices: Array<{ id: string; label: string }> }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const round = typeof item === 'number' ? item : jsonRecord(item)?.round;
    if (typeof round !== 'number' || !Number.isSafeInteger(round) || round < 0) return [];
    const choices = Array.isArray(jsonRecord(item)?.choices)
      ? (jsonRecord(item)!.choices as unknown[]).flatMap((choice) => {
        const record = jsonRecord(choice);
        return record && typeof record.id === 'string' && typeof record.label === 'string' ? [{ id: record.id, label: record.label }] : [];
      })
      : [];
    return [[key, { round, choices }]];
  }));
}

function clarificationChoiceId(value: unknown, kind: 'PRODUCT' | 'SKU' | 'ORDER', text: string): string | undefined {
  const normalized = text.trim().toLocaleLowerCase();
  if (!normalized) return undefined;
  const choices = clarificationStates(value)[kind]?.choices ?? [];
  const matches = choices.filter((choice) => normalized.includes(choice.label.toLocaleLowerCase()) || normalized.includes(choice.id.toLocaleLowerCase()));
  return matches.length === 1 ? matches[0]!.id : undefined;
}

function clarificationText(contexts: Map<string, ReturnType<typeof resolveContext>>): string | undefined {
  const requests = [...contexts.values()].flatMap((context) => context.clarification?.requests ?? []);
  if (!requests.length) return undefined;
  const lines = requests.map((request) => {
    const choices = request.choices.map((choice) => choice.label).filter(Boolean).join('、');
    return choices ? `${request.question} 可选：${choices}。` : request.question;
  });
  return lines.join('\n');
}

function explicitOrderMatches<T extends { externalOrderId: string }>(rows: T[], text: string): T[] {
  const normalized = text.toLocaleLowerCase();
  return rows.filter((row) => row.externalOrderId.trim().length > 0 && normalized.includes(row.externalOrderId.trim().toLocaleLowerCase()));
}

/** Controlled local rendering of current operational facts; never RAG/model truth. */
function dynamicReply(intent: string, entity: Record<string, unknown>): string | undefined {
  const dynamic = jsonRecord(entity.dynamic);
  if (!dynamic) return undefined;
  if (typeof dynamic.status === 'string' && /ORDER|LOGISTICS|SHIP/i.test(intent)) {
    const order = typeof dynamic.externalOrderId === 'string' ? `订单 ${dynamic.externalOrderId}` : '该订单';
    const logistics = jsonRecord(dynamic.logistics);
    const tracking = logistics && typeof logistics.trackingNumber === 'string' ? `，物流单号 ${logistics.trackingNumber}` : '';
    return `${order}当前状态为 ${dynamic.status}${tracking}。`;
  }
  if (typeof dynamic.inventory === 'number' && /SKU|INVENTORY|STOCK|PRODUCT/i.test(intent)) {
    const sku = typeof dynamic.externalSkuId === 'string' ? `规格 ${dynamic.externalSkuId}` : '该规格';
    return `${sku}当前可售库存为 ${dynamic.inventory}。`;
  }
  return undefined;
}
