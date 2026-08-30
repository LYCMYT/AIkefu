import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { ReplyEvidenceSnapshot } from '@ai-customer-service/contracts';
import { buildReply, buildReplyContext, checkForbiddenTerms, createTaskBundle, decideReplyPolicy, executeTaskBundle, guardReplyOutput, isTaskBlocking, mergeExplicitIntentTasks, renderCustomerFactReply, renderImageObservationReply, resolveContext, resolveSafeKnowledgeIntent, resolveSafeSocialReply, sanitizeContext, type PlannedTask, type TaskBundleExecution, type TaskState } from '@ai-customer-service/core';
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
import { autoReplyReady } from '../shops/shop-ai-readiness';

type ReplyGeneration = { text: string; requiresHuman: boolean };
type IntentPlanTask = {
  intent: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  requiredContext: string[];
  requiredKnowledge?: Array<'STORE' | 'PRODUCT'>;
  requiredTools: string[];
};

type TaskEvidenceLookup = {
  byTaskId: Map<string, ReplyEvidenceSnapshot[]>;
  evidence: ReplyEvidenceSnapshot[];
  hasConflict: boolean;
  conflictItemIds: string[];
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

    const safeSocial = resolveSafeSocialReply(job.userTurn.normalizedText);
    const safeKnowledgeIntent = safeSocial ? undefined : resolveSafeKnowledgeIntent(job.userTurn.normalizedText);
    let output: ReplyGeneration | undefined;
    try {
      const contextSupport = safeSocial ? {} : await this.buildContextSupport(scope, job);
      let plannedTasks: IntentPlanTask[];
      let classifierRisk: 'LOW' | 'MEDIUM' | 'HIGH';
      let recommendedMode: 'AUTO' | 'ASSIST' | 'MANUAL' | undefined;
      if (safeSocial) {
        plannedTasks = [{
          intent: `SAFE_SOCIAL_${safeSocial.intent}`,
          riskLevel: 'LOW', requiredContext: [], requiredTools: [],
        }];
        classifierRisk = 'LOW';
        recommendedMode = 'AUTO';
        void this.recordTrace(scope, job, 'BUILT_IN_SAFE_REPLY', { intent: safeSocial.intent });
      } else {
        const plannerContext = buildReplyContext({
          maxCharacters: 6_000,
          currentTurn: { text: job.userTurn.normalizedText },
          recentMessages: contextSupport.recentMessages,
          structuredFacts: contextSupport.structuredFacts,
          summary: contextSupport.conversationSummary,
          customerMemory: contextSupport.customerMemory,
        });
        void this.recordTrace(scope, job, 'CONTEXT_BUDGET', { purpose: 'INTENT_PLANNER', characters: plannerContext.characterCount, omittedSections: plannerContext.omittedSections, truncatedSections: plannerContext.truncatedSections });
        const intent = await this.runtime.runStructured<{ tasks: IntentPlanTask[] }>(scope, {
          purpose: 'INTENT_PLANNER', schema: 'IntentPlan', context: plannerContext.context,
          allowedDataClasses: ['turn', 'recentMessages', 'structuredFacts', 'summary', 'customerMemory'], promptVersion: 'reply-intent-plan-v1', evidence: [], ragStrategy: 'NONE', contextVersion: job.sourceContextVersion,
        });
        const modelPlannedTasks = augmentExplicitIntentTasks(job.userTurn.normalizedText, intent.output.tasks);
        const safeKnowledgeAuto = Boolean(safeKnowledgeIntent && modelPlannedTasks.every((task) =>
          task.intent === 'UNKNOWN' || task.intent === safeKnowledgeIntent));
        plannedTasks = safeKnowledgeAuto
          ? [{ intent: safeKnowledgeIntent!, riskLevel: 'LOW', requiredContext: [], requiredKnowledge: ['STORE'], requiredTools: [] }]
          : modelPlannedTasks;
        const risk = await this.runtime.runStructured<{ riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; reasons: string[]; recommendedMode: 'AUTO' | 'ASSIST' | 'MANUAL' }>(scope, {
          purpose: 'RISK_CLASSIFIER', schema: 'RiskResult',
          context: { tasks: plannedTasks.map((task) => ({ intent: task.intent, riskLevel: task.riskLevel })) },
          allowedDataClasses: ['tasks'], promptVersion: 'reply-risk-v1', evidence: [], ragStrategy: 'NONE', contextVersion: job.sourceContextVersion,
        });
        classifierRisk = safeKnowledgeAuto ? 'LOW' : risk.output.riskLevel;
        recommendedMode = safeKnowledgeAuto ? 'AUTO' : conservativeRecommendation(risk.output.recommendedMode);
        void this.recordTrace(scope, job, 'AI_USAGE', { invocations: [intent, risk].map((result) => ({ invocationId: result.invocationId, provider: result.provider, model: result.model, fallbackUsed: result.fallbackUsed })) });
      }
      const taskBundle = createTaskBundle({
        tasks: plannedTasks.slice(0, 4).map((task, index) => ({
          id: `${job.id}:${index}`, intent: task.intent, operation: 'READ' as const, riskLevel: maxRisk(task.riskLevel, classifierRisk),
          requiredContext: task.requiredContext, requiredKnowledge: task.requiredKnowledge,
          requiredTools: task.requiredTools, blocking: isTaskBlocking(task.requiredTools, task.riskLevel),
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
        const shop = await this.prisma.shop.findFirst({
          where: { id: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId },
          select: {
            aiMode: true,
            platform: true,
            seedKey: true,
            settingsConfirmedAt: true,
            productLearningJobs: {
              where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId },
              orderBy: { createdAt: 'desc' }, take: 1, select: { status: true },
            },
          },
        });
        const autoReady = this.shopAutoReady(shop);
        return this.enqueueClarification(
          scope,
          job,
          taskContexts,
          clarification,
          autoReady,
          shop?.aiMode === 'AUTO_ALLOWED' ? 'SHOP_AI_NOT_READY' : 'SHOP_AI_AUTO_DISABLED',
          taskBundle.tasks,
        );
      }
      const lookup = safeSocial
        ? { byTaskId: new Map<string, ReplyEvidenceSnapshot[]>(), evidence: [], hasConflict: false, conflictItemIds: [] }
        : await this.retrieveAndFreezeTaskEvidence(scope, job, taskBundle.tasks, taskContexts);
      const evidence = lookup.evidence;
      void this.recordTrace(scope, job, 'EVIDENCE', {
        evidenceCount: evidence.length,
        knowledgeVersionIds: evidence.map((entry) => entry.versionId),
        conflicted: lookup.hasConflict,
        tasks: [...lookup.byTaskId.entries()].map(([taskId, entries]) => ({ taskId, knowledgeVersionIds: entries.map((entry) => entry.versionId) })),
      });
      if (safeKnowledgeIntent) void this.recordTrace(scope, job, 'SAFE_KNOWLEDGE_POLICY', { intent: safeKnowledgeIntent, evidenceCount: evidence.length });
      // A conflict in any Task-scoped retrieval blocks the whole customer
      // reply, but the canonical Tasks and MANUAL policy decision still need
      // to be durable.  Operators and quality evaluation must never see a
      // generic draft with the original customer intent missing.
      if (lookup.hasConflict) {
        const conflictExecution = await executeTaskBundle(taskBundle, async () => ({
          status: 'FAILED' as const,
          errorCode: 'KNOWLEDGE_CONFLICT',
        }));
        await this.persistTasks(
          scope,
          job.id,
          job.conversationId,
          job.userTurnId,
          conflictExecution.tasks,
          false,
        );
        await this.recordTrace(scope, job, 'TASKS', {
          tasks: conflictExecution.tasks.map((task) => ({
            id: task.id,
            status: task.status,
            riskLevel: task.riskLevel,
            errorCode: task.errorCode ?? null,
          })),
        });
        await this.recordTrace(scope, job, 'REPLY_POLICY', {
          mode: 'MANUAL',
          reasons: ['CONTEXT_CONFLICT'],
          evidenceCount: 0,
          taskStatuses: conflictExecution.tasks.map((task) => task.status),
        });
        return this.waitForHuman(scope, job, 'CONTEXT_CONFLICT');
      }
      let execution = await executeTaskBundle(taskBundle, async (task) => {
        const context = taskContexts.get(task.id);
        if (context && context.status !== 'RESOLVED') {
          return { status: 'AMBIGUOUS' as const, errorCode: `CONTEXT_${context.status}` };
        }
        const dynamicReplyText = context?.entity ? dynamicReply(task.intent, context.entity as unknown as Record<string, unknown>) : undefined;
        const builtInReplyText = safeSocial && task.intent === `SAFE_SOCIAL_${safeSocial.intent}` ? safeSocial.text : undefined;
        const imageObservationText = renderImageObservationReply(task.intent, job.userTurn.normalizedText);
        const deterministicReplyText = builtInReplyText ?? imageObservationText ?? dynamicReplyText;
        const taskEvidence = lookup.byTaskId.get(task.id) ?? [];
        if (taskEvidence.length === 0 && !deterministicReplyText) return { status: 'FAILED' as const, errorCode: 'NO_EVIDENCE' };
        return {
          status: 'RESOLVED' as const,
          facts: {
            reply: deterministicReplyText ?? taskEvidence[0]!.contentSnapshot.answer,
            ...(builtInReplyText ? { source: 'SYSTEM_SAFE_REPLY' } : imageObservationText ? { source: 'SANITIZED_IMAGE_ANALYSIS' } : {}),
            ...(context?.entity ? { context: context.entity } : {}),
          },
          evidence: taskEvidence.map((entry) => entry.versionId),
        };
      });
      const persistedTaskIds = await this.persistTasks(scope, job.id, job.conversationId, job.userTurnId, execution.tasks);
      const workflow = await this.resolveWorkflowTasks(scope, job.conversationId, persistedTaskIds, execution);
      if (workflow.waitingApproval) return this.waitForHuman(scope, job, 'WORKFLOW_APPROVAL_REQUIRED');
      if (workflow.failed) return this.waitForHuman(scope, job, 'WORKFLOW_FAILED');
      execution = workflow.execution;
      void this.recordTrace(scope, job, 'TASKS', { tasks: execution.tasks.map((task) => ({ id: task.id, status: task.status, riskLevel: task.riskLevel, errorCode: task.errorCode ?? null })) });
      const [shop, settings] = await Promise.all([
        this.prisma.shop.findFirst({
          where: { id: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId },
          select: {
            aiMode: true,
            platform: true,
            seedKey: true,
            settingsConfirmedAt: true,
            productLearningJobs: {
              where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId },
              orderBy: { createdAt: 'desc' }, take: 1, select: { status: true },
            },
          },
        }),
        this.prisma.shopSettings.findFirst({
          where: { shopId: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId },
          select: {
            tone: true, logisticsPolicy: true, shippingPolicy: true, afterSalesPolicy: true,
            forbiddenTermsJson: true, transferKeywordsJson: true,
          },
        }),
      ]);
      const policy = decideReplyPolicy({
        shopMode: shop?.aiMode === 'MANUAL_ONLY'
          ? 'MANUAL_ONLY'
          : this.shopAutoReady(shop) ? 'AUTO_ALLOWED' : 'ASSIST_ONLY',
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
        recommendedMode,
      });
      void this.recordTrace(scope, job, 'REPLY_POLICY', { mode: policy.mode, reasons: policy.reasons, evidenceCount: evidence.length, taskStatuses: execution.tasks.map((task) => task.status) });
      if (policy.mode === 'MANUAL') {
        return this.waitForHuman(scope, job, policy.reasons.join(',') || 'MANUAL_REQUIRED');
      }
      const composeFinalReply = async () => {
          const taskResults = execution.tasks.map((task) => ({
            id: task.id, intent: task.intent, status: task.status, facts: task.facts,
            evidence: task.evidence, errorCode: task.errorCode ?? null,
          }));
          const composerContext = buildReplyContext({
            maxCharacters: 12_000,
            currentTurn: { text: job.userTurn.normalizedText },
            tasks: taskResults,
            realtimeFacts: execution.tasks.flatMap((task) => task.facts?.context ? [{ taskId: task.id, context: task.facts.context }] : []),
            evidence: evidence.map((entry) => ({
              versionId: entry.versionId, question: entry.contentSnapshot.question,
              answer: entry.contentSnapshot.answer, source: entry.source, scope: entry.scope, productId: entry.productId,
            })),
            recentMessages: contextSupport.recentMessages,
            structuredFacts: contextSupport.structuredFacts,
            summary: contextSupport.conversationSummary,
            customerMemory: contextSupport.customerMemory,
            shopSettings: settings ? {
              tone: settings.tone,
              logisticsPolicy: settings.logisticsPolicy,
              shippingPolicy: settings.shippingPolicy,
              afterSalesPolicy: settings.afterSalesPolicy,
            } : undefined,
            channel: shop?.platform,
          });
          void this.recordTrace(scope, job, 'CONTEXT_BUDGET', { purpose: 'REPLY_GENERATION', characters: composerContext.characterCount, omittedSections: composerContext.omittedSections, truncatedSections: composerContext.truncatedSections });
          const result = await this.runtime.runStructured<ReplyGeneration>(scope, {
            purpose: 'REPLY_GENERATION', schema: 'ReplyGeneration',
            context: composerContext.context,
            allowedDataClasses: ['turn', 'tasks', 'realtimeFacts', 'evidence', 'recentMessages', 'structuredFacts', 'summary', 'customerMemory', 'shopSettings', 'channel'],
            promptVersion: 'reply-composer-v1', evidence,
            ragStrategy: evidence.length ? 'TASK_SCOPED_KNOWLEDGE_SNAPSHOT' : 'NO_EVIDENCE', contextVersion: job.sourceContextVersion,
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
      const outputGuard = guardReplyOutput({
        text: built.text,
        taskResults: execution.tasks.map((task) => ({ intent: task.intent, facts: task.facts })),
      });
      if (!outputGuard.allowed) {
        void this.recordTrace(scope, job, 'OUTPUT_GUARD', { allowed: false, reason: outputGuard.reason });
        return this.waitForHuman(scope, job, `OUTPUT_GUARD_${outputGuard.reason}`);
      }
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

    const autoSend = await this.commitAutoSend(scope, job, text);
    if (!autoSend.committed) return { status: 'STALE', reason: autoSend.reason ?? 'REPLY_JOB_CLAIM_LOST' };
    this.publishRefresh(scope, job.conversationId, 'CONVERSATION_UPDATED', job.id);
    return { status: 'READY_TO_SEND' };
  }

  /** READY is never durable without its matching immutable send intent. */
  private async commitAutoSend(
    scope: ReplyJobScope,
    job: { id: string; conversationId: string; sourceContextVersion: number; sourceLastMessageId?: string | null; sourceSequence: number },
    text: string,
  ): Promise<{ committed: boolean; reason?: string }> {
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
      if (!marked.count) return { committed: false, reason: 'REPLY_JOB_CLAIM_LOST' };
      await this.sendOutboxes.enqueue(scope, input);
      return { committed: true };
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
        return { committed: false, reason: 'SEND_CONTEXT_STALE' };
      }
      // The policy decision may be minutes older than this durable commit.
      // Re-read the scoped Shop and newest durable learning result inside the
      // same transaction: AUTO can never materialize a send intent after its
      // readiness has regressed or the master ceiling was turned off.
      const shop = await tx.shop.findFirst({
        where: { id: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId },
        select: {
          aiMode: true,
          seedKey: true,
          settingsConfirmedAt: true,
          productLearningJobs: {
            where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true },
          },
        },
      });
      if (!this.shopAutoReady(shop)) {
        const reason = shop?.aiMode === 'AUTO_ALLOWED' ? 'SHOP_AI_NOT_READY' : 'SHOP_AI_AUTO_DISABLED';
        const invalidated = await tx.replyJob.updateMany({
          where: { id: job.id, ...scope, status: 'GENERATING', sourceContextVersion: job.sourceContextVersion },
          data: { status: 'STALE', staleReason: reason },
        });
        return invalidated.count
          ? { committed: false, reason }
          : { committed: false, reason: 'REPLY_JOB_CLAIM_LOST' };
      }
      const marked = await tx.replyJob.updateMany({
        where: { id: job.id, ...scope, status: 'GENERATING', sourceContextVersion: job.sourceContextVersion }, data: { status: 'FAST_PATH_READY' },
      });
      if (!marked.count) return { committed: false, reason: 'REPLY_JOB_CLAIM_LOST' };
      // A throw rolls back the READY transition with the missing outbox,
      // leaving only the original GENERATING job for recovery to claim/stale.
      await outboxes.enqueueInTransaction!(tx, scope, input);
      return { committed: true };
    });
  }

  private async retrieveAndFreezeTaskEvidence(
    scope: ReplyJobScope,
    job: { id: string; userTurn: { normalizedText: string }; evidences: Array<Parameters<typeof toEvidence>[0]> },
    tasks: Array<{ id: string; intent: string; requiredKnowledge?: Array<'STORE' | 'PRODUCT'> }>,
    contexts: Map<string, ReturnType<typeof resolveContext>>,
  ): Promise<TaskEvidenceLookup> {
    const existing = job.evidences.map(toEvidence);
    const byTaskId = new Map<string, ReplyEvidenceSnapshot[]>();
    const collected = new Map<string, ReplyEvidenceSnapshot>(existing.map((entry) => [entry.versionId, entry]));
    const conflictItemIds = new Set<string>();
    let hasConflict = false;

    for (const task of tasks) {
      const scopes = knowledgeScopesForTask(task, contexts.get(task.id));
      if (!scopes.length) {
        byTaskId.set(task.id, []);
        continue;
      }
      const productId = resolvedProductId(contexts.get(task.id));
      const reusable = existing.filter((entry) => scopes.includes(entry.scope) && (entry.scope !== 'PRODUCT' || entry.productId === productId));
      if (reusable.length) {
        byTaskId.set(task.id, reusable);
        continue;
      }
      const taskEvidence: ReplyEvidenceSnapshot[] = [];
      for (const knowledgeScope of scopes) {
        if (knowledgeScope === 'PRODUCT' && !productId) continue;
        const result = await this.knowledge.search(scope, {
          shopId: scope.shopId,
          query: job.userTurn.normalizedText,
          scope: knowledgeScope,
          ...(knowledgeScope === 'PRODUCT' && productId ? { productId } : {}),
          topK: 3,
        });
        if (result.status === 'CONFLICTED') {
          hasConflict = true;
          result.conflictItemIds.forEach((id) => conflictItemIds.add(id));
          continue;
        }
        if (result.status !== 'EVIDENCE') continue;
        for (const entry of result.evidence) {
          const frozen = { ...entry, contentSnapshot: { ...entry.contentSnapshot } };
          collected.set(frozen.versionId, frozen);
          taskEvidence.push(frozen);
        }
      }
      byTaskId.set(task.id, uniqueEvidence(taskEvidence));
    }

    const evidence = [...collected.values()];
    const existingIds = new Set(existing.map((entry) => entry.versionId));
    const newEvidence = evidence.filter((entry) => !existingIds.has(entry.versionId));
    if (newEvidence.length > 0) {
      await this.prisma.replyEvidence.createMany({
        data: newEvidence.map((entry) => ({
          ...scope, replyJobId: job.id, knowledgeItemId: entry.itemId, knowledgeVersionId: entry.versionId,
          knowledgeVersionNumber: entry.version, sourceType: entry.source, scope: entry.scope,
          productId: entry.productId, retrievedContentSnapshotJson: cloneJson(entry.contentSnapshot), retrievalScore: entry.retrievalScore,
        })),
      });
    }
    return { byTaskId, evidence, hasConflict, conflictItemIds: [...conflictItemIds] };
  }

  /** P5/P6 context is read-only, scoped, expired rows excluded, then sanitized before any provider call. */
  private async buildContextSupport(
    scope: ReplyJobScope,
    job: { conversationId: string; conversation: { buyerId: string } },
  ): Promise<Record<string, unknown>> {
    const repository = this.prisma as unknown as {
      conversationMemory?: { findFirst(input: unknown): Promise<{ narrative: string; structuredFactsJson: unknown; status: string } | null> };
      customerMemory?: { findMany(input: unknown): Promise<Array<{ type: string; key: string; valueJson: unknown }>> };
      message?: { findMany(input: unknown): Promise<Array<{ role: string; kind: string; contentJson: unknown; sequence: number }>> };
    };
    const [memory, memories, recentRows] = await Promise.all([
      repository.conversationMemory?.findFirst({
        where: { ...scope, conversationId: job.conversationId, status: 'CLEAN' },
        select: { narrative: true, structuredFactsJson: true, status: true },
      }) ?? Promise.resolve(null),
      repository.customerMemory?.findMany({
        where: { ...scope, buyerId: job.conversation.buyerId, status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        orderBy: { updatedAt: 'desc' }, take: 6, select: { type: true, key: true, valueJson: true },
      }) ?? Promise.resolve([]),
      repository.message?.findMany({
        where: { ...scope, conversationId: job.conversationId, status: { notIn: ['RECALLED', 'DELETED'] } },
        orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }], take: 12,
        select: { role: true, kind: true, contentJson: true, sequence: true },
      }) ?? Promise.resolve([]),
    ]);
    const safeCustomerMemory = memories.flatMap((entry) => {
      const sanitized = sanitizeContext({ customerMemory: { type: entry.type, key: entry.key, value: entry.valueJson } }, ['customerMemory']);
      return sanitized.audit.excludedPII.length === 0 ? [sanitized.value.customerMemory] : [];
    });
    const recentMessages = recentRows.slice().reverse().flatMap((message) => {
      const text = messageText(message.contentJson);
      return text ? [{ role: message.role, kind: message.kind, text, sequence: message.sequence }] : [];
    });
    const safe = sanitizeContext({
      ...(memory && stableNarrative(memory.narrative) ? { conversationSummary: { narrative: stableNarrative(memory.narrative) } } : {}),
      ...(memory ? { structuredFacts: withoutDynamicFacts(memory.structuredFactsJson) } : {}),
      ...(recentMessages.length ? { recentMessages } : {}),
      ...(safeCustomerMemory.length ? { customerMemory: safeCustomerMemory } : {}),
    }, ['conversationSummary', 'structuredFacts', 'recentMessages', 'customerMemory']);
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
      order?: { findMany(input: unknown): Promise<Array<{ id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number; product?: { title: string } }>>; findFirst?: (input: unknown) => Promise<{ id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number; product?: { title: string } } | null> };
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
      order?: { findMany(input: unknown): Promise<Array<{ id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number; product?: { title: string } }>>; findFirst?: (input: unknown) => Promise<{ id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number; product?: { title: string } } | null> };
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
        const row = await repository.order.findFirst({ where: { id: exactId, ...scope, buyerId }, select: { id: true, externalOrderId: true, status: true, logisticsSnapshotJson: true, version: true, product: { select: { title: true } } } });
        return row ? [orderCandidate(row)] : [];
      }
      // A buyer who explicitly names another scoped order in this turn wins
      // over the older conversation selection.  Keep this bounded, but broad
      // enough that a recently selected order cannot hide the named one.
      const rows = await repository.order.findMany({ where: { ...scope, buyerId, ...(exactId ? { id: exactId } : {}) }, orderBy: { orderedAt: 'desc' }, take: exactId ? 1 : 25, select: { id: true, externalOrderId: true, status: true, logisticsSnapshotJson: true, version: true, product: { select: { title: true } } } });
      const textMatches = explicitOrderMatches(rows, options.text);
      if (textMatches.length) return textMatches.map(orderCandidate);
      if (options.preferredId && repository.order.findFirst) {
        const row = await repository.order.findFirst({ where: { id: options.preferredId, ...scope, buyerId }, select: { id: true, externalOrderId: true, status: true, logisticsSnapshotJson: true, version: true, product: { select: { title: true } } } });
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
    autoSend: boolean,
    manualReason: string,
    plannedTasks: PlannedTask[],
  ): Promise<
    | { status: 'READY_TO_SEND' | 'STALE'; reason?: string }
    | { status: 'WAITING_HUMAN'; draftId: string; reason: string }
  > {
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
      if (!persisted.count) return { committed: false, reason: 'CLARIFICATION_CAS_LOST' } as const;
      const taskRepository = tx as unknown as { task?: { createMany(input: unknown): Promise<unknown> } };
      const plannedById = new Map(plannedTasks.map((task) => [task.id, task]));
      const clarificationTasks = [...contexts.entries()].flatMap(([taskId, context], index) => {
        if (!context.clarification) return [];
        const planned = plannedById.get(taskId);
        return [{
          id: planned ? `reply-task:${job.id}:${planned.id}` : `reply-task:${job.id}:clarification:${index}`,
          ...scope,
          conversationId: job.conversationId,
          userTurnId: job.userTurnId,
          intent: planned?.intent ?? 'CLARIFICATION',
          operation: planned?.operation ?? 'READ',
          riskLevel: planned?.riskLevel ?? 'LOW',
          requiredContextJson: planned?.requiredContext ?? context.clarification.requests.map((request) => request.kind),
          requiredKnowledgeJson: planned?.requiredKnowledge ?? [],
          requiredToolsJson: planned?.requiredTools ?? [],
          status: 'AMBIGUOUS',
          blocking: planned?.blocking ?? false,
          resultJson: cloneJson({ clarification: context.clarification }),
        }];
      });
      if (clarificationTasks.length && taskRepository.task) await taskRepository.task.createMany({ data: clarificationTasks, skipDuplicates: true });
      // ASSIST_ONLY and not-yet-ready AUTO shops may retain the useful
      // clarification plan, but they must never create an AI send intent.
      // ReplyDraftService performs the later GENERATING -> WAITING_HUMAN CAS.
      if (!autoSend) return { committed: true } as const;
      // Planning readiness is only advisory. The master switch or durable
      // learning projection can change while task context is resolved, so the
      // final clarification transition must repeat the same scoped fence as a
      // normal AUTO reply inside this transaction.
      const shop = await tx.shop.findFirst({
        where: { id: scope.shopId, workspaceId: scope.workspaceId, tenantId: scope.tenantId },
        select: {
          aiMode: true,
          seedKey: true,
          settingsConfirmedAt: true,
          productLearningJobs: {
            where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true },
          },
        },
      });
      if (!this.shopAutoReady(shop)) {
        const reason = shop?.aiMode === 'AUTO_ALLOWED' ? 'SHOP_AI_NOT_READY' : 'SHOP_AI_AUTO_DISABLED';
        const invalidated = await tx.replyJob.updateMany({
          where: { id: job.id, ...scope, status: 'GENERATING', sourceContextVersion: job.sourceContextVersion },
          data: { status: 'STALE', staleReason: reason },
        });
        return invalidated.count
          ? { committed: false, reason } as const
          : { committed: false, reason: 'CLARIFICATION_CAS_LOST' } as const;
      }
      const ready = await tx.replyJob.updateMany({
        where: { id: job.id, ...scope, status: 'GENERATING', sourceContextVersion: job.sourceContextVersion },
        data: { status: 'FAST_PATH_READY', staleReason: 'CLARIFICATION_ROUND' },
      });
      if (!ready.count) return { committed: false, reason: 'CLARIFICATION_CAS_LOST' } as const;
      await this.sendOutboxes.enqueueInTransaction(tx, scope, {
        replyJobId: job.id, conversationId: job.conversationId, text,
        idempotencyKey: `clarification:${job.id}:${JSON.stringify(rounds)}`,
        expectedLastMessageId: job.sourceLastMessageId ?? undefined, expectedSequence: job.sourceSequence,
        expectedContextVersion: job.sourceContextVersion,
      });
      return { committed: true } as const;
    });
    if (!result.committed) return { status: 'STALE', reason: result.reason };
    if (!autoSend) return this.waitForHuman(scope, job, manualReason, text);
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
    draftText = '请人工处理此会话。',
  ): Promise<{ status: 'WAITING_HUMAN'; draftId: string; reason: string } | { status: 'STALE'; reason: string }> {
    // ReplyDraftService owns the atomic GENERATING/PENDING -> WAITING_HUMAN
    // transition.  Updating it first would make the draft deliberately reject
    // its own source job and strand a worker in an inconsistent state.
    let draft: { id: string };
    try {
      draft = await this.drafts.createWaitingHuman(scope, {
        replyJobId: job.id, aiDraft: draftText, sourceContextVersion: job.sourceContextVersion,
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

  private shopAutoReady(shop: {
    aiMode: string;
    seedKey?: string;
    settingsConfirmedAt?: Date | null;
    productLearningJobs?: Array<{ status: string }>;
  } | null): boolean {
    return Boolean(shop && autoReplyReady({
      aiMode: shop.aiMode,
      seedKey: shop.seedKey,
      settingsConfirmed: shop.settingsConfirmedAt === undefined ? true : Boolean(shop.settingsConfirmedAt),
      learningStatus: shop.productLearningJobs?.[0]?.status,
    }));
  }

  private async recordTrace(scope: ReplyJobScope, job: { id: string; conversationId: string }, stage: string, payload: Record<string, unknown>): Promise<void> {
    try { await this.traces?.record({ ...scope, conversationId: job.conversationId, replyJobId: job.id }, `reply-job:${job.id}`, stage, payload); } catch { /* tracing is advisory */ }
  }

  private async persistTasks(
    scope: ReplyJobScope,
    replyJobId: string,
    conversationId: string,
    userTurnId: string,
    tasks: Array<{ id: string; intent: string; operation: 'READ' | 'WRITE'; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; requiredContext: string[]; requiredKnowledge?: Array<'STORE' | 'PRODUCT'>; requiredTools: string[]; status: string; facts?: Record<string, unknown>; evidence?: string[]; errorCode?: string; blocking: boolean }>,
    routeWorkflow = true,
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
          requiredKnowledgeJson: task.requiredKnowledge ?? [], requiredToolsJson: task.requiredTools, status: task.status,
          ...((task.facts || task.evidence?.length) ? { resultJson: { ...(task.facts ?? {}), evidenceVersionIds: task.evidence ?? [] } } : {}),
          errorCode: task.errorCode, blocking: task.blocking,
        })),
        skipDuplicates: true,
      });
      // This route intent is committed in the same short transaction as the
      // Task rows. A restart can therefore claim it later; no in-memory only
      // callback owns a workflow task.
      if (routeWorkflow && tx.processingOutbox) {
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
  return mergeExplicitIntentTasks(text, tasks);
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

function orderCandidate(row: { id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number; product?: { title: string } }) {
  return {
    id: row.id, kind: 'ORDER' as const,
    label: row.product?.title ? `${row.product.title}（订单 ${row.externalOrderId}）` : row.externalOrderId,
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
      ? Object.entries(attributes).filter(([key, value]) => typeof value === 'string' && attributeValueMentioned(normalized, key, value)).length
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
        ? Object.entries(attributes).filter(([key, value]) => typeof value === 'string' && attributeValueMentioned(normalized, key, value)).length
        : 0);
    return { row, score };
  });
  const maximum = Math.max(0, ...scored.map((entry) => entry.score));
  return maximum > 0 ? scored.filter((entry) => entry.score === maximum).map((entry) => entry.row) : [];
}

