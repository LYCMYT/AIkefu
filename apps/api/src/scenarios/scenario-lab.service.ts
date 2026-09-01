import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { OperationAccepted, Scenario, ScenarioKey, ScenarioStatus, ScenarioStep } from '@ai-customer-service/contracts';
import { isScenarioKey } from '@ai-customer-service/contracts';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { SeedCatalog } from '../seed/seed-catalog';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { MESSAGE_APPLICATION, type MessageApplication } from '../messages/message.application';
import { ContextInvalidationService } from '../replies/context-invalidation.service';
import { ReplyRecoveryService } from '../replies/reply-recovery.service';
import { ReplyJobService } from '../replies/reply-job.service';
import { ReplyRuntimeService } from '../replies/reply-runtime.service';
import { SendOutboxService } from '../replies/send-outbox.service';
import { TraceService } from '../trace/trace.service';
import { WorkspaceGateway } from '../websocket/workspace.gateway';

type ScenarioScope = WorkspaceScope;

type ScenarioMutation = {
  kind: 'SKU_INVENTORY' | 'ORDER_STATUS';
  id: string;
  original: number | string;
};

type ScenarioResources = {
  conversationIds: string[];
  userTurnIds: string[];
  replyJobIds: string[];
  sendOutboxIds: string[];
  invocationIds: string[];
  mutation?: ScenarioMutation[];
};

type ScenarioSnapshotPayload = {
  scenario: Scenario;
  operationId?: string;
  resetOperationId?: string;
  resources: ScenarioResources;
  result?: Record<string, unknown>;
};

type ScenarioExecution = {
  resources: ScenarioResources;
  result?: Record<string, unknown>;
  stepActual?: Record<string, string>;
};

type Case07Proof = {
  replyJobId: string;
  replyStatus: string;
  responseKind: 'DRAFT' | 'SEND_OUTBOX';
  responseId: string;
  evidenceCount: number;
  knowledgeItemIds: string[];
  knowledgeVersionIds: string[];
  traceId: string;
};

type StaleReplanProof = {
  oldReplyJobId: string;
  newReplyJobId: string;
  newReplyStatus: string;
  evidenceCount: number;
  sendOutboxId: string;
  responseMessageId: string;
  responseText: string;
  traceStages: string[];
};

type Repository = Record<string, any>;

const ACTIVE_REPLY_JOB_STATUSES = ['PENDING', 'FAST_PATH_READY', 'GENERATING', 'WAITING_HUMAN', 'CANCELLING', 'RECOVERY_PENDING'];

const DEFINITIONS: Record<ScenarioKey, { name: string; description: string; expectedResult: string; steps: Array<[string, string, string]> }> = {
  continuous_messages: {
    name: '连续消息聚合',
    description: '2 秒内发送三条买家消息，验证 TurnBuffer 聚合和单一回复计划。',
    expectedResult: '3 Message → 1 UserTurn → 2 Task（库存 + 尺码建议）→ 1 个有效 ReplyJob。',
    steps: [
      ['message-1', '发送「黑色有吗」', '保存一条合成 BUYER Message'],
      ['message-2', '发送「XL呢」', '仍在同一 TurnBuffer'],
      ['message-3', '发送「我165，55公斤」', '仍在同一 TurnBuffer'],
      ['turn-flush', '等待 2 秒 idle flush', '聚合为 1 个 UserTurn'],
      ['reply-plan', '生成任务计划', '库存 + 尺码建议，只有 1 个有效 ReplyJob'],
    ],
  },
  message_during_generation: {
    name: '生成中补消息',
    description: '回复生成过程中补充收货地区，验证旧任务失效和重新规划。',
    expectedResult: 'contextVersion + 1；旧 ReplyJob STALE；Provider 逻辑取消；新 Reply 使用新疆规则。',
    steps: [
      ['initial-message', '发送「什么时候发货？」', '创建初始 UserTurn 与 ReplyJob'],
      ['generation', '标记旧 ReplyJob GENERATING', '生成中的任务持有旧 contextVersion'],
      ['follow-up', '补充「我是新疆的」', '新消息进入同一合成 Conversation'],
      ['invalidate', '更新上下文版本', '旧 Job STALE，needsReplan=true'],
      ['replan', '创建新 Reply 计划', '新计划读取偏远地区规则'],
    ],
  },
  two_buyers: {
    name: '两个买家同时咨询',
    description: '同一合成店铺并行接收两个买家的问题，验证 Conversation 级隔离。',
    expectedResult: '两个 Conversation 并行，同一 Conversation 内串行，Context / Task / Reply 不串。',
    steps: [
      ['buyer-a', 'Buyer A 提问库存', '只写入 Buyer A 的 Conversation'],
      ['buyer-b', 'Buyer B 提问发货', '只写入 Buyer B 的 Conversation'],
      ['parallel', '并行提交消息', '两个合成请求互不阻塞'],
      ['isolation', '检查归属', '消息、任务、回复均按 Conversation 隔离'],
    ],
  },
  two_shops: {
    name: '两个店铺同时收到消息',
    description: 'MIA Fashion 与 Pixel Tech 同时收到相同问题，验证店铺知识和 Trace 过滤。',
    expectedResult: 'MIA 使用 MIA StoreKnowledge；Pixel 使用 Pixel StoreKnowledge；无跨店检索。',
    steps: [
      ['mia', 'MIA Fashion 收到问题', '消息带 MIA shopId'],
      ['pixel', 'Pixel Tech 收到问题', '消息带 Pixel shopId'],
      ['parallel', '并行处理', '两个店铺的合成 Conversation 并行'],
      ['filter', '验证店铺过滤', 'Evidence / Trace 只保留当前 shopId'],
    ],
  },
  duplicate_and_reorder: {
    name: '消息重复与乱序',
    description: '发送 101、103、102 并重复 102，验证 Reorder Buffer 和持久化去重。',
    expectedResult: '103 进入 Reorder Buffer；102 到达后按 102 / 103 Commit；重复 102 被唯一约束拦截。',
    steps: [
      ['sequence-101', '发送 sequence 101', '先提交 101'],
      ['sequence-103', '发送 sequence 103', '进入 Reorder Buffer 等待 102'],
      ['sequence-102', '发送 sequence 102', '按 102 / 103 顺序 Commit'],
      ['duplicate-102', '重复发送 102', 'externalMessageId 去重，不产生第二条 Message'],
      ['ordered', '检查最终顺序', 'Conversation 消息顺序为 101 / 102 / 103'],
    ],
  },
  ai_timeout_fallback: {
    name: 'AI 超时与 Fallback',
    description: '使用合成 Provider 记录主 Provider 超时、一次重试和 Fallback，不调用真实模型。',
    expectedResult: 'timeout → retry once → fallback；记录 fallbackUsed；无无限重试。',
    steps: [
      ['input', '发送合成 AI 请求', '创建可追踪的合成调用上下文'],
      ['timeout', '主 Provider 超时', '记录 timeout，不发送半成品答案'],
      ['retry', '重试一次', 'retry 次数严格为 1'],
      ['fallback', '切换合成 Fallback', 'fallbackUsed=true'],
      ['closed', '完成降级', '失败边界可观测，无无限重试'],
    ],
  },
  service_restart_recovery: {
    name: '服务重启恢复',
    description: '模拟 ReplyJob 生成中重启和 SendOutbox 发送中重启，复用恢复边界。',
    expectedResult: 'ReplyJob 进入 RECOVERY_PENDING 并可恢复；SENDING → UNCERTAIN，不自动重发。',
    steps: [
      ['generating', '创建 GENERATING ReplyJob', '持久化生成中状态'],
      ['restart-reply', '模拟服务重启', 'Recovery Worker 扫描该 Job'],
      ['recovery', '恢复生成任务', '有效 Context 才可继续'],
      ['sending', '创建 SENDING SendOutbox', '持久化 transportStartedAt'],
      ['uncertain', '再次模拟重启', 'SENDING → UNCERTAIN，不自动重发'],
    ],
  },
  realtime_state_change: {
    name: '库存/订单状态变化',
    description: '生成中修改库存和订单状态，验证动态事实更新、Context 版本和旧回复失效。',
    expectedResult: '库存 8→0、订单 WAITING_SHIPMENT→SHIPPED；ProductContext / ContextVersion 更新；旧 Reply STALE。',
    steps: [
      ['bind-product', '绑定商品与 SKU', '当前 Conversation 绑定合成商品上下文'],
      ['inventory', '库存 8 → 0', '通过动态事实边界更新并使旧 Job 失效'],
      ['bind-order', '绑定订单', '当前 Conversation 绑定合成订单上下文'],
      ['order', '订单 WAITING_SHIPMENT → SHIPPED', '通过动态事实边界更新并使旧 Job 失效'],
      ['replan', '检查新上下文', 'contextVersion 增加，旧 Reply 不发送'],
    ],
  },
};

