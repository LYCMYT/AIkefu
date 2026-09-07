import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { ReplyEvidenceSnapshot } from '@ai-customer-service/contracts';
import { buildReply, buildReplyContext, checkForbiddenTerms, createTaskBundle, decideReplyPolicy, executeTaskBundle, guardReplyOutput, inferExplicitIntentTasks, isTaskBlocking, mergeExplicitIntentTasks, renderCustomerFactReply, renderImageObservationReply, resolveContext, resolveSafeKnowledgeIntent, resolveSafeSocialReply, sanitizeContext, type PlannedTask, type TaskBundleExecution, type TaskState } from '@ai-customer-service/core';
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
import { AiEvalSimulatedCrash } from '../eval/ai-eval-fault-registry';

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

type TaskBoundEvidenceSnapshot = ReplyEvidenceSnapshot & { taskKey?: string };

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
    if (staleReason) {
      if (staleReason === 'HUMAN_ACTIVE') {
        const explicitTasks = inferExplicitIntentTasks(job.userTurn.normalizedText);
        if (explicitTasks.length) {
          // Human takeover forbids every model/composer/send call, but keeping
          // deterministic intent metadata lets the operator inbox retain the
          // customer's requested work and required read tools.
          await this.persistTasks(scope, job.id, job.conversationId, job.userTurnId, explicitTasks.map((task, index) => ({
            id: `human-active:${index}`,
            intent: task.intent,
            operation: 'READ' as const,
            riskLevel: task.riskLevel,
            requiredContext: task.requiredContext,
            requiredKnowledge: task.requiredKnowledge,
            requiredTools: task.requiredTools,
            status: 'CANCELLED',
            errorCode: 'HUMAN_ACTIVE',
            blocking: isTaskBlocking(task.requiredTools, task.riskLevel),
          })), false);
        }
      }
      return this.stale(scope, job.id, job.status, staleReason);
    }
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
      const inferenceText = intentInferenceText(job.userTurn.normalizedText, contextSupport.recentMessages);
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
        const explicitTasks = inferExplicitIntentTasks(inferenceText);
        let intentInvocation: { invocationId: string; provider: string; model: string; fallbackUsed: boolean } | undefined;
        let modelPlannedTasks: IntentPlanTask[];
        try {
          const intent = await this.runtime.runStructured<{ tasks: IntentPlanTask[] }>(scope, {
            purpose: 'INTENT_PLANNER', schema: 'IntentPlan', context: plannerContext.context,
            allowedDataClasses: ['turn', 'recentMessages', 'structuredFacts', 'summary', 'customerMemory'], promptVersion: 'reply-intent-plan-v1', evidence: [], ragStrategy: 'NONE', contextVersion: job.sourceContextVersion,
          });
          intentInvocation = intent;
          modelPlannedTasks = augmentExplicitIntentTasks(inferenceText, intent.output.tasks);
        } catch (error) {
          if (!safeKnowledgeIntent && explicitTasks.length === 0) throw error;
          // Structured model output is advisory for lexically unambiguous
          // customer-service requests. The fallback identifies only the Task;
          // live resolvers and frozen Evidence remain the sole fact sources.
          modelPlannedTasks = explicitTasks;
          void this.recordTrace(scope, job, 'DETERMINISTIC_INTENT_FALLBACK', {
            reason: error instanceof Error ? error.name : 'INTENT_PLANNER_FAILED',
            explicitIntents: explicitTasks.map((task) => task.intent),
            safeKnowledgeIntent: safeKnowledgeIntent ?? null,
          });
        }
        // The allow-list matcher rejects mixed action/order text, so a model
        // cannot turn an exact store-policy question into an order lookup.
        const safeKnowledgeAuto = Boolean(safeKnowledgeIntent);
        plannedTasks = safeKnowledgeAuto
          ? [{ intent: safeKnowledgeIntent!, riskLevel: 'LOW', requiredContext: [], requiredKnowledge: ['STORE'], requiredTools: [] }]
          : modelPlannedTasks;
        let riskOutput: { riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; reasons: string[]; recommendedMode: 'AUTO' | 'ASSIST' | 'MANUAL' } | undefined;
        let riskInvocation: { invocationId: string; provider: string; model: string; fallbackUsed: boolean } | undefined;
        try {
          const risk = await this.runtime.runStructured<{ riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; reasons: string[]; recommendedMode: 'AUTO' | 'ASSIST' | 'MANUAL' }>(scope, {
            purpose: 'RISK_CLASSIFIER', schema: 'RiskResult',
            context: { tasks: plannedTasks.map((task) => ({ intent: task.intent, riskLevel: task.riskLevel })) },
            allowedDataClasses: ['tasks'], promptVersion: 'reply-risk-v1', evidence: [], ragStrategy: 'NONE', contextVersion: job.sourceContextVersion,
          });
          riskOutput = risk.output;
          riskInvocation = risk;
        } catch (error) {
          if (!safeKnowledgeAuto && explicitTasks.length === 0) throw error;
          void this.recordTrace(scope, job, 'DETERMINISTIC_RISK_FALLBACK', {
            reason: error instanceof Error ? error.name : 'RISK_CLASSIFIER_FAILED',
            explicitIntents: explicitTasks.map((task) => task.intent),
          });
        }
        const deterministicRisk = plannedTasks.reduce<'LOW' | 'MEDIUM' | 'HIGH'>((current, task) => maxRisk(current, task.riskLevel), 'LOW');
        if (safeKnowledgeAuto || explicitTasks.length > 0) {
          classifierRisk = deterministicRisk;
          recommendedMode = riskModeFor(deterministicRisk);
        } else {
          if (!riskOutput) throw new Error('RISK_CLASSIFIER_RESULT_MISSING');
          classifierRisk = riskOutput.riskLevel;
          recommendedMode = conservativeRecommendation(riskOutput.recommendedMode);
        }
        void this.recordTrace(scope, job, 'AI_USAGE', { invocations: [intentInvocation, riskInvocation].filter((result): result is NonNullable<typeof result> => Boolean(result)).map((result) => ({ invocationId: result.invocationId, provider: result.provider, model: result.model, fallbackUsed: result.fallbackUsed })) });
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
        const clarification = clarificationText(taskContexts, taskBundle.tasks);
        if (!clarification) await this.persistResolvedContexts(scope, job, taskContexts);
        return { taskContexts, clarification };
      });
      const { taskContexts, clarification } = resolvedContexts;
      void this.recordTrace(scope, job, 'CONTEXT', { contexts: [...taskContexts.entries()].map(([taskId, context]) => ({ taskId, status: context.status, entitySelected: Boolean(context.entity), manualRequired: context.manualRequired })) });
      if (clarification) {
        // Store policies remain useful and auditable while an entity is still
        // ambiguous (for example, an address-change request that first needs
        // an order choice). Product evidence is still skipped until a unique
        // product is resolved, so this cannot attach evidence to the wrong item.
        const clarificationLookup = safeSocial
          ? { byTaskId: new Map<string, ReplyEvidenceSnapshot[]>(), evidence: [], hasConflict: false, conflictItemIds: [] }
          : await this.retrieveAndFreezeTaskEvidence(scope, job, taskBundle.tasks, taskContexts);
        void this.recordTrace(scope, job, 'EVIDENCE', {
          evidenceCount: clarificationLookup.evidence.length,
          knowledgeVersionIds: clarificationLookup.evidence.map((entry) => entry.versionId),
          evidenceRefs: clarificationLookup.evidence.map((entry) => ({
            itemId: entry.itemId,
            versionId: entry.versionId,
            scope: entry.scope,
            productId: entry.productId,
          })),
          conflicted: clarificationLookup.hasConflict,
          tasks: [...clarificationLookup.byTaskId.entries()].map(([taskId, entries]) => ({
            taskId,
            knowledgeVersionIds: entries.map((entry) => entry.versionId),
          })),
        });
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
        evidenceRefs: evidence.map((entry) => ({
          itemId: entry.itemId,
          versionId: entry.versionId,
          scope: entry.scope,
          productId: entry.productId,
        })),
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
        const dynamicReplyText = context?.entity
          ? dynamicReply(task.intent, context.entity as unknown as Record<string, unknown>, job.userTurn.normalizedText)
          : undefined;
        const shippingBoundaryText = task.intent === 'SHIPPING_POLICY'
          ? shippingPromiseBoundaryReply(job.userTurn.normalizedText)
          : undefined;
        const builtInReplyText = safeSocial && task.intent === `SAFE_SOCIAL_${safeSocial.intent}` ? safeSocial.text : undefined;
        const imageObservationText = renderImageObservationReply(task.intent, job.userTurn.normalizedText);
        const deterministicReplyText = builtInReplyText ?? imageObservationText ?? dynamicReplyText ?? shippingBoundaryText;
        const taskEvidence = lookup.byTaskId.get(task.id) ?? [];
        if (taskEvidence.length === 0 && !deterministicReplyText) return { status: 'FAILED' as const, errorCode: 'NO_EVIDENCE' };
        return {
          status: 'RESOLVED' as const,
          facts: {
            reply: deterministicReplyText ?? selectEvidenceReply(taskEvidence, job.userTurn.normalizedText),
            ...(builtInReplyText ? { source: 'SYSTEM_SAFE_REPLY' } : imageObservationText ? { source: 'SANITIZED_IMAGE_ANALYSIS' } : {}),
            ...(context?.entity ? { context: context.entity } : {}),
          },
          evidence: taskEvidence.map((entry) => entry.versionId),
        };
      });
      const persistedTaskIds = await this.persistTasks(scope, job.id, job.conversationId, job.userTurnId, execution.tasks);
      const workflow = await this.resolveWorkflowTasks(scope, job.conversationId, persistedTaskIds, execution);
      if (workflow.waitingApproval) {
        await this.recordTrace(scope, job, 'REPLY_POLICY', {
          mode: 'MANUAL',
          reasons: ['WORKFLOW_APPROVAL_REQUIRED'],
          evidenceCount: evidence.length,
        });
        return this.waitForHuman(scope, job, 'WORKFLOW_APPROVAL_REQUIRED');
      }
      if (workflow.failed) {
        await this.recordTrace(scope, job, 'REPLY_POLICY', {
          mode: 'MANUAL',
          reasons: ['WORKFLOW_FAILED'],
          evidenceCount: evidence.length,
        });
        return this.waitForHuman(scope, job, 'WORKFLOW_FAILED');
      }
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
      const allTasksNoEvidence = execution.tasks.length > 0
        && execution.tasks.every((task) => task.status === 'FAILED' && task.errorCode === 'NO_EVIDENCE');
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
        allTasksFailedNoEvidence: allTasksNoEvidence,
        userRequestedHuman: transferRequested(job.userTurn.normalizedText, settings?.transferKeywordsJson),
        hasConflict: lookup.hasConflict,
        recommendedMode,
      });
      await this.recordTrace(scope, job, 'REPLY_POLICY', { mode: policy.mode, reasons: policy.reasons, evidenceCount: evidence.length, taskStatuses: execution.tasks.map((task) => task.status) });
      if (policy.mode === 'MANUAL') {
        const reason = policy.reasons.join(',') || 'MANUAL_REQUIRED';
        const intents = execution.tasks.map((task) => task.intent);
        const hasSpecificHandoff = intents.some((intent) => /COMPLAINT|HUMAN_REQUEST|REFUND|RETURN|COMPENSATION/i.test(intent));
        return this.waitForHuman(
          scope,
          job,
          reason,
          allTasksNoEvidence && !hasSpecificHandoff
            ? noEvidenceHandoffText(job.userTurn.normalizedText)
            : customerFacingHandoffText(intents, reason),
        );
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
    } catch (error) {
      if (error instanceof AiEvalSimulatedCrash) throw error;
      const inferred = inferExplicitIntentTasks(job.userTurn.normalizedText);
      const failedTasks = (inferred.length ? inferred : [{
        intent: 'UNKNOWN', riskLevel: 'MEDIUM' as const, requiredContext: [], requiredKnowledge: [], requiredTools: [],
      }]).map((task, index) => ({
        id: `${job.id}:runtime-failure:${index}`, intent: task.intent, operation: 'READ' as const,
        riskLevel: task.riskLevel, requiredContext: task.requiredContext,
        requiredKnowledge: task.requiredKnowledge,
        requiredTools: [...new Set([...task.requiredTools, 'TRANSFER_HUMAN'])],
        status: 'FAILED', errorCode: 'AI_RUNTIME_FAILED', blocking: true,
      }));
      await this.persistTasks(scope, job.id, job.conversationId, job.userTurnId, failedTasks, false);
      void this.recordTrace(scope, job, 'TASKS', { tasks: failedTasks.map((task) => ({ intent: task.intent, status: task.status, errorCode: task.errorCode })) });
      void this.recordTrace(scope, job, 'REPLY_POLICY', { mode: 'MANUAL', reasons: ['AI_RUNTIME_FAILED'] });
      return this.waitForHuman(
        scope, job, 'AI_RUNTIME_FAILED',
        customerFacingHandoffText(failedTasks.map((task) => task.intent), 'AI_RUNTIME_FAILED'),
      );
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
    tasks: Array<{ id: string; intent: string; requiredContext: string[]; requiredKnowledge?: Array<'STORE' | 'PRODUCT'> }>,
    contexts: Map<string, ReturnType<typeof resolveContext>>,
  ): Promise<TaskEvidenceLookup> {
    const existing = job.evidences.map(toEvidence);
    const byTaskId = new Map<string, ReplyEvidenceSnapshot[]>();
    const activeTaskKeys = new Set(tasks.map(evidenceTaskBindingKey));
    const collected = new Map<string, TaskBoundEvidenceSnapshot>(existing
      .filter((entry) => entry.taskKey && activeTaskKeys.has(entry.taskKey))
      .map((entry) => [taskEvidenceKey(entry.taskKey!, entry.versionId), entry]));
    const conflictItemIds = new Set<string>();
    let hasConflict = false;

    for (const task of tasks) {
      const scopes = knowledgeScopesForTask(task, contexts.get(task.id));
      if (!scopes.length) {
        byTaskId.set(task.id, []);
        continue;
      }
      const productId = resolvedProductId(contexts.get(task.id));
      const taskKey = evidenceTaskBindingKey(task);
      const reusable = taskBoundReusableEvidence(existing, taskKey, scopes, productId);
      if (reusable.length) {
        byTaskId.set(task.id, reusable);
        continue;
      }
      const taskEvidence: ReplyEvidenceSnapshot[] = [];
      for (const knowledgeScope of scopes) {
        if (knowledgeScope === 'PRODUCT' && !productId) continue;
        const result = await this.knowledge.search(scope, {
          shopId: scope.shopId,
          query: knowledgeRetrievalQuery(job.userTurn.normalizedText, task.intent),
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
          const frozen: TaskBoundEvidenceSnapshot = { ...entry, taskKey, contentSnapshot: { ...entry.contentSnapshot } };
          collected.set(taskEvidenceKey(taskKey, frozen.versionId), frozen);
          taskEvidence.push(frozen);
        }
      }
      byTaskId.set(task.id, uniqueEvidence(taskEvidence));
    }

    const boundEvidence = [...collected.values()];
    const evidence = uniqueEvidence(boundEvidence);
    const existingKeys = new Set(existing.flatMap((entry) => entry.taskKey
      ? [taskEvidenceKey(entry.taskKey, entry.versionId)]
      : []));
    const newEvidence = boundEvidence.filter((entry) => entry.taskKey
      && !existingKeys.has(taskEvidenceKey(entry.taskKey, entry.versionId)));
    if (newEvidence.length > 0) {
      await this.prisma.replyEvidence.createMany({
        data: newEvidence.map((entry) => ({
          ...scope, replyJobId: job.id, taskKey: entry.taskKey, knowledgeItemId: entry.itemId, knowledgeVersionId: entry.versionId,
          knowledgeVersionNumber: entry.version, sourceType: entry.source, scope: entry.scope,
          productId: entry.productId, retrievedContentSnapshotJson: cloneJson(entry.contentSnapshot), retrievalScore: entry.retrievalScore,
        })),
        skipDuplicates: true,
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
    const sourceMessageIds = Array.isArray(job.userTurn.sourceMessageIdsJson)
      ? job.userTurn.sourceMessageIdsJson.filter((id): id is string => typeof id === 'string')
      : [];
    const repository = this.prisma as unknown as {
      message?: { findMany(input: unknown): Promise<Array<{ kind: string; contentJson: unknown }>> };
      product?: { findMany(input: unknown): Promise<Array<ProductContextRow>>; findFirst?: (input: unknown) => Promise<ProductContextRow | null> };
      productSku?: { findMany(input: unknown): Promise<Array<{ id: string; productId: string; externalSkuId: string; inventory: number; price: unknown; attributesJson: unknown; product?: { title: string } }>>; findFirst?: (input: unknown) => Promise<{ id: string; productId: string; externalSkuId: string; inventory: number; price: unknown; attributesJson: unknown; product?: { title: string } } | null> };
      order?: { findMany(input: unknown): Promise<Array<{ id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number; product?: { title: string } }>>; findFirst?: (input: unknown) => Promise<{ id: string; externalOrderId: string; status: string; logisticsSnapshotJson: unknown; version: number; product?: { title: string } } | null> };
    };
    const cards = sourceMessageIds.length && repository.message
      ? await repository.message.findMany({
          where: { ...scope, id: { in: sourceMessageIds }, status: { not: 'RECALLED' }, kind: { in: ['GOODS_CARD', 'ORDER_CARD'] } },
          orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }], select: { kind: true, contentJson: true },
        })
      : [];
    for (const task of tasks) {
      const productCard = cardContextSelection(cards, 'PRODUCT');
      const productChoiceId = clarificationChoiceId(job.conversation.clarificationRoundsJson, 'PRODUCT', job.userTurn.normalizedText ?? '');
      // PRODUCT+SKU means "resolve a SKU within this product", not "search
      // every SKU in the shop". Without one unambiguous product selection,
      // resolve PRODUCT first so the buyer never sees internal SKU choices.
      const hasProductSelection = !productCard.ambiguous && Boolean(
        productCard.id || productChoiceId || job.conversation.currentProductId,
      );
      const hasExplicitSkuSelection = Boolean(cardContextSelection(cards, 'SKU').id)
        || explicitSkuReference(job.userTurn.normalizedText ?? '');
      if (
        task.requiredContext.includes('PRODUCT')
        && task.requiredContext.includes('SKU')
        && !hasProductSelection
        && !hasExplicitSkuSelection
        && !productCard.ambiguous
      ) {
        const productCandidates = await this.contextCandidates(repository, scope, job.conversation.buyerId, 'PRODUCT', {
          text: job.userTurn.normalizedText ?? '',
        });
        const productContext = resolveContext({
          kind: 'PRODUCT', riskLevel: task.riskLevel, candidates: productCandidates,
          clarificationRounds: clarificationRounds(job.conversation.clarificationRoundsJson, 'PRODUCT'),
          contextVersion: job.sourceContextVersion, currentContextVersion: job.conversation.contextVersion,
        });
        if (productContext.status !== 'RESOLVED' || !productContext.entity) {
          result.set(task.id, productContext);
          continue;
        }
        const skuCandidates = await this.contextCandidates(repository, scope, job.conversation.buyerId, 'SKU', {
          preferredId: productContext.entity.id,
          text: job.userTurn.normalizedText ?? '',
        });
        const scopedSkuCandidates = skuCandidates.filter((candidate) => {
          const dynamic = jsonRecord((candidate as unknown as Record<string, unknown>).dynamic);
          return dynamic?.productId === productContext.entity!.id;
        });
        result.set(task.id, resolveContext({
          kind: 'SKU', riskLevel: task.riskLevel, candidates: scopedSkuCandidates,
          clarificationRounds: clarificationRounds(job.conversation.clarificationRoundsJson, 'SKU'),
          contextVersion: job.sourceContextVersion, currentContextVersion: job.conversation.contextVersion,
        }));
        continue;
      }
      const kind = task.requiredContext.includes('ORDER') ? 'ORDER' as const
        : task.requiredContext.includes('SKU') && (!task.requiredContext.includes('PRODUCT') || hasProductSelection || hasExplicitSkuSelection)
          ? 'SKU' as const
          : task.requiredContext.includes('PRODUCT') ? 'PRODUCT' as const : undefined;
      if (!kind) continue;
      const card = cardContextSelection(cards, kind);
      const cardId = card.id;
      // Two distinct current-turn cards are an explicit ambiguity. They must
      // not silently inherit an older conversation selection.
      const preferredId = card.ambiguous
        ? undefined
        : kind === 'ORDER' ? job.conversation.currentOrderId : job.conversation.currentProductId;
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
      product?: { findMany(input: unknown): Promise<ProductContextRow[]>; findFirst?: (input: unknown) => Promise<ProductContextRow | null> };
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
        const row = await repository.productSku.findFirst({ where: { id: exactId, ...scope }, select: { id: true, productId: true, externalSkuId: true, inventory: true, price: true, attributesJson: true, product: { select: { title: true } } } });
        return row ? [skuCandidate(row)] : [];
      }
      const select = { id: true, productId: true, externalSkuId: true, inventory: true, price: true, attributesJson: true, product: { select: { title: true } } };
      // A two-color follow-up is about the product already selected in this
      // conversation. Aggregate its live SKU rows before any broad text
      // matching so an unrelated product with the same color cannot affect
      // the customer-facing availability statement.
      // Textual attributes (for example “黑色 XL”) are a current-turn
      // selection.  Match them across the scoped SKU set before falling back
      // to the conversation's older product.  `preferredId` is a product id,
      // never a SKU id, so it must only be used as a productId filter.
      const scopedRows = await repository.productSku.findMany({
        where: { ...scope }, orderBy: { updatedAt: 'desc' }, take: 25, select,
      });
      if (options.preferredId) {
        const inventoryByColor = requestedColorInventory(scopedRows, options.preferredId, options.text);
        if (inventoryByColor) return [skuColorInventoryCandidate(options.preferredId, inventoryByColor)];
      }
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
      const productSelect = { id: true, title: true, description: true, status: true, skus: { select: { price: true } } };
      if (exactId && repository.product.findFirst) {
        const row = await repository.product.findFirst({ where: { id: exactId, ...scope }, select: productSelect });
        return row ? [productCandidate(row)] : [];
      }
      const rows = await repository.product.findMany({ where: { ...scope, ...(exactId ? { id: exactId } : {}) }, orderBy: { updatedAt: 'desc' }, take: exactId ? 1 : 25, select: productSelect });
      const textMatches = explicitProductMatches(rows, options.text);
      if (textMatches.length) return textMatches.map(productCandidate);
      // Pronoun-only follow-ups such as “那白色呢” refer to the conversation's
      // selected product.  An explicit product phrase above still wins, so a
      // buyer can switch products without being pinned to stale context.
      if (options.preferredId && repository.product.findFirst) {
        const row = await repository.product.findFirst({
          where: { id: options.preferredId, ...scope }, select: productSelect,
        });
        return row ? [productCandidate(row)] : [];
      }
      return rows.slice(0, 3).map(productCandidate);
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
      const clarificationTasks = plannedTasks.map((planned) => {
        const context = contexts.get(planned.id);
        const resolvedReply = context?.status === 'RESOLVED' && context.entity
          ? dynamicReply(planned.intent, context.entity as unknown as Record<string, unknown>)
          : undefined;
        const status = context?.clarification
          ? 'AMBIGUOUS'
          : context?.status === 'RESOLVED'
            ? 'RESOLVED'
            : context
              ? 'FAILED'
              : 'OPEN';
        return {
          id: `reply-task:${job.id}:${planned.id}`,
          ...scope,
          conversationId: job.conversationId,
          userTurnId: job.userTurnId,
          intent: planned.intent,
          operation: planned.operation,
          riskLevel: planned.riskLevel,
          requiredContextJson: planned.requiredContext,
          requiredKnowledgeJson: planned.requiredKnowledge ?? [],
          requiredToolsJson: planned.requiredTools,
          status,
          blocking: planned.blocking,
          ...(context?.clarification
            ? { resultJson: cloneJson({ clarification: context.clarification }) }
            : resolvedReply
              ? { resultJson: cloneJson({ facts: { reply: resolvedReply } }) }
              : context
                ? { errorCode: `CONTEXT_${context.status}` }
                : {}),
        };
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
    draftText?: string,
  ): Promise<{ status: 'WAITING_HUMAN'; draftId: string; reason: string } | { status: 'STALE'; reason: string }> {
    // ReplyDraftService owns the atomic GENERATING/PENDING -> WAITING_HUMAN
    // transition.  Updating it first would make the draft deliberately reject
    // its own source job and strand a worker in an inconsistent state.
    let draft: { id: string };
    try {
      draft = await this.drafts.createWaitingHuman(scope, {
        replyJobId: job.id, aiDraft: draftText ?? customerFacingHandoffText([], reason), sourceContextVersion: job.sourceContextVersion,
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
  taskKey?: string | null;
  knowledgeItemId: string; knowledgeVersionId: string; knowledgeVersionNumber: number; sourceType: ReplyEvidenceSnapshot['source'];
  scope: ReplyEvidenceSnapshot['scope']; productId: string | null; retrievedContentSnapshotJson: unknown; retrievalScore: number | null;
}): TaskBoundEvidenceSnapshot {
  const snapshot = value.retrievedContentSnapshotJson as { question?: unknown; answer?: unknown };
  return {
    ...(value.taskKey ? { taskKey: value.taskKey } : {}),
    itemId: value.knowledgeItemId, versionId: value.knowledgeVersionId, version: value.knowledgeVersionNumber,
    source: value.sourceType, scope: value.scope, productId: value.productId,
    contentSnapshot: { question: String(snapshot.question ?? ''), answer: String(snapshot.answer ?? '') },
    retrievalScore: value.retrievalScore ?? 0,
  };
}

function taskEvidenceKey(taskKey: string, versionId: string): string {
  return `${taskKey}\u0000${versionId}`;
}

/** Stable across planner task reordering; changing task semantics forces a fresh retrieval. */
export function evidenceTaskBindingKey(task: {
  intent: string;
  requiredContext: readonly string[];
  requiredKnowledge?: ReadonlyArray<'STORE' | 'PRODUCT'>;
}): string {
  const intent = task.intent.normalize('NFKC').trim().toLocaleUpperCase();
  const context = [...new Set(task.requiredContext.map((entry) => entry.normalize('NFKC').trim().toLocaleUpperCase()))]
    .filter(Boolean)
    .sort();
  const knowledge = [...new Set(task.requiredKnowledge ?? [])].sort();
  return JSON.stringify([intent, context, knowledge]);
}

/** Recovery may reuse a frozen row only when it belongs to this exact task. */
export function taskBoundReusableEvidence(
  evidence: readonly TaskBoundEvidenceSnapshot[],
  taskKey: string,
  scopes: ReadonlyArray<'STORE' | 'PRODUCT'>,
  productId?: string,
): TaskBoundEvidenceSnapshot[] {
  return evidence.filter((entry) => entry.taskKey === taskKey
    && scopes.includes(entry.scope)
    && (entry.scope !== 'PRODUCT' || entry.productId === productId));
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

function riskModeFor(risk: 'LOW' | 'MEDIUM' | 'HIGH'): 'AUTO' | 'ASSIST' | 'MANUAL' {
  return risk === 'HIGH' ? 'MANUAL' : risk === 'MEDIUM' ? 'ASSIST' : 'AUTO';
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>)
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function cardContextSelection(
  cards: Array<{ kind: string; contentJson: unknown }>,
  kind: 'PRODUCT' | 'SKU' | 'ORDER',
): { id?: string; ambiguous: boolean } {
  const key = kind === 'ORDER' ? 'orderId' : kind === 'PRODUCT' ? 'productId' : 'skuId';
  const ids = [...new Set(cards.flatMap((entry) => {
    if ((kind === 'ORDER' ? entry.kind === 'ORDER_CARD' : entry.kind === 'GOODS_CARD') === false) return [];
    if (!entry.contentJson || typeof entry.contentJson !== 'object' || Array.isArray(entry.contentJson)) return [];
    const id = (entry.contentJson as Record<string, unknown>)[key];
    return typeof id === 'string' && id.trim() ? [id] : [];
  }))];
  return ids.length === 1 ? { id: ids[0], ambiguous: false } : { ambiguous: ids.length > 1 };
}

/** A named SKU or size/color combination is an explicit buyer selection. */
function explicitSkuReference(text: string): boolean {
  return /\b(?:xs|s|m|l|xl|xxl|xxxl)\b/iu.test(text)
    || /\b[a-z][a-z0-9]*[-_][a-z0-9-]+\b/iu.test(text);
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

type ProductContextRow = {
  id: string;
  title: string;
  description?: string;
  status?: string;
  skus?: Array<{ price: unknown }>;
};

function productCandidate(row: ProductContextRow) {
  const prices = (row.skus ?? [])
    .map((sku) => Number(sku.price))
    .filter((price) => Number.isFinite(price) && price >= 0);
  const dynamic = row.status
    ? {
      status: row.status,
      ...(row.description?.trim() ? { description: row.description.trim() } : {}),
      ...(prices.length ? { priceRange: { min: String(Math.min(...prices)), max: String(Math.max(...prices)) } } : {}),
    }
    : undefined;
  return {
    id: row.id,
    kind: 'PRODUCT' as const,
    label: row.title,
    ...(dynamic ? { dynamic } : {}),
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
export function explicitSkuMatches<T extends { externalSkuId: string; attributesJson: unknown; product?: { title: string } }>(rows: T[], text: string): T[] {
  const normalized = text.toLocaleLowerCase();
  const scored = rows.map((row) => {
    const attributes = jsonRecord(row.attributesJson);
    const score = (row.externalSkuId.trim().length > 0 && normalized.includes(row.externalSkuId.trim().toLocaleLowerCase()) ? 1 : 0)
      + productTitleMentionScore(normalized, row.product?.title)
      + (attributes
        ? Object.entries(attributes).filter(([key, value]) => typeof value === 'string' && attributeValueMentioned(normalized, key, value)).length
        : 0);
    return { row, score };
  });
  const maximum = Math.max(0, ...scored.map((entry) => entry.score));
  return maximum > 0 ? scored.filter((entry) => entry.score === maximum).map((entry) => entry.row) : [];
}

/** A current-turn product name beats recency and prior conversation context. */
export function explicitProductMatches<T extends { title: string }>(rows: T[], text: string): T[] {
  const normalized = text.toLocaleLowerCase();
  const scored = rows.map((row) => ({ row, score: productTitleMentionScore(normalized, row.title) }));
  const maximum = Math.max(0, ...scored.map((entry) => entry.score));
  return maximum > 0 ? scored.filter((entry) => entry.score === maximum).map((entry) => entry.row) : [];
}

function productTitleMentionScore(normalizedText: string, title?: string): number {
  if (!title?.trim()) return 0;
  const normalizedTitle = title.trim().toLocaleLowerCase();
  const latin = normalizedTitle.match(/[a-z0-9]+/g) ?? [];
  const han = [...normalizedTitle.replace(/[^\u3400-\u9fff]/g, '')];
  const bigrams = Array.from({ length: Math.max(0, han.length - 1) }, (_, index) => `${han[index]}${han[index + 1]}`);
  return [...new Set([...latin, ...bigrams])].filter((token) => token.length > 1 && normalizedText.includes(token)).length;
}

export function customerFacingHandoffText(intents: readonly string[], reason: string): string {
  if (intents.some((intent) => /COMPLAINT/i.test(intent))) {
    return '很抱歉给您带来不好的体验，我已为本次投诉转入人工核实，请稍候。';
  }
  if (intents.some((intent) => /REFUND|RETURN|COMPENSATION/i.test(intent))) {
    return '退款或售后处理需要人工核实订单与规则，已为您转入人工确认，请稍候。';
  }
  if (intents.some((intent) => /HUMAN_REQUEST/i.test(intent)) || reason.includes('USER_REQUESTED_HUMAN')) {
    return '好的，已为您转入人工客服队列，请稍候。';
  }
  if (reason.includes('NO_EVIDENCE') || reason.includes('CONTEXT_NOT_FOUND')) {
    return '暂时没有找到可靠依据，我已转入人工确认，避免给您错误答复。';
  }
  if (reason.includes('AI_RUNTIME_FAILED')) {
    return '当前智能回复暂时不可用，我已转入人工处理，请稍候。';
  }
  return '这个问题需要人工进一步确认，我已转入人工处理，请稍候。';
}

function noEvidenceHandoffText(turnText: string): string {
  const subject = /线下试穿/u.test(turnText)
    ? '线下试穿'
    : /(?:实体店|到店)/u.test(turnText)
      ? '到店服务'
      : /营业时间/u.test(turnText)
        ? '营业时间'
        : undefined;
  return subject
    ? `关于${subject}，暂时没有找到可靠依据，我已转入人工确认，避免给您错误答复。`
    : customerFacingHandoffText([], 'NO_EVIDENCE');
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

function clarificationText(
  contexts: Map<string, ReturnType<typeof resolveContext>>,
  tasks: ReadonlyArray<{ id: string; intent: string }> = [],
): string | undefined {
  const requests = [...contexts.values()].flatMap((context) => context.clarification?.requests ?? []);
  if (!requests.length) return undefined;
  const resolvedReplies = tasks.flatMap((task) => {
    const context = contexts.get(task.id);
    if (context?.status !== 'RESOLVED' || !context.entity) return [];
    const reply = dynamicReply(task.intent, context.entity as unknown as Record<string, unknown>);
    return reply ? [reply] : [];
  });
  const lines = requests.map((request) => {
    const choices = request.choices.map((choice) => choice.label).filter(Boolean).join('、');
    return choices ? `${request.question} 可选：${choices}。` : request.question;
  });
  return [...new Set([...resolvedReplies, ...lines])].join('\n');
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

export function knowledgeScopesForTask(
  task: { intent: string; requiredKnowledge?: Array<'STORE' | 'PRODUCT'> },
  context: ReturnType<typeof resolveContext> | undefined,
): Array<'STORE' | 'PRODUCT'> {
  // Inventory and logistics are live operational facts. A model-supplied RAG
  // scope must never turn them into stale knowledge answers. ORDER_QUERY may
  // still explicitly require STORE policy for action requests such as an
  // address change, so keep that narrower case below.
  if (/(?:^|_)(?:INVENTORY|STOCK|LOGISTICS|SHIPMENT)(?:_|$)/i.test(task.intent) || /SKU_INVENTORY/i.test(task.intent)) return [];
  if (task.requiredKnowledge?.length) return [...new Set(task.requiredKnowledge)];
  if (isDynamicFactIntent(task.intent) || /REFUND|EXCHANGE|COMPLAINT|HUMAN/i.test(task.intent)) return [];
  if (/PRODUCT|SIZE|CARE|MATERIAL|SPECIFICATION|RECOMMENDATION/i.test(task.intent)) {
    return resolvedProductId(context) ? ['PRODUCT'] : [];
  }
  return ['STORE'];
}

function skuColorInventoryCandidate(productId: string, inventoryByColor: Record<string, number>) {
  return {
    id: `color-inventory:${productId}`, kind: 'SKU' as const, label: Object.keys(inventoryByColor).join('、'),
    dynamic: { productId, inventoryByColor },
  };
}

/**
 * Returns aggregate live availability only for multiple color values that the
 * buyer named, and only for the already selected product. The caller renders
 * statuses rather than these quantities, so exact stock remains internal.
 */
export function requestedColorInventory<T extends { productId: string; inventory: number; attributesJson: unknown }>(
  rows: readonly T[],
  productId: string,
  text: string,
): Record<string, number> | undefined {
  const normalized = text.toLocaleLowerCase();
  const colorRows = rows.flatMap((row) => {
    if (row.productId !== productId || !Number.isFinite(row.inventory)) return [];
    const attributes = jsonRecord(row.attributesJson);
    const color = typeof attributes?.color === 'string'
      ? attributes.color.trim()
      : typeof attributes?.颜色 === 'string' ? attributes.颜色.trim() : '';
    return color && normalized.includes(color.toLocaleLowerCase()) ? [{ color, inventory: row.inventory }] : [];
  });
  const colors = [...new Set(colorRows.map((row) => row.color))]
    .sort((left, right) => normalized.indexOf(left.toLocaleLowerCase()) - normalized.indexOf(right.toLocaleLowerCase()));
  if (colors.length < 2) return undefined;
  return Object.fromEntries(colors.map((color) => [
    color,
    colorRows.filter((row) => row.color === color).reduce((total, row) => total + Math.max(0, row.inventory), 0),
  ]));
}

export function knowledgeRetrievalQuery(turnText: string, intent?: string): string {
  const normalized = turnText
    .replace(/\[(?:商品卡|订单卡|图片(?:\s+[A-Z_]+)?)\]/giu, ' ')
    .replace(/(?:今天|现在)(?:下单|购买|买了?)[，,、\s]*(?=(?:什么时候|何时)发货)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  // A request to promise an arrival date is not a live-order lookup. Retrieve
  // the shop's fulfilment boundary so the reply can explicitly decline a
  // guarantee instead of fabricating an ETA or dropping to no-evidence.
  if (intent === 'SHIPPING_POLICY' && /(?:(?:多久|几天|多长时间|什么时候|何时).{0,4}发(?:货|出)?|发(?:货|出).{0,4}(?:多久|几天|多长时间|什么时候|何时))/u.test(normalized)) {
    return '多久发货';
  }
  if (intent === 'AFTER_SALES_QUERY' && /(?:退货|退换|退款|售后|7\s*天无理由)/u.test(normalized)) {
    return '支持退货';
  }
  if (intent === 'REFUND_REQUEST' && /(?:退款|退钱|退货)/u.test(normalized)) return '可以退款吗';
  if (intent === 'PRODUCT_QUERY' && /烘干/u.test(normalized)) return '可以烘干吗';
  if (intent === 'PRODUCT_QUERY' && /(?:材质|面料)/u.test(normalized)) return '材质';
  if (/(?:保证|确保|能否).{0,10}(?:周[一二三四五六日天]|今天|明天|后天|\d+[号日]).{0,6}(?:送到|到货)/u.test(normalized)) {
    return '多久发货';
  }
  if (/(?:水洗|怎么洗|洗涤)/u.test(normalized)) return '怎么洗';
  return normalized;
}

/** PRODUCT_QUERY has both live and knowledge-backed variants. Only price and
 * sale-state wording may be fulfilled from live product context; care/material
 * questions must retain product-scoped Evidence. */
export function productQuestionNeedsLiveFact(turnText: string): boolean {
  return /(?:多少钱|价格|售价|还能买吗|可以买吗|能买(?:吗)?|可售|在售|下架|上架)/u.test(turnText);
}

/** Uses a scoped product catalog description only for broad feature asks. */
export function productCatalogReply(turnText: string, dynamic: Record<string, unknown>): string | undefined {
  if (!/(?:特点|介绍|功能|参数|怎么样)/u.test(turnText)) return undefined;
  if (/(?:材质|面料|烘干|水洗|洗涤|版型|偏大|偏小|防水|季节)/u.test(turnText)) return undefined;
  const description = typeof dynamic.description === 'string'
    ? dynamic.description.replace(/<[^>]*>/gu, ' ').replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 240)
    : '';
  return description ? `这款商品的主要特点是：${description}` : undefined;
}

/** Adds the preceding buyer ask only for a narrow pronoun-only continuation. */
export function intentInferenceText(currentTurn: string, recentMessages: unknown): string {
  const current = currentTurn.trim();
  if (!/^(?:还是(?:它|这个|那个|这款|那款)|就(?:它|这个|那个)|它呢|这个呢|那个呢)[。！？?!\s]*$/u.test(current)) {
    return currentTurn;
  }
  if (!Array.isArray(recentMessages)) return currentTurn;
  const prior = recentMessages
    .flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      return record.role === 'BUYER' && typeof record.text === 'string' && record.text.trim()
        ? [record.text.trim()]
        : [];
    })
    .reverse()
    .find((text) => text !== current);
  return prior ? `${prior}\n${currentTurn}` : currentTurn;
}

/**
 * A date-guarantee question is answered with the stable fulfilment boundary,
 * never with a guessed carrier ETA. Evidence still supplies the normal
 * dispatch policy, while this fixed clause makes the operational limit clear.
 */
export function shippingPromiseBoundaryReply(turnText: string): string | undefined {
  if (!/(?:保证|确保|能否).{0,10}(?:周[一二三四五六日天]|今天|明天|后天|\d+[号日]).{0,6}(?:送到|到货)/u.test(turnText)) return undefined;
  return '普通现货商品通常会尽快发出，但受收货地区和物流进度影响，不能保证具体到达日期，请以订单物流信息为准。';
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

/** Selects only among already-frozen Evidence, favoring exact buyer wording. */
export function selectEvidenceReply(
  evidence: ReadonlyArray<{ contentSnapshot: { question: string; answer: string } }>,
  turnText: string,
): string {
  if (!evidence.length) return '';
  const queryTerms = lexicalTerms(turnText);
  const ranked = evidence.map((entry, index) => {
    const questionTerms = lexicalTerms(entry.contentSnapshot.question);
    const answerTerms = lexicalTerms(entry.contentSnapshot.answer);
    const questionMatches = queryTerms.filter((term) => questionTerms.includes(term)).length;
    const answerMatches = queryTerms.filter((term) => answerTerms.includes(term)).length;
    return { entry, index, score: questionMatches * 3 + answerMatches };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked[0]!.entry.contentSnapshot.answer;
}

function lexicalTerms(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const han = [...normalized.replace(/[^\u3400-\u9fff]/gu, '')];
  const bigrams = Array.from({ length: Math.max(0, han.length - 1) }, (_, index) => `${han[index]}${han[index + 1]}`);
  const latin = normalized.match(/[a-z0-9]{2,}/gu) ?? [];
  return [...new Set([...bigrams, ...latin])];
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
function dynamicReply(intent: string, entity: Record<string, unknown>, turnText?: string): string | undefined {
  const dynamic = jsonRecord(entity.dynamic);
  if (!dynamic) return undefined;
  if (intent === 'PRODUCT_QUERY' && turnText !== undefined) {
    const catalogReply = productCatalogReply(turnText, dynamic);
    if (catalogReply) return catalogReply;
    if (!productQuestionNeedsLiveFact(turnText)) return undefined;
  }
  return renderCustomerFactReply(intent, dynamic);
}