/** Size tokens must match as whole ASCII tokens: `L` is not a mention of `XL`. */
function attributeValueMentioned(normalizedText: string, key: string, rawValue: string): boolean {
  const value = rawValue.trim().toLocaleLowerCase();
  if (!value) return false;
  if (/(?:size|尺码)/i.test(key) && /^[a-z0-9]+$/i.test(value)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(normalizedText);
  }
  return normalizedText.includes(value);
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

export function explicitOrderMatches<T extends { externalOrderId: string; product?: { title: string } }>(rows: T[], text: string): T[] {
  const normalized = text.toLocaleLowerCase();
  const direct = rows.filter((row) => row.externalOrderId.trim().length > 0 && normalized.includes(row.externalOrderId.trim().toLocaleLowerCase()));
  if (direct.length) return direct;
  const tokens = orderReferenceTokens(normalized);
  if (!tokens.length) return [];
  return rows.filter((row) => {
    const title = row.product?.title.trim().toLocaleLowerCase() ?? '';
    return title.length > 0 && tokens.some((token) => title.includes(token));
  });
}

function orderReferenceTokens(text: string): string[] {
  const withoutGenericWords = text
    .replace(/(?:怎么没动|到哪了|我的|那个|这个|那笔|这笔|快递|物流|订单|昨天|想问|请问|怎么|没动|到哪|有吗|呢|吗)/giu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return [...new Set(withoutGenericWords.split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => /[\p{Script=Han}]{2,}/u.test(token) || /^[a-z0-9]{3,}$/iu.test(token)))];
}

function knowledgeScopesForTask(
  task: { intent: string; requiredKnowledge?: Array<'STORE' | 'PRODUCT'> },
  context: ReturnType<typeof resolveContext> | undefined,
): Array<'STORE' | 'PRODUCT'> {
  if (isDynamicFactIntent(task.intent) || /REFUND|EXCHANGE|COMPLAINT|HUMAN/i.test(task.intent)) return [];
  if (task.requiredKnowledge?.length) return [...new Set(task.requiredKnowledge)];
  if (/PRODUCT|SIZE|CARE|MATERIAL|SPECIFICATION|RECOMMENDATION/i.test(task.intent)) {
    return resolvedProductId(context) ? ['PRODUCT'] : [];
  }
  return ['STORE'];
}

function isDynamicFactIntent(intent: string): boolean {
  return /(?:^|_)(?:INVENTORY|STOCK|ORDER|LOGISTICS)(?:_|$)/i.test(intent);
}

function resolvedProductId(context: ReturnType<typeof resolveContext> | undefined): string | undefined {
  if (context?.status !== 'RESOLVED' || !context.entity) return undefined;
  if (context.entity.kind === 'PRODUCT') return context.entity.id;
  if (context.entity.kind !== 'SKU') return undefined;
  const dynamic = jsonRecord((context.entity as unknown as Record<string, unknown>).dynamic);
  return typeof dynamic?.productId === 'string' ? dynamic.productId : undefined;
}

function uniqueEvidence(evidence: ReplyEvidenceSnapshot[]): ReplyEvidenceSnapshot[] {
  return [...new Map(evidence.map((entry) => [entry.versionId, entry])).values()];
}

function messageText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'caption']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 1_000);
  }
  return undefined;
}

/** Controlled local rendering of current operational facts; never RAG/model truth. */
function dynamicReply(intent: string, entity: Record<string, unknown>): string | undefined {
  const dynamic = jsonRecord(entity.dynamic);
  if (!dynamic) return undefined;
  return renderCustomerFactReply(intent, dynamic);
}