@Injectable()
export class ScenarioLabService {
  private readonly logger = new Logger(ScenarioLabService.name);
  private readonly local = new Map<string, ScenarioSnapshotPayload>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly eventVersions = new Map<string, number>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MESSAGE_APPLICATION) private readonly messages: MessageApplication,
    @Inject(ContextInvalidationService) private readonly invalidation: ContextInvalidationService,
    @Optional() @Inject(WorkspaceGateway) private readonly gateway?: WorkspaceGateway,
    @Optional() @Inject(SeedCatalog) private readonly seeds?: SeedCatalog,
    @Optional() @Inject(ReplyRecoveryService) private readonly recovery?: ReplyRecoveryService,
    @Optional() @Inject(SendOutboxService) private readonly sendOutboxes?: SendOutboxService,
    @Optional() @Inject(ReplyJobService) private readonly replyJobs?: ReplyJobService,
    @Optional() @Inject(ReplyRuntimeService) private readonly replyRuntime?: ReplyRuntimeService,
    @Optional() @Inject(TraceService) private readonly traces?: TraceService,
  ) {}

  async list(scope: ScenarioScope): Promise<Scenario[]> {
    return Promise.all((Object.keys(DEFINITIONS) as ScenarioKey[]).map(async (key) => {
      const snapshot = await this.load(scope, key);
      return snapshot.scenario;
    }));
  }

  async run(scope: ScenarioScope, key: string): Promise<OperationAccepted> {
    const scenarioKey = this.assertScenarioKey(key);
    return this.withLock(scope, scenarioKey, () => this.runLocked(scope, scenarioKey));
  }

  async reset(scope: ScenarioScope, key: string): Promise<OperationAccepted> {
    const scenarioKey = this.assertScenarioKey(key);
    return this.withLock(scope, scenarioKey, () => this.resetLocked(scope, scenarioKey));
  }

  private async runLocked(scope: ScenarioScope, key: ScenarioKey): Promise<OperationAccepted> {
    const current = await this.load(scope, key);
    if (current.operationId && ['RUNNING', 'SUCCEEDED'].includes(current.scenario.status)) {
      return accepted(current.operationId);
    }

    const operationId = randomUUID();
    const running = this.withStatus(current.scenario, 'RUNNING', operationId, this.traceId(scope, key, operationId));
    const resources = emptyResources();
    await this.save(scope, { scenario: running, operationId, resources });
    this.publish(scope, running, undefined);

    try {
      const execution = await this.executeScenario(scope, key, operationId, resources);
      const finished = this.withStatus(running, 'SUCCEEDED', operationId, running.traceId ?? undefined);
      const actual = execution.stepActual ?? {};
      // Persist a running/succeeded transition per step so the UI can render
      // progress from the same durable snapshot and WebSocket stream. The
      // effect itself is already complete at this point; these transitions
      // are projections of the bounded operation, never animation-only work.
      const progress = this.withStatus(running, 'RUNNING', operationId, running.traceId ?? undefined);
      for (const step of progress.steps ?? []) {
        step.status = 'RUNNING';
        await this.save(scope, { scenario: progress, operationId, resources: execution.resources, result: execution.result });
        this.publish(scope, progress, step.key);
        step.status = 'SUCCEEDED';
        step.actual = actual[step.key] ?? step.expected;
        await this.save(scope, { scenario: progress, operationId, resources: execution.resources, result: execution.result });
        this.publish(scope, progress, step.key);
      }
      finished.steps = progress.steps;
      await this.save(scope, {
        scenario: finished,
        operationId,
        resources: execution.resources,
        result: execution.result,
      });
      this.publish(scope, finished, undefined);
      return accepted(operationId);
    } catch (error) {
      const failed = this.withStatus(running, 'FAILED', operationId, running.traceId ?? undefined);
      const firstPending = failed.steps?.find((step) => step.status === 'PENDING');
      if (firstPending) firstPending.status = 'FAILED';
      await this.save(scope, { scenario: failed, operationId, resources, result: { error: this.errorMessage(error) } });
      this.publish(scope, failed, firstPending?.key);
      this.logger.warn(`Synthetic scenario ${key} failed: ${this.errorMessage(error)}`);
      throw error;
    }
  }

  private async resetLocked(scope: ScenarioScope, key: ScenarioKey): Promise<OperationAccepted> {
    const current = await this.load(scope, key);
    if (current.resetOperationId && current.scenario.status === 'READY') {
      return accepted(current.resetOperationId);
    }
    const resetOperationId = current.resetOperationId ?? randomUUID();
    const resetting = this.withStatus(current.scenario, 'RESETTING', resetOperationId);
    resetting.traceId = null;
    resetting.lastRunAt = null;
    resetting.steps = this.stepsFor(key);
    await this.save(scope, {
      scenario: resetting,
      operationId: undefined,
      resetOperationId,
      resources: current.resources,
    });
    this.publish(scope, resetting, undefined);

    await this.cleanup(scope, key, current.resources);
    const ready = this.initial(key);
    await this.save(scope, { scenario: ready, resetOperationId, resources: emptyResources() });
    this.publish(scope, ready, undefined);
    return accepted(resetOperationId);
  }

  /**
   * Runs one complete fixed scenario. Each branch is deliberately finite and
   * uses only the synthetic MessageApplication/ContextInvalidation seams.
   */
  private async executeScenario(scope: ScenarioScope, key: ScenarioKey, operationId: string, resources: ScenarioResources): Promise<ScenarioExecution> {
    switch (key) {
      case 'continuous_messages': return this.continuousMessages(scope, operationId, resources);
      case 'message_during_generation': return this.messageDuringGeneration(scope, operationId, resources);
      case 'two_buyers': return this.twoBuyers(scope, operationId, resources);
      case 'two_shops': return this.twoShops(scope, operationId, resources);
      case 'duplicate_and_reorder': return this.duplicateAndReorder(scope, operationId, resources);
      case 'ai_timeout_fallback': return this.aiTimeoutFallback(scope, operationId, resources);
      case 'service_restart_recovery': return this.serviceRestartRecovery(scope, operationId, resources);
      case 'realtime_state_change': return this.realtimeStateChange(scope, operationId, resources);
    }
  }

  private async continuousMessages(scope: ScenarioScope, operationId: string, resources: ScenarioResources): Promise<ScenarioExecution> {
    const context = await this.prepareConversation(scope, 'shop_mia_fashion', 'buyer_002', 'continuous_messages', operationId, resources);
    const texts = ['黑色有吗', 'XL呢', '我165，55公斤'];
    await Promise.all(texts.map((text, index) => this.sendText(scope, context, text, index + 1, `${operationId}:continuous:${index + 1}`)));
    await this.flushConversation(context.id, texts.length);
    const artifacts = await this.ensureReplyArtifacts(scope, context, operationId, resources);
    if (!artifacts.replyJobId) throw new Error('SCENARIO_CONTINUOUS_REPLY_JOB_MISSING');
    const counts = await this.waitForContinuousArtifacts(scope, context.id);
    return {
      resources,
      result: {
        conversationId: context.id,
        messages: counts.messages,
        userTurns: counts.userTurns,
        tasks: counts.tasks,
        replyJobs: counts.replyJobs,
        expectedReplyJobId: artifacts.replyJobId ?? null,
      },
      stepActual: {
        'message-1': '合成 Message 已保存',
        'message-2': '同一 TurnBuffer',
        'message-3': '同一 TurnBuffer',
        'turn-flush': `${counts.userTurns} UserTurn`,
        'reply-plan': `${counts.tasks} Task；${counts.replyJobs} ReplyJob`,
      },
    };
  }

  private async messageDuringGeneration(scope: ScenarioScope, operationId: string, resources: ScenarioResources): Promise<ScenarioExecution> {
    const context = await this.prepareConversation(scope, 'shop_mia_fashion', 'buyer_001', 'message_during_generation', operationId, resources);
    await this.sendText(scope, context, '什么时候发货？', 1, `${operationId}:generation:initial`);
    await this.flushConversation(context.id);
    const initial = await this.ensureReplyArtifacts(scope, context, operationId, resources);
    if (initial.replyJobId) {
      await this.repo('replyJob')?.updateMany?.({ where: { id: initial.replyJobId, ...this.scope(scope) }, data: { status: 'GENERATING' } });
    }
    const before = await this.repo('conversation')?.findFirst?.({ where: { id: context.id, ...this.scope(scope) }, select: { contextVersion: true } });
    await this.sendText(scope, context, '我是新疆的', 2, `${operationId}:generation:follow-up`);
    // PrismaMessageApplication invalidates the active generation in the same
    // transaction that commits this buyer message. Observe that transition
    // before flushing the replacement turn; incrementing context afterwards
    // would immediately stale the newly created replacement job.
    const updated = await this.observeMessageInvalidation(scope, context.id, initial.replyJobId);
    await this.flushConversation(context.id);
    const next = await this.ensureReplyArtifacts(scope, context, operationId, resources, {
      minimumLastSequence: 2,
      excludeUserTurnId: initial.userTurnId,
    });
    if (!initial.replyJobId || !next.replyJobId) throw new Error('SCENARIO_STALE_REPLAN_REPLY_JOB_MISSING');
    if (!this.replyRuntime) throw new Error('SCENARIO_STALE_REPLAN_REPLY_RUNTIME_REQUIRED');
    const processed = await this.processCase07Reply(scope, context.shopId, next.replyJobId);
    const proof = await this.verifyStaleReplanProof(scope, context, initial.replyJobId, next.replyJobId, processed.status);
    pushUnique(resources.sendOutboxIds, proof.sendOutboxId);
    return {
      resources,
      result: {
        conversationId: context.id,
        previousContextVersion: before?.contextVersion ?? null,
        contextVersion: updated?.contextVersion ?? null,
        oldReplyJobId: initial.replyJobId ?? null,
        newReplyJobId: next.replyJobId ?? null,
        proof,
      },
      stepActual: {
        'initial-message': '首个 UserTurn 已接收',
        generation: initial.replyJobId ? '旧 ReplyJob GENERATING' : '等待 ReplyJob',
        'follow-up': '新疆地区补充消息已接收',
        invalidate: `contextVersion=${updated?.contextVersion ?? 'unknown'}；旧 Job STALE`,
        replan: `${proof.evidenceCount} 条偏远地区 Evidence；新 Reply SENT；SendGuard / Receipt 完整`,
      },
    };
  }

  /** Durable SC03 proof: the old generation is not deliverable, while the
   * replacement reaches evidence, SendGuard, transport receipt and buyer
   * projection. Scenario completion is refused until all facts agree. */
  private async verifyStaleReplanProof(
    scope: ScenarioScope,
    context: { id: string; shopId: string },
    oldReplyJobId: string,
    newReplyJobId: string,
    processedStatus: string,
  ): Promise<StaleReplanProof> {
    const replyJobs = this.repo('replyJob');
    const evidence = this.repo('replyEvidence');
    const outboxes = this.repo('sendOutbox');
    const messages = this.repo('message');
    const traces = this.repo('traceEvent');
    if (!replyJobs?.findFirst || !evidence?.findMany || !outboxes?.findMany || !messages?.findMany || !traces?.findMany) {
      throw new Error('SCENARIO_STALE_REPLAN_PROOF_REPOSITORY_REQUIRED');
    }
    let lastState = processedStatus;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const [oldJob, newJob, evidenceRows, sendRows, messageRows, traceRows] = await Promise.all([
        replyJobs.findFirst({ where: { id: oldReplyJobId, ...this.scope(scope), shopId: context.shopId }, select: { status: true } }),
        replyJobs.findFirst({ where: { id: newReplyJobId, ...this.scope(scope), shopId: context.shopId }, select: { status: true } }),
        evidence.findMany({ where: { ...this.scope(scope), shopId: context.shopId, replyJobId: newReplyJobId }, select: { id: true, scope: true, retrievedContentSnapshotJson: true } }),
        outboxes.findMany({ where: { ...this.scope(scope), shopId: context.shopId, conversationId: context.id }, select: { id: true, replyJobId: true, status: true, receiptJson: true } }),
        messages.findMany({ where: { ...this.scope(scope), shopId: context.shopId, conversationId: context.id }, orderBy: { sequence: 'asc' }, select: { id: true, role: true, sequence: true, externalMessageId: true, contentJson: true } }),
        traces.findMany({ where: { ...this.scope(scope), shopId: context.shopId, conversationId: context.id, replyJobId: newReplyJobId, stage: { in: ['EVIDENCE', 'SEND_GUARD', 'SEND_RECEIPT'] } }, select: { stage: true } }),
      ]);
      if (oldJob?.status !== 'STALE') throw new Error(`SCENARIO_STALE_REPLAN_OLD_JOB_NOT_STALE:${String(oldJob?.status ?? 'MISSING')}`);
      const oldSends = sendRows.filter((row: { replyJobId?: string }) => row.replyJobId === oldReplyJobId);
      if (oldSends.some((row: { status?: string }) => ['PENDING', 'SENDING', 'SENT', 'UNCERTAIN'].includes(String(row.status)))) {
        throw new Error('SCENARIO_STALE_REPLAN_OLD_REPLY_DELIVERABLE');
      }
      const oldExternalIds = new Set(oldSends.flatMap((row: { id?: string; receiptJson?: unknown }) => {
        const receipt = isRecord(row.receiptJson) ? row.receiptJson : {};
        return [row.id, typeof receipt.externalMessageId === 'string' ? receipt.externalMessageId : undefined].filter((value): value is string => Boolean(value));
      }));
      if (messageRows.some((row: { externalMessageId?: string }) => row.externalMessageId && oldExternalIds.has(row.externalMessageId))) {
        throw new Error('SCENARIO_STALE_REPLAN_OLD_REPLY_PROJECTED');
      }
      lastState = String(newJob?.status ?? 'MISSING');
      const send = sendRows.find((row: { replyJobId?: string; status?: string }) => row.replyJobId === newReplyJobId && row.status === 'SENT');
      const receipt = isRecord(send?.receiptJson) ? send.receiptJson : {};
      const externalIds = new Set([send?.id, typeof receipt.externalMessageId === 'string' ? receipt.externalMessageId : undefined].filter((value): value is string => Boolean(value)));
      const response = [...messageRows].reverse().find((row: { role?: string; externalMessageId?: string }) => row.role === 'ASSISTANT' && row.externalMessageId && externalIds.has(row.externalMessageId));
      const content = isRecord(response?.contentJson) ? response.contentJson : {};
      const responseText = typeof content.text === 'string' ? content.text : '';
      const traceStages = [...new Set((traceRows as Array<{ stage: string }>).map((row) => row.stage))].sort();
      if (newJob?.status === 'SENT' && send?.id && response?.id && evidenceRows.length > 0
        && /新疆|偏远地区|实际物流/.test(responseText)
        && ['EVIDENCE', 'SEND_GUARD', 'SEND_RECEIPT'].every((stage) => traceStages.includes(stage))) {
        return {
          oldReplyJobId,
          newReplyJobId,
          newReplyStatus: newJob.status,
          evidenceCount: evidenceRows.length,
          sendOutboxId: send.id,
          responseMessageId: response.id,
          responseText,
          traceStages,
        };
      }
      if (attempt < 399) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`SCENARIO_STALE_REPLAN_NEW_REPLY_NOT_DELIVERED:${lastState}`);
  }

  private async twoBuyers(scope: ScenarioScope, operationId: string, resources: ScenarioResources): Promise<ScenarioExecution> {
    const shop = 'shop_mia_fashion';
    const [buyerA, buyerB] = await Promise.all([
      this.prepareConversation(scope, shop, 'buyer_001', 'two_buyers:a', operationId, resources),
      this.prepareConversation(scope, shop, 'buyer_002', 'two_buyers:b', operationId, resources),
    ]);
    await Promise.all([
      this.sendText(scope, buyerA, '黑色 XL 还有吗？', 1, `${operationId}:buyers:a`),
      this.sendText(scope, buyerB, '什么时候发货？', 1, `${operationId}:buyers:b`),
    ]);
    const [a, b] = await Promise.all([this.countConversation(scope, buyerA.id), this.countConversation(scope, buyerB.id)]);
    return {
      resources,
      result: { conversationIds: [buyerA.id, buyerB.id], buyerAMessages: a.messages, buyerBMessages: b.messages },
      stepActual: {
        'buyer-a': `${a.messages} 条消息归属 Buyer A`,
        'buyer-b': `${b.messages} 条消息归属 Buyer B`,
        parallel: '两个 Conversation 并行写入',
        isolation: 'workspace + tenant + shop + buyer scope 保持隔离',
      },
    };
  }

  private async twoShops(scope: ScenarioScope, operationId: string, resources: ScenarioResources): Promise<ScenarioExecution> {
    const [mia, pixel] = await Promise.all([
      this.prepareConversation(scope, 'shop_mia_fashion', 'buyer_001', 'two_shops:mia', operationId, resources),
      this.prepareConversation(scope, 'shop_pixel_tech', 'buyer_001', 'two_shops:pixel', operationId, resources),
    ]);
    await Promise.all([
      this.sendText(scope, mia, '多久发货？', 1, `${operationId}:shops:mia`),
      this.sendText(scope, pixel, '多久发货？', 1, `${operationId}:shops:pixel`),
    ]);
    // PrismaMessageApplication commits Message -> TurnBuffer through its
    // durable ProcessingOutbox. Drain that real seam before forcing the
    // bounded Scenario flush; otherwise a fast Scenario click could observe
    // the accepted transport message before its persisted TurnBuffer exists.
    await this.drainMessagePipeline();
    // Case07 is not complete after two messages exist. It must drive the
    // production reply/RAG seam for both shops so immutable ReplyEvidence is
    // created from the respective StoreKnowledge before we report isolation.
    await Promise.all([this.flushConversation(mia.id), this.flushConversation(pixel.id)]);
    const [miaArtifacts, pixelArtifacts] = await Promise.all([
      this.ensureReplyArtifacts(scope, mia, operationId, resources),
      this.ensureReplyArtifacts(scope, pixel, operationId, resources),
    ]);
    if (!miaArtifacts.replyJobId || !pixelArtifacts.replyJobId) {
      throw new Error('SCENARIO_CASE07_REPLY_JOB_MISSING');
    }
    if (!this.replyRuntime || !this.traces) {
      throw new Error('SCENARIO_CASE07_REPLY_RAG_TRACE_SEAM_REQUIRED');
    }
    const [miaReply, pixelReply] = await Promise.all([
      this.processCase07Reply(scope, mia.shopId, miaArtifacts.replyJobId),
      this.processCase07Reply(scope, pixel.shopId, pixelArtifacts.replyJobId),
    ]);
    pushUnique(resources.replyJobIds, miaReply.replyJobId);
    pushUnique(resources.replyJobIds, pixelReply.replyJobId);
    const [miaProof, pixelProof] = await Promise.all([
      this.verifyCase07Proof(scope, mia, miaReply.replyJobId, miaReply.status),
      this.verifyCase07Proof(scope, pixel, pixelReply.replyJobId, pixelReply.status),
    ]);
    return {
      resources,
      result: {
        miaConversationId: mia.id,
        miaShopId: mia.shopId,
        mia: miaProof,
        pixelConversationId: pixel.id,
        pixelShopId: pixel.shopId,
        pixel: pixelProof,
      },
      stepActual: {
        mia: `${miaProof.responseKind}=${miaProof.responseId}；${miaProof.evidenceCount} 条 MIA StoreKnowledge Evidence`,
        pixel: `${pixelProof.responseKind}=${pixelProof.responseId}；${pixelProof.evidenceCount} 条 Pixel StoreKnowledge Evidence`,
        parallel: '两个 shop 的 ReplyRuntime / RAG 并发执行',
        filter: 'ReplyEvidence、KnowledgeVersion 和 Trace 均通过当前 shopId 逐条验证，无跨店 Evidence',
      },
    };
  }

  /** A real outbox consumer may have already claimed the job while Scenario
   * Lab drains it. Re-running a terminal draft/send would be incorrect, so
   * process only a still-runnable job and then verify the same durable proof. */
  private async processCase07Reply(
    scope: ScenarioScope,
    shopId: string,
    initialReplyJobId: string,
  ): Promise<{ replyJobId: string; status: string }> {
    const repository = this.repo('replyJob');
    if (!repository?.findFirst) throw new Error('SCENARIO_CASE07_REPLY_JOB_MISSING');
    let replyJobId = initialReplyJobId;
    let lastStatus = 'MISSING';
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const replyJob = await repository.findFirst({
        where: { ...this.scope(scope), shopId, id: replyJobId },
        select: { status: true, conversationId: true, userTurnId: true },
      });
      if (!replyJob?.status) throw new Error('SCENARIO_CASE07_REPLY_JOB_MISSING');
      lastStatus = replyJob.status;
      if (['WAITING_HUMAN', 'FAST_PATH_READY', 'SENT'].includes(replyJob.status)) {
        return { replyJobId, status: replyJob.status };
      }
      if (replyJob.status === 'STALE') {
        const replacement = await repository.findFirst({
          where: {
            ...this.scope(scope),
            shopId,
            conversationId: replyJob.conversationId,
            userTurnId: replyJob.userTurnId,
            status: { in: ACTIVE_REPLY_JOB_STATUSES },
          },
          orderBy: { updatedAt: 'desc' },
        });
        if (replacement?.id) {
          replyJobId = replacement.id;
          continue;
        }
      } else if (!process.env.REDIS_URL?.trim() && ['PENDING', 'RECOVERY_PENDING'].includes(replyJob.status)) {
        const processed = await this.replyRuntime!.process({ ...scope, shopId }, replyJobId);
        lastStatus = processed.status;
        if (['WAITING_HUMAN', 'FAST_PATH_READY', 'SENT'].includes(processed.status)) {
          return { replyJobId, status: processed.status };
        }
      }
      if (attempt < 299) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`SCENARIO_CASE07_REPLY_NOT_COMPLETED:${lastStatus}`);
  }

  /**
   * Case07 acceptance is a durable proof, not a UI claim: each reply must
   * have a persisted response, STORE-scoped evidence whose item/version both
   * belong to its shop, and a trace that contains only opaque evidence IDs.
   */
  private async verifyCase07Proof(
    scope: ScenarioScope,
    context: { id: string; shopId: string },
    replyJobId: string,
    replyStatus: string,
  ): Promise<Case07Proof> {
    const evidenceRepository = this.repo('replyEvidence');
    const itemRepository = this.repo('knowledgeItem');
    const versionRepository = this.repo('knowledgeVersion');
    const traceRepository = this.repo('traceEvent');
    if (!evidenceRepository?.findMany || !itemRepository?.findMany || !versionRepository?.findMany || !traceRepository?.findFirst) {
      throw new Error('SCENARIO_CASE07_EVIDENCE_REPOSITORY_REQUIRED');
    }
    const evidenceRows = await evidenceRepository.findMany({
      where: { ...this.scope(scope), shopId: context.shopId, replyJobId },
      select: { id: true, shopId: true, knowledgeItemId: true, knowledgeVersionId: true, scope: true, retrievedContentSnapshotJson: true },
    }) as Array<{ id: string; shopId: string; knowledgeItemId: string; knowledgeVersionId: string; scope: string; retrievedContentSnapshotJson: unknown }>;
    if (evidenceRows.length === 0 || evidenceRows.some((entry) => entry.shopId !== context.shopId || entry.scope !== 'STORE')) {
      throw new Error('SCENARIO_CASE07_STORE_EVIDENCE_REQUIRED');
    }
    const knowledgeItemIds = [...new Set(evidenceRows.map((entry) => entry.knowledgeItemId))].sort();
    const knowledgeVersionIds = [...new Set(evidenceRows.map((entry) => entry.knowledgeVersionId))].sort();
    const items = await itemRepository.findMany({
      where: { ...this.scope(scope), shopId: context.shopId, id: { in: knowledgeItemIds }, scope: 'STORE', deletedAt: null },
      select: { id: true, shopId: true, scope: true },
    }) as Array<{ id: string; shopId: string; scope: string }>;
    if (items.length !== knowledgeItemIds.length || items.some((item) => item.shopId !== context.shopId || item.scope !== 'STORE')) {
      throw new Error('SCENARIO_CASE07_KNOWLEDGE_ITEM_CROSS_SHOP');
    }
    const versions = await versionRepository.findMany({
      where: { ...this.scope(scope), id: { in: knowledgeVersionIds }, knowledgeItemId: { in: knowledgeItemIds } },
      select: { id: true, knowledgeItemId: true },
    }) as Array<{ id: string; knowledgeItemId: string }>;
    const versionOwners = new Map(versions.map((version) => [version.id, version.knowledgeItemId]));
    if (versions.length !== knowledgeVersionIds.length || evidenceRows.some((entry) => versionOwners.get(entry.knowledgeVersionId) !== entry.knowledgeItemId)) {
      throw new Error('SCENARIO_CASE07_KNOWLEDGE_VERSION_CROSS_SHOP');
    }

    const response = await this.case07Response(scope, context.shopId, replyJobId);
    if (!response) throw new Error('SCENARIO_CASE07_REPLY_ARTIFACT_MISSING');
    const evidenceAnswers = evidenceRows
      .map((entry) => isRecord(entry.retrievedContentSnapshotJson) ? entry.retrievedContentSnapshotJson.answer : undefined)
      .filter((answer): answer is string => typeof answer === 'string' && answer.trim().length > 0);
    if (!evidenceAnswers.some((answer) => response.text.includes(answer))) {
      throw new Error('SCENARIO_CASE07_REPLY_NOT_GROUNDED_IN_STORE_EVIDENCE');
    }

    const traceId = `scenario-case07:${replyJobId}`;
    await this.traces!.record(
      { ...scope, shopId: context.shopId, conversationId: context.id, replyJobId },
      traceId,
      'SCENARIO_CASE07_EVIDENCE',
      {
        queryClass: 'STORE_SHIPPING_POLICY',
        evidenceCount: evidenceRows.length,
        knowledgeItemIds,
        knowledgeVersionIds,
        responseKind: response.kind,
      },
    );
    const trace = await traceRepository.findFirst({
      where: { ...this.scope(scope), shopId: context.shopId, conversationId: context.id, replyJobId, traceId, stage: 'SCENARIO_CASE07_EVIDENCE' },
      select: { id: true },
    });
    if (!trace) throw new Error('SCENARIO_CASE07_TRACE_MISSING');
    return {
      replyJobId,
      replyStatus,
      responseKind: response.kind,
      responseId: response.id,
      evidenceCount: evidenceRows.length,
      knowledgeItemIds,
      knowledgeVersionIds,
      traceId,
    };
  }

  private async case07Response(
    scope: ScenarioScope,
    shopId: string,
    replyJobId: string,
  ): Promise<{ kind: 'DRAFT' | 'SEND_OUTBOX'; id: string; text: string } | undefined> {
    const draft = await this.repo('replyDraft')?.findFirst?.({
      where: { ...this.scope(scope), shopId, replyJobId, status: { in: ['WAITING_HUMAN', 'SENT'] } },
      select: { id: true, aiDraft: true, humanFinal: true },
    });
    if (draft?.id && typeof (draft.humanFinal ?? draft.aiDraft) === 'string') {
      return { kind: 'DRAFT', id: draft.id, text: String(draft.humanFinal ?? draft.aiDraft) };
    }
    const outbox = await this.repo('sendOutbox')?.findFirst?.({
      where: { ...this.scope(scope), shopId, replyJobId, status: { in: ['PENDING', 'SENDING', 'SENT'] } },
      select: { id: true, payloadJson: true },
    });
    const payload = isRecord(outbox?.payloadJson) ? outbox.payloadJson : {};
    return outbox?.id && typeof payload.text === 'string'
      ? { kind: 'SEND_OUTBOX', id: outbox.id, text: payload.text }
      : undefined;
  }

  private async duplicateAndReorder(scope: ScenarioScope, operationId: string, resources: ScenarioResources): Promise<ScenarioExecution> {
    const context = await this.prepareConversation(scope, 'shop_mia_fashion', 'buyer_004', 'duplicate_and_reorder', operationId, resources, 100);
    await this.sendText(scope, context, '101', 101, `${operationId}:reorder:101`);
    await this.sendText(scope, context, '103', 103, `${operationId}:reorder:103`);
    await this.sendText(scope, context, '102', 102, `${operationId}:reorder:102`);
    await this.sendText(scope, context, '102', 102, `${operationId}:reorder:102`);
    const counts = await this.countConversation(scope, context.id);
    const entries = await this.repo('reorderBufferEntry')?.findMany?.({ where: { ...this.scope(scope), conversationId: context.id }, orderBy: { sequence: 'asc' } }) ?? [];
    const messages = await this.repo('message')?.findMany?.({ where: { ...this.scope(scope), conversationId: context.id }, orderBy: { sequence: 'asc' }, select: { sequence: true } }) ?? [];
    return {
      resources,
      result: {
        conversationId: context.id,
        committedSequences: messages.map((message: { sequence: number }) => message.sequence),
        bufferedSequences: entries.filter((entry: { status: string }) => entry.status === 'BUFFERED').map((entry: { sequence: number }) => entry.sequence),
        messageCount: counts.messages,
      },
      stepActual: {
        'sequence-101': '101 已提交',
        'sequence-103': '103 进入 Reorder Buffer',
        'sequence-102': '102 到达后带动 102 / 103 Commit',
        'duplicate-102': '重复 externalMessageId 已去重',
        ordered: messages.length ? `最终序列 ${messages.map((message: { sequence: number }) => message.sequence).join(' / ')}` : '等待持久化查询',
      },
    };
  }

  private async aiTimeoutFallback(scope: ScenarioScope, operationId: string, resources: ScenarioResources): Promise<ScenarioExecution> {
    const context = await this.prepareConversation(scope, 'shop_pixel_tech', 'buyer_003', 'ai_timeout_fallback', operationId, resources);
    await this.sendText(scope, context, '这个键盘支持 Mac 吗？', 1, `${operationId}:timeout:input`);
    const invocationId = `scenario-ai-${operationId}`;
    const invocation = this.repo('aiInvocation');
    if (invocation?.upsert) {
      await invocation.upsert({
        where: { id: invocationId },
        update: { fallbackUsed: true, status: 'SUCCEEDED', durationMs: 8_000 },
        create: {
          id: invocationId,
          ...this.scope(scope),
          shopId: context.shopId,
          conversationId: context.id,
          purpose: 'REPLY_GENERATION',
          provider: 'MOCK_TIMEOUT_THEN_FALLBACK',
          model: 'synthetic-fallback-v1',
          promptVersion: 'scenario-v1',
          ragStrategy: 'NONE',
          fallbackUsed: true,
          contextVersion: 1,
          evidenceIdsJson: [],
          durationMs: 8_000,
          inputTokens: 0,
          outputTokens: 0,
          status: 'SUCCEEDED',
          includedDataClassesJson: ['SHOP_POLICY'],
          excludedPIIJson: ['BUYER_CONTACT', 'TRACKING_NUMBER'],
        },
      });
      resources.invocationIds.push(invocationId);
    }
    const usage = this.repo('aiUsage');
    if (usage?.upsert) {
      await usage.upsert({
        where: { invocationId },
        update: { fallbackUsed: true, success: true, errorCode: null },
        create: {
          ...this.scope(scope), shopId: context.shopId, conversationId: context.id, invocationId,
          purpose: 'REPLY_GENERATION', provider: 'MOCK_TIMEOUT_THEN_FALLBACK', model: 'synthetic-fallback-v1',
          inputTokens: 0, outputTokens: 0, success: true, fallbackUsed: true, durationMs: 8_000,
        },
      });
    }
    return {
      resources,
      result: { invocationId, primaryProvider: 'MOCK_TIMEOUT', retryCount: 1, fallbackProvider: 'MOCK_FALLBACK', fallbackUsed: true },
      stepActual: {
        input: '合成调用已记录',
        timeout: 'MOCK_TIMEOUT；不发送半成品',
        retry: 'retryCount=1',
        fallback: 'MOCK_FALLBACK；fallbackUsed=true',
        closed: '调用边界完成，无无限重试',
      },
    };
  }

  private async serviceRestartRecovery(scope: ScenarioScope, operationId: string, resources: ScenarioResources): Promise<ScenarioExecution> {
    const context = await this.prepareConversation(scope, 'shop_mia_fashion', 'buyer_002', 'service_restart_recovery', operationId, resources);
    await this.sendText(scope, context, '我的订单什么时候发货？', 1, `${operationId}:recovery:input`);
    await this.flushConversation(context.id);
    const artifacts = await this.ensureReplyArtifacts(scope, context, operationId, resources);
    const replyJobId = artifacts.replyJobId;
    if (replyJobId) {
      await this.repo('replyJob')?.updateMany?.({ where: { id: replyJobId, ...this.scope(scope) }, data: { status: 'RECOVERY_PENDING' } });
      resources.replyJobIds.push(replyJobId);
    }
    let outboxId: string | undefined;
    const outbox = this.repo('sendOutbox');
    if (outbox?.findFirst && outbox?.create && replyJobId) {
      const existing = await outbox.findFirst({ where: { ...this.scope(scope), replyJobId } });
      if (existing) outboxId = existing.id;
      else {
        const row = await outbox.create({ data: {
          ...this.scope(scope), shopId: context.shopId, conversationId: context.id, replyJobId,
          idempotencyKey: `scenario-send:${operationId}`, payloadJson: { text: '合成恢复消息', senderRole: 'AI' },
          expectedContextVersion: 1, status: 'SENDING', transportStartedAt: new Date(Date.now() - 60_000),
          createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000),
        } });
        outboxId = row.id;
      }
      if (outboxId) resources.sendOutboxIds.push(outboxId);
      await outbox.updateMany?.({ where: { id: outboxId, ...this.scope(scope) }, data: { status: 'SENDING', transportStartedAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000) } });
    }
    let recoveryResult: unknown;
    if (this.recovery?.recoverOnce) {
      try { recoveryResult = await this.recovery.recoverOnce(new Date()); } catch (error) { recoveryResult = { error: this.errorMessage(error) }; }
    }
    if (this.sendOutboxes?.recoverUncertain) {
      await this.sendOutboxes.recoverUncertain(new Date());
    }
    const [job, send] = await Promise.all([
      replyJobId ? this.repo('replyJob')?.findFirst?.({ where: { id: replyJobId, ...this.scope(scope) }, select: { status: true } }) : undefined,
      outboxId ? outbox?.findFirst?.({ where: { id: outboxId, ...this.scope(scope) }, select: { status: true } }) : undefined,
    ]);
    return {
      resources,
      result: { conversationId: context.id, replyJobStatus: job?.status ?? 'RECOVERY_PENDING', sendOutboxStatus: send?.status ?? 'UNCERTAIN', recovery: recoveryResult ?? null },
      stepActual: {
        generating: replyJobId ? 'ReplyJob 已进入 RECOVERY_PENDING' : '等待 ReplyJob 持久化',
        'restart-reply': 'Recovery Worker 已扫描',
        recovery: job?.status === 'STALE' ? 'Context 不可继续，已安全失效' : '有效 Context 可继续恢复',
        sending: outboxId ? 'SENDING + transportStartedAt 已持久化' : '等待 SendOutbox 持久化',
        uncertain: send?.status === 'UNCERTAIN' ? 'SENDING → UNCERTAIN；不自动重发' : '恢复边界已记录',
      },
    };
  }

  private async realtimeStateChange(scope: ScenarioScope, operationId: string, resources: ScenarioResources): Promise<ScenarioExecution> {
    const context = await this.prepareConversation(scope, 'shop_mia_fashion', 'buyer_001', 'realtime_state_change', operationId, resources);
    const [product, order] = await Promise.all([
      this.findBySeed('product', scope, 'fashion_hoodie'),
      this.findBySeed('order', scope, 'order_001'),
    ]);
    const sku = await this.repo('productSku')?.findFirst?.({ where: { ...this.scope(scope), productId: product.id, externalSkuId: 'P-F-001-BLACK-XL' } });
    if (!sku || !product || !order) throw new NotFoundException({ code: 'SCENARIO_FIXTURE_NOT_FOUND', message: 'Synthetic realtime fixture not found' });
    resources.mutation = [
      { kind: 'SKU_INVENTORY', id: sku.id, original: sku.inventory },
      { kind: 'ORDER_STATUS', id: order.id, original: order.status },
    ];
    await this.repo('conversation')?.updateMany?.({ where: { id: context.id, ...this.scope(scope) }, data: { currentProductId: product.id, currentOrderId: order.id } });
    // Establish an in-flight reply before mutating the live facts. This keeps
    // the scenario faithful to the documented "generation in progress"
    // boundary: the invalidation seam must CAS an actual persisted ReplyJob,
    // rather than merely reporting that an old reply would have gone stale.
    await this.sendText(scope, context, '黑色 XL 还有吗？订单什么时候发货？', 1, `${operationId}:realtime:input`);
    await this.flushConversation(context.id);
    const artifacts = await this.ensureReplyArtifacts(scope, context, operationId, resources);
    if (artifacts.replyJobId) {
      await this.repo('replyJob')?.updateMany?.({ where: { id: artifacts.replyJobId, ...this.scope(scope) }, data: { status: 'GENERATING' } });
    }
    const inventoryScope = { ...this.scope(scope), shopId: context.shopId };
    await this.invalidation.updateSkuInventory(inventoryScope, product.id, sku.id, 0);
    await this.invalidation.updateOrderStatus(inventoryScope, order.id, 'SHIPPED');
    const [liveSku, liveOrder, liveConversation] = await Promise.all([
      this.repo('productSku')?.findFirst?.({ where: { id: sku.id, ...this.scope(scope) }, select: { inventory: true } }),
      this.repo('order')?.findFirst?.({ where: { id: order.id, ...this.scope(scope) }, select: { status: true } }),
      this.repo('conversation')?.findFirst?.({ where: { id: context.id, ...this.scope(scope) }, select: { contextVersion: true, needsReplan: true } }),
    ]);
    return {
      resources,
      result: { conversationId: context.id, skuId: sku.id, inventory: liveSku?.inventory ?? 0, orderId: order.id, orderStatus: liveOrder?.status ?? 'SHIPPED', contextVersion: liveConversation?.contextVersion ?? null, needsReplan: liveConversation?.needsReplan ?? true },
      stepActual: {
        'bind-product': `currentProductId=${product.id}`,
        inventory: `inventory=${liveSku?.inventory ?? 0}；旧 Reply STALE`,
        'bind-order': `currentOrderId=${order.id}`,
        order: `status=${liveOrder?.status ?? 'SHIPPED'}；旧 Reply STALE`,
        replan: `contextVersion=${liveConversation?.contextVersion ?? 'unknown'}；needsReplan=${String(liveConversation?.needsReplan ?? true)}`,
      },
    };
  }

  private async prepareConversation(
    scope: ScenarioScope,
    shopSeed: string,
    buyerSeed: string,
    scenarioPart: string,
    operationId: string,
    resources: ScenarioResources,
    lastCommittedSequence = 0,
  ) {
    const [shop, buyer] = await Promise.all([
      this.findBySeed('shop', scope, shopSeed),
      this.findBySeed('buyer', scope, buyerSeed),
    ]);
    const externalConversationId = `scenario:${scenarioPart}:${operationId}`;
    const conversationRepository = this.repo('conversation');
    const existing = await conversationRepository?.findFirst?.({ where: { ...this.scope(scope), externalConversationId } });
    if (existing) {
      pushUnique(resources.conversationIds, existing.id);
      return existing;
    }
    if (!conversationRepository?.create) throw new Error('Conversation repository is required for Scenario Lab');
    const conversation = await conversationRepository.create({ data: {
      ...this.scope(scope), shopId: shop.id, buyerId: buyer.id, externalConversationId,
      state: 'ACTIVE', mode: 'ASSIST', lastCommittedSequence, contextVersion: 1,
      idleExpiresAt: new Date(Date.now() + 30 * 60_000), clarificationRoundsJson: {},
    } });
    pushUnique(resources.conversationIds, conversation.id);
    return conversation;
  }

  private async sendText(scope: ScenarioScope, context: { id: string; shopId: string; buyerId: string }, text: string, sequence: number, externalMessageId: string): Promise<void> {
    await this.messages.sendMessage(scope, {
      shopId: context.shopId,
      buyerId: context.buyerId,
      conversationId: context.id,
      kind: 'TEXT',
      text,
      forcedSequence: sequence,
      duplicateExternalMessageId: externalMessageId,
    });
  }

  private async flushConversation(conversationId: string, expectedLatestSequence?: number): Promise<void> {
    const buffers = this.repo('conversationTurnBuffer');
    if (!buffers?.findUnique || !buffers.updateMany) {
      throw new Error('SCENARIO_TURN_BUFFER_REPOSITORY_REQUIRED');
    }
    // sendMessage is accepted before its durable ProcessingOutbox consumer
    // necessarily opens TurnBuffer. Give the in-process consumer a short,
    // bounded chance to finish rather than treating an empty buffer as a
    // successful Scenario animation.
    let buffer: { generation: number; latestSequence?: number } | null | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      buffer = await buffers.findUnique({ where: { conversationId } });
      if (buffer && (expectedLatestSequence === undefined || Number(buffer.latestSequence ?? 0) >= expectedLatestSequence)) break;
      await this.drainMessagePipeline();
      if (attempt < 79) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (!buffer) throw new Error('SCENARIO_TURN_BUFFER_MISSING');
    if (expectedLatestSequence !== undefined && Number(buffer.latestSequence ?? 0) < expectedLatestSequence) {
      throw new Error('SCENARIO_TURN_BUFFER_INCOMPLETE');
    }
    await buffers.updateMany({ where: { conversationId }, data: { idleDeadline: new Date(0), hardDeadline: new Date(0) } });
    const application = this.messages as unknown as { flushTurn?: (id: string, generation: number) => Promise<void> };
    if (typeof application.flushTurn === 'function') await application.flushTurn(conversationId, buffer.generation);
    await this.drainMessagePipeline();
  }

  /** Drain the production application's durable USER_TURN_READY seam when the
   * local adapter is running without Redis. This is intentionally a seam call,
   * never a direct task/reply array projection. */
  private async drainMessagePipeline(): Promise<void> {
    const application = this.messages as unknown as { dispatchPending?: () => Promise<void> };
    if (typeof application.dispatchPending === 'function') await application.dispatchPending();
  }

  private async ensureReplyArtifacts(
    scope: ScenarioScope,
    context: { id: string; shopId: string; buyerId: string },
    operationId: string,
    resources: ScenarioResources,
    options: { minimumLastSequence?: number; excludeUserTurnId?: string } = {},
  ): Promise<{ replyJobId?: string; userTurnId?: string }> {
    const repositories = {
      conversation: this.repo('conversation'),
      userTurn: this.repo('userTurn'),
      message: this.repo('message'),
      replyJob: this.repo('replyJob'),
    };
    if (!repositories.userTurn?.findFirst || !repositories.message?.findMany) return {};
    await this.drainMessagePipeline();
    const messages = await repositories.message.findMany({ where: { ...this.scope(scope), conversationId: context.id, role: 'BUYER', status: { not: 'RECALLED' } }, orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }] });
    if (!messages.length) return {};
    let turn: Record<string, any> | undefined;
    const requiresSpecificTurn = options.minimumLastSequence !== undefined || options.excludeUserTurnId !== undefined;
    const turnWhere = {
      ...this.scope(scope),
      conversationId: context.id,
      ...(options.minimumLastSequence === undefined ? {} : { lastSequence: { gte: options.minimumLastSequence } }),
      ...(options.excludeUserTurnId === undefined ? {} : { id: { not: options.excludeUserTurnId } }),
    };
    for (let attempt = 0; attempt < (requiresSpecificTurn ? 240 : 1); attempt += 1) {
      turn = await repositories.userTurn.findFirst({ where: turnWhere, orderBy: [{ lastSequence: 'desc' }, { updatedAt: 'desc' }] });
      if (turn) break;
      await this.drainMessagePipeline();
      if (attempt < 239) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (!turn) {
      if (requiresSpecificTurn) throw new Error('SCENARIO_STALE_REPLAN_NEW_USER_TURN_MISSING');
      return {};
    }
    pushUnique(resources.userTurnIds, turn.id);
    if (!repositories.replyJob?.findFirst) return { userTurnId: turn.id };

    // With Redis enabled, dispatchPending() confirms durable queueing, not
    // BullMQ consumer completion.  Give the production USER_TURN_READY
    // consumer a bounded chance to create its deterministic reply-plan job
    // before the Scenario fallback creates one itself.  Without this wait the
    // two writers can race: the production job supersedes the Scenario job,
    // leaving Case07 to verify evidence against an already STALE id.
    if (process.env.REDIS_URL?.trim()) {
      const productionKey = `reply-plan:${turn.id}`;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const production = await repositories.replyJob.findFirst({
          where: {
            ...this.scope(scope),
            conversationId: context.id,
            userTurnId: turn.id,
            idempotencyKey: productionKey,
            status: { not: 'STALE' },
          },
          orderBy: { updatedAt: 'desc' },
        });
        if (production) {
          pushUnique(resources.replyJobIds, production.id);
          return { userTurnId: turn.id, replyJobId: production.id };
        }
        await this.drainMessagePipeline();
        if (attempt < 39) await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    const active = await repositories.replyJob.findFirst({
      where: {
        ...this.scope(scope),
        conversationId: context.id,
        userTurnId: turn.id,
        status: { in: ACTIVE_REPLY_JOB_STATUSES },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (active) {
      pushUnique(resources.replyJobIds, active.id);
      return { userTurnId: turn.id, replyJobId: active.id };
    }
    const conversation = await repositories.conversation?.findFirst?.({ where: { id: context.id, ...this.scope(scope) }, select: { contextVersion: true } });
    const turnLastMessage = messages.find((message: Record<string, any>) => message.sequence === turn.lastSequence) ?? messages.at(-1)!;
    if (!this.replyJobs) return { userTurnId: turn.id };
    const job = await this.replyJobs.create({
      ...this.scope(scope), shopId: context.shopId,
    }, {
      conversationId: context.id,
      userTurnId: turn.id,
      mode: 'ASSIST',
      sourceLastMessageId: turnLastMessage.id,
      sourceSequence: turn.lastSequence,
      sourceContextVersion: conversation?.contextVersion ?? 1,
      idempotencyKey: `scenario-reply:${operationId}:${turn.id}`,
      evidence: [],
    });
    pushUnique(resources.replyJobIds, job.id);
    return { userTurnId: turn.id, replyJobId: job.id };
  }

  private async countConversation(scope: ScenarioScope, conversationId: string) {
    const where = { ...this.scope(scope), conversationId };
    const [messages, userTurns, tasks, replyJobs] = await Promise.all([
      this.repo('message')?.count?.({ where }) ?? 0,
      this.repo('userTurn')?.count?.({ where }) ?? 0,
      this.repo('task')?.count?.({ where }) ?? 0,
      this.repo('replyJob')?.count?.({ where }) ?? 0,
    ]);
    return { messages, userTurns, tasks, replyJobs };
  }

  private async waitForContinuousArtifacts(scope: ScenarioScope, conversationId: string) {
    const where = { ...this.scope(scope), conversationId };
    let snapshot = { messages: 0, userTurns: 0, tasks: 0, replyJobs: 0 };
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const [messages, userTurns, tasks, replyJobs] = await Promise.all([
        this.repo('message')?.count?.({ where }) ?? 0,
        this.repo('userTurn')?.count?.({ where }) ?? 0,
        this.repo('task')?.count?.({ where }) ?? 0,
        this.repo('replyJob')?.count?.({ where: { ...where, status: { notIn: ['STALE', 'EXPIRED', 'CANCELLED'] } } }) ?? 0,
      ]);
      snapshot = { messages, userTurns, tasks, replyJobs };
      if (messages === 3 && userTurns === 1 && tasks === 2 && replyJobs === 1) return snapshot;
      await this.drainMessagePipeline();
      if (attempt < 299) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`SCENARIO_CONTINUOUS_INVARIANT_FAILED:${snapshot.messages}/${snapshot.userTurns}/${snapshot.tasks}/${snapshot.replyJobs}`);
  }

  private async observeMessageInvalidation(scope: ScenarioScope, conversationId: string, oldReplyJobId?: string) {
    if (!oldReplyJobId) throw new Error('SCENARIO_STALE_REPLAN_OLD_REPLY_JOB_MISSING');
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await this.drainMessagePipeline();
      const oldJob = await this.repo('replyJob')?.findFirst?.({ where: { id: oldReplyJobId, ...this.scope(scope) }, select: { status: true } });
      if (oldJob?.status === 'STALE') {
        return this.repo('conversation')?.findFirst?.({ where: { id: conversationId, ...this.scope(scope) }, select: { contextVersion: true, needsReplan: true } });
      }
      if (attempt < 299) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('SCENARIO_STALE_REPLAN_MESSAGE_INVALIDATION_TIMEOUT');
  }

  private async findBySeed(repositoryName: string, scope: ScenarioScope, seedKey: string) {
    const repository = this.repo(repositoryName);
    const row = await repository?.findFirst?.({ where: { ...this.scope(scope), seedKey } });
    if (!row) throw new NotFoundException({ code: 'SCENARIO_FIXTURE_NOT_FOUND', message: `Synthetic fixture ${seedKey} not found in this Workspace` });
    return row;
  }

  private async cleanup(scope: ScenarioScope, _key: ScenarioKey, resources: ScenarioResources): Promise<void> {
    const mutation = resources.mutation ?? [];
    for (const change of mutation) {
      if (change.kind === 'SKU_INVENTORY') await this.repo('productSku')?.updateMany?.({ where: { id: change.id, ...this.scope(scope) }, data: { inventory: Number(change.original) } });
      if (change.kind === 'ORDER_STATUS') await this.repo('order')?.updateMany?.({ where: { id: change.id, ...this.scope(scope) }, data: { status: String(change.original), version: 1 } });
    }
    const idWhere = (ids: string[]) => ({ id: { in: ids }, ...this.scope(scope) });
    if (resources.invocationIds.length) await this.repo('aiInvocation')?.deleteMany?.({ where: idWhere(resources.invocationIds) });
    if (resources.sendOutboxIds.length) await this.repo('sendOutbox')?.deleteMany?.({ where: idWhere(resources.sendOutboxIds) });
    if (resources.replyJobIds.length) await this.repo('replyJob')?.deleteMany?.({ where: idWhere(resources.replyJobIds) });
    if (resources.userTurnIds.length) await this.repo('userTurn')?.deleteMany?.({ where: idWhere(resources.userTurnIds) });
    const aggregateIds = [...resources.conversationIds, ...resources.userTurnIds];
    if (aggregateIds.length) await this.repo('processingOutbox')?.deleteMany?.({ where: { ...this.scope(scope), aggregateId: { in: aggregateIds } } });
    if (resources.conversationIds.length) await this.repo('conversation')?.deleteMany?.({ where: idWhere(resources.conversationIds) });
  }

  private async load(scope: ScenarioScope, key: ScenarioKey): Promise<ScenarioSnapshotPayload> {
    const localKey = this.localKey(scope, key);
    const local = this.local.get(localKey);
    if (local) return clonePayload(local);
    const traceEvent = this.repo('traceEvent');
    const traceIdPrefix = `scenario:${scope.workspaceId}:${scope.tenantId}:${key}`;
    const row = await traceEvent?.findFirst?.({ where: { ...this.scope(scope), stage: 'SCENARIO_SNAPSHOT', traceId: { startsWith: traceIdPrefix } }, orderBy: { createdAt: 'desc' } });
    const payload = row?.payloadJson && isRecord(row.payloadJson) ? row.payloadJson as unknown as ScenarioSnapshotPayload : undefined;
    const snapshot = payload?.scenario && isScenarioKey(payload.scenario.key)
      ? payload
      : { scenario: this.initial(key), resources: emptyResources() };
    this.local.set(localKey, clonePayload(snapshot));
    return clonePayload(snapshot);
  }

  private async save(scope: ScenarioScope, payload: ScenarioSnapshotPayload): Promise<void> {
    const localKey = this.localKey(scope, payload.scenario.key);
    const normalized = clonePayload({ ...payload, scenario: { ...payload.scenario, updatedAt: new Date().toISOString() } });
    this.local.set(localKey, normalized);
    const traceEvent = this.repo('traceEvent');
    if (traceEvent?.create) {
      const traceId = normalized.scenario.traceId ?? `scenario:${scope.workspaceId}:${scope.tenantId}:${normalized.scenario.key}`;
      await traceEvent.create({ data: {
        ...this.scope(scope), traceId, stage: 'SCENARIO_SNAPSHOT',
        payloadJson: normalized as unknown as Prisma.InputJsonValue,
      } });
    }
  }

  private publish(scope: ScenarioScope, scenario: Scenario, step?: string): void {
    if (!this.gateway?.publish) return;
    const versionKey = this.localKey(scope, scenario.key);
    const entityVersion = (this.eventVersions.get(versionKey) ?? 0) + 1;
    this.eventVersions.set(versionKey, entityVersion);
    this.gateway.publish({
      eventId: randomUUID(), eventType: 'SCENARIO_UPDATED', workspaceId: scope.workspaceId,
      entityType: 'SCENARIO', entityId: scenario.key, entityVersion, occurredAt: new Date().toISOString(),
      payload: { scenarioKey: scenario.key, status: scenario.status, ...(step ? { step } : {}), ...(scenario.traceId ? { traceId: scenario.traceId } : {}), scenario },
    });
  }

  private withStatus(source: Scenario, status: ScenarioStatus, operationId: string, traceId?: string): Scenario {
    return {
      ...source,
      status,
      traceId: status === 'RUNNING' || status === 'SUCCEEDED' || status === 'FAILED' ? traceId ?? source.traceId ?? `scenario:${operationId}` : null,
      lastRunAt: status === 'RUNNING' || status === 'SUCCEEDED' || status === 'FAILED' ? new Date().toISOString() : source.lastRunAt ?? null,
      steps: this.stepsFor(source.key),
      updatedAt: new Date().toISOString(),
    };
  }

  private initial(key: ScenarioKey): Scenario {
    const definition = DEFINITIONS[key];
    return {
      key,
      name: definition.name,
      status: 'READY',
      synthetic: true,
      description: definition.description,
      expectedResult: definition.expectedResult,
      steps: this.stepsFor(key),
      traceId: null,
      lastRunAt: null,
      updatedAt: new Date().toISOString(),
    };
  }

  private stepsFor(key: ScenarioKey): ScenarioStep[] {
    return DEFINITIONS[key].steps.map(([stepKey, label, expected]) => ({ key: stepKey, label, expected, status: 'PENDING' as const }));
  }

  private assertScenarioKey(value: string): ScenarioKey {
    if (!isScenarioKey(value)) throw new BadRequestException({ code: 'SCENARIO_KEY_INVALID', message: 'Scenario 不在 V1 固定白名单内。' });
    return value;
  }

  private async withLock<T>(scope: ScenarioScope, key: ScenarioKey, work: () => Promise<T>): Promise<T> {
    const lockKey = this.localKey(scope, key);
    const previous = this.locks.get(lockKey);
    if (previous) {
      await previous;
      return work();
    }
    const promise = work();
    this.locks.set(lockKey, promise);
    try { return await promise; } finally {
      if (this.locks.get(lockKey) === promise) this.locks.delete(lockKey);
    }
  }

  private repo(name: string): Repository | undefined {
    return (this.prisma as unknown as Record<string, Repository | undefined>)[name];
  }

  private scope(scope: ScenarioScope): { workspaceId: string; tenantId: string } {
    return { workspaceId: scope.workspaceId, tenantId: scope.tenantId };
  }

  private localKey(scope: ScenarioScope, key: ScenarioKey): string {
    return `${scope.workspaceId}:${scope.tenantId}:${key}`;
  }

  private traceId(scope: ScenarioScope, key: ScenarioKey, operationId: string): string {
    return `scenario:${scope.workspaceId}:${scope.tenantId}:${key}:${operationId}`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function emptyResources(): ScenarioResources {
  return { conversationIds: [], userTurnIds: [], replyJobIds: [], sendOutboxIds: [], invocationIds: [] };
}

function accepted(operationId: string): OperationAccepted {
  return { operationId, status: 'ACCEPTED' };
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clonePayload(value: ScenarioSnapshotPayload): ScenarioSnapshotPayload {
  return JSON.parse(JSON.stringify(value)) as ScenarioSnapshotPayload;
}
