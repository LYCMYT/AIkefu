import type { ReplyEvalCase, ReplyEvalExecution } from './reply-eval-runner';
import type { PrismaService } from '../database/prisma.service';
import type { MessageApplication } from '../messages/message.application';
import type { WorkspaceService } from '../workspaces/workspace.service';
import type { AttachmentService } from '../attachments/attachments.service';
import type { KnowledgeService } from '../knowledge/knowledge.service';
import type { ContextInvalidationService } from '../replies/context-invalidation.service';
import type { ConversationReplyControlService } from '../replies/conversation-reply-control.service';
import type { ReplyDraftService } from '../replies/reply-draft.service';
import type { AiEvalFaultRegistry } from './ai-eval-fault-registry';
import type { WorkflowProposalService } from '../workflow/workflow-proposal.service';
import type { ReplyRecoveryService } from '../replies/reply-recovery.service';
import type { SendOutboxService } from '../replies/send-outbox.service';
import { randomUUID } from 'node:crypto';

type JsonRecord = Record<string, unknown>;

export type ProductionReplyEvalProjection = {
  workspaceId: string;
  conversationId: string;
  oldReplySent?: boolean;
  replyJob: {
    id: string;
    userTurnId: string;
    status: string;
    mode: string;
    conversationHumanActive?: boolean;
    draft: { id: string; aiDraft: string; status: string } | null;
    sendOutbox: {
      id: string;
      status: string;
      payloadJson: unknown;
      receiptJson: unknown;
    } | null;
  };
  tasks: Array<{ id: string; intent: string; status: string; resultJson: unknown; requiredToolsJson?: unknown }>;
  evidences: Array<{
    id: string;
    knowledgeItemId: string;
    knowledgeVersionId: string;
    sourceType: string;
    scope: string;
    productId: string | null;
    retrievalScore: number | null;
    retrievedContentSnapshotJson: unknown;
    knowledgeKey?: string;
    productKey?: string | null;
  }>;
  traceEvents: Array<{ id: string; stage: string; payloadJson: unknown }>;
  invocations: Array<{
    id: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number | null;
  }>;
  assistantMessages: Array<{
    id: string;
    externalMessageId: string;
    contentJson: unknown;
  }>;
};

export type ProductionReplyEvalFixture = {
  workspaceId: string;
  tenantId: string;
  shops: Record<string, string>;
  buyers: Record<string, string>;
  products: Record<string, string>;
  orders: Record<string, string>;
};

type EvalMessageInput = {
  workspaceId: string;
  tenantId: string;
  shopId: string;
  buyerId: string;
  conversationId?: string;
};

export type ProductionReplyEvalPort = {
  createIsolatedWorkspace(): Promise<ProductionReplyEvalFixture>;
  deleteIsolatedWorkspace(workspaceId: string): Promise<void>;
  setShopAiMode?(input: EvalMessageInput & { mode: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY' }): Promise<void>;
  sendText(input: EvalMessageInput & { text: string }): Promise<{ conversationId: string }>;
  sendProductCard(input: EvalMessageInput & { productId: string }): Promise<{ conversationId: string }>;
  sendOrderCard(input: EvalMessageInput & { orderId: string }): Promise<{ conversationId: string }>;
  sendImageFixture(input: EvalMessageInput & { fixture: string }): Promise<{ conversationId: string }>;
  sendDuplicateText?(input: EvalMessageInput & { text: string }): Promise<{ conversationId: string }>;
  sendOutOfOrderTexts?(input: EvalMessageInput & { texts: string[] }): Promise<{ conversationId: string }>;
  prepareHumanActive?(input: EvalMessageInput): Promise<{ conversationId: string }>;
  setHumanActive?(input: EvalMessageInput & { conversationId: string }): Promise<void>;
  changeLogistics?(input: EvalMessageInput & { conversationId: string; orderId: string; toNode: string }): Promise<void>;
  editPreviousBuyerMessage(input: EvalMessageInput & { conversationId: string; text: string }): Promise<void>;
  recallPreviousBuyerMessage(input: EvalMessageInput & { conversationId: string }): Promise<void>;
  activateConflict?(input: EvalMessageInput & { fixture: string }): Promise<void>;
  changeSkuInventory?(input: EvalMessageInput & { skuExternalId: string; inventory: number }): Promise<void>;
  changeOrderStatus?(input: EvalMessageInput & { orderId: string; status: string }): Promise<void>;
  prepareGenerationBarrier?(input: EvalMessageInput): Promise<void>;
  waitForGenerationBarrier?(input: EvalMessageInput & { conversationId: string }): Promise<{ replyJobId: string } | void>;
  releaseGenerationBarrier?(input: EvalMessageInput): Promise<void>;
  applyHumanEdit?(input: EvalMessageInput & { conversationId: string; editType: string; projection: ProductionReplyEvalProjection }): Promise<void>;
  advanceDraftTime?(input: EvalMessageInput & { conversationId: string; minutes: number }): Promise<void>;
  configureProviderScenario?(input: EvalMessageInput & { primaryProvider: string; fallback: string }): Promise<void>;
  prepareRestart?(input: EvalMessageInput & { phase: string }): Promise<void>;
  waitForPreTransportSend?(input: {
    workspaceId: string;
    tenantId: string;
    shopId: string;
    conversationId: string;
    afterReplyJobId?: string;
    invalidatedReplyJobId?: string;
  }): Promise<ProductionReplyEvalProjection>;
  resumeAfterRestart?(input: EvalMessageInput & { conversationId: string; phase: string; projection?: ProductionReplyEvalProjection }): Promise<void>;
  staleWorkflowBeforeApproval?(input: EvalMessageInput & { conversationId: string }): Promise<void>;
  prepareWorkflowApproval?(input: EvalMessageInput): Promise<void>;
  waitForProjection(input: {
    workspaceId: string;
    tenantId: string;
    shopId: string;
    conversationId: string;
    afterReplyJobId?: string;
    invalidatedReplyJobId?: string;
  }): Promise<ProductionReplyEvalProjection>;
};

/** Runs exactly one frozen case in its own seeded Workspace. */
export class ProductionReplyEvalExecutor {
  constructor(private readonly port: ProductionReplyEvalPort) {}

  async execute(testCase: ReplyEvalCase): Promise<ReplyEvalExecution> {
    const fixture = await this.port.createIsolatedWorkspace();
    let generationBarrierPrepared = false;
    let generationBarrierInput: EvalMessageInput | undefined;
    try {
      const contextSetup = record(testCase.contextSetup);
      const conflictFixture = typeof contextSetup.activateConflict === 'string'
        ? contextSetup.activateConflict
        : undefined;
      const supportedSetupKeys = new Set([
        'activateConflict',
        'changeInventoryDuringGeneration',
        'changeOrderDuringGeneration',
        'humanEditType',
        'advanceTimeMinutes',
        'primaryProvider',
        'fallback',
        'changeContextBeforeApproval',
        'restartDuring',
        'shopAiMode',
        'humanActive',
        'duplicateTransport',
        'outOfOrderTransport',
        'changeLogisticsDuringGeneration',
      ]);
      const setupKeys = Object.entries(contextSetup)
        .filter(([, value]) => value !== undefined && value !== false && value !== null)
        .filter(([key]) => !supportedSetupKeys.has(key))
        .map(([key]) => key);
      if (setupKeys.length) throw new Error(`EXECUTOR_UNSUPPORTED:${setupKeys.join(',')}`);
      const shopKey = required(testCase.shopKey, 'SHOP_KEY_REQUIRED');
      const buyerKey = required(testCase.buyerKey, 'BUYER_KEY_REQUIRED');
      const shopId = required(fixture.shops[shopKey], `SHOP_FIXTURE_NOT_FOUND:${shopKey}`);
      const buyerId = required(fixture.buyers[buyerKey], `BUYER_FIXTURE_NOT_FOUND:${buyerKey}`);
      const scope = { workspaceId: fixture.workspaceId, tenantId: fixture.tenantId, shopId, buyerId };
      const shopAiMode = stringField(contextSetup, 'shopAiMode');
      if (shopAiMode) {
        if (!['AUTO_ALLOWED', 'ASSIST_ONLY', 'MANUAL_ONLY'].includes(shopAiMode) || !this.port.setShopAiMode) {
          throw new Error(`EXECUTOR_UNSUPPORTED:shopAiMode:${shopAiMode}`);
        }
        await this.port.setShopAiMode({
          ...scope,
          mode: shopAiMode as 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY',
        });
      }
      const primaryProvider = stringField(contextSetup, 'primaryProvider');
      const fallback = stringField(contextSetup, 'fallback');
      if (primaryProvider || fallback) {
        if (!primaryProvider || !fallback || !this.port.configureProviderScenario) throw new Error('EXECUTOR_UNSUPPORTED:providerScenario');
        await this.port.configureProviderScenario({ ...scope, primaryProvider, fallback });
      }
      const restartDuring = stringField(contextSetup, 'restartDuring');
      if (restartDuring) {
        if (!this.port.prepareRestart) throw new Error('EXECUTOR_UNSUPPORTED:restartDuring');
        await this.port.prepareRestart({ ...scope, phase: restartDuring });
      }
      if (contextSetup.changeContextBeforeApproval === true) {
        if (!this.port.prepareWorkflowApproval) throw new Error('EXECUTOR_UNSUPPORTED:changeContextBeforeApproval');
        await this.port.prepareWorkflowApproval(scope);
      }
      if (conflictFixture) {
        if (!this.port.activateConflict) throw new Error('EXECUTOR_UNSUPPORTED:activateConflict');
        await this.port.activateConflict({ ...scope, fixture: conflictFixture });
      }
      let conversationId: string | undefined;
      let humanPrepared = false;
      if (contextSetup.humanActive === true && this.port.prepareHumanActive) {
        const prepared = await this.port.prepareHumanActive(scope);
        conversationId = prepared.conversationId;
        humanPrepared = true;
      }
      const outOfOrderTransport = contextSetup.outOfOrderTransport === true;
      const duplicateTransport = contextSetup.duplicateTransport === true;
      const inventoryChange = record(contextSetup.changeInventoryDuringGeneration);
      const orderChange = record(contextSetup.changeOrderDuringGeneration);
      const logisticsChange = record(contextSetup.changeLogisticsDuringGeneration);
      const mutationDuringGeneration = [inventoryChange, orderChange, logisticsChange]
        .some((change) => Object.keys(change).length > 0);
      if (
        mutationDuringGeneration
        && (!this.port.prepareGenerationBarrier || !this.port.waitForGenerationBarrier || !this.port.releaseGenerationBarrier)
      ) {
        throw new Error('EXECUTOR_UNSUPPORTED:generationBarrier');
      }
      const transportTexts = testCase.messages.flatMap((message) => {
        if (typeof message === 'string') return [message];
        const structured = record(message);
        return stringField(structured, 'type') === 'TEXT' ? [required(stringField(structured, 'text'), 'TEXT_REQUIRED')] : [];
      });
      let activeTurn: number | undefined;
      let previousTurnReplyJobId: string | undefined;
      // A turn boundary only has a projection to await when its immediately
      // preceding operation can durably plan a reply. Recalling a buyer
      // message invalidates old work but deliberately creates no new turn.
      let previousOperationPlansReply = false;
      for (const [messageIndex, message] of testCase.messages.entries()) {
        if (mutationDuringGeneration && messageIndex === testCase.messages.length - 1) {
          generationBarrierInput = { ...scope, conversationId };
          await this.port.prepareGenerationBarrier!(generationBarrierInput);
          generationBarrierPrepared = true;
        }
        const structured = typeof message === 'string' ? undefined : record(message);
        const declaredTurn = structured ? optionalPositiveInteger(structured.turn) : undefined;
        if (
          declaredTurn !== undefined
          && activeTurn !== undefined
          && declaredTurn > activeTurn
          && conversationId
          && !outOfOrderTransport
          && previousOperationPlansReply
        ) {
          const completedTurn = await this.port.waitForProjection({
            ...evalScope(scope),
            shopId,
            conversationId,
            afterReplyJobId: previousTurnReplyJobId,
          });
          previousTurnReplyJobId = completedTurn.replyJob.id;
        }
        if (declaredTurn !== undefined) activeTurn = declaredTurn;
        if (typeof message === 'string') {
          if (outOfOrderTransport) continue;
          if (duplicateTransport && !this.port.sendDuplicateText) throw new Error('EXECUTOR_UNSUPPORTED:duplicateTransport');
          const sent = duplicateTransport
            ? await this.port.sendDuplicateText!({ ...scope, conversationId, text: message })
            : await this.port.sendText({ ...scope, conversationId, text: message });
          conversationId = sent.conversationId;
          previousOperationPlansReply = true;
          continue;
        }
        const type = stringField(structured!, 'type');
        if (type === 'TEXT') {
          if (outOfOrderTransport) continue;
          const text = required(stringField(structured!, 'text'), 'TEXT_REQUIRED');
          if (duplicateTransport && !this.port.sendDuplicateText) throw new Error('EXECUTOR_UNSUPPORTED:duplicateTransport');
          const sent = duplicateTransport
            ? await this.port.sendDuplicateText!({ ...scope, conversationId, text })
            : await this.port.sendText({ ...scope, conversationId, text });
          conversationId = sent.conversationId;
          previousOperationPlansReply = true;
          continue;
        }
        if (type === 'GOODS_CARD') {
          const productKey = required(stringField(structured!, 'productKey'), 'PRODUCT_KEY_REQUIRED');
          const productId = required(fixture.products[productKey], `PRODUCT_FIXTURE_NOT_FOUND:${productKey}`);
          const sent = await this.port.sendProductCard({ ...scope, conversationId, productId });
          conversationId = sent.conversationId;
          previousOperationPlansReply = true;
          continue;
        }
        if (type === 'ORDER_CARD') {
          const orderKey = required(stringField(structured!, 'orderKey'), 'ORDER_KEY_REQUIRED');
          const orderId = required(fixture.orders[orderKey], `ORDER_FIXTURE_NOT_FOUND:${orderKey}`);
          const sent = await this.port.sendOrderCard({ ...scope, conversationId, orderId });
          conversationId = sent.conversationId;
          previousOperationPlansReply = true;
          continue;
        }
        if (type === 'IMAGE') {
          const sent = await this.port.sendImageFixture({
            ...scope,
            conversationId,
            fixture: required(stringField(structured!, 'fixture'), 'IMAGE_FIXTURE_REQUIRED'),
          });
          conversationId = sent.conversationId;
          previousOperationPlansReply = true;
          continue;
        }
        const action = stringField(structured!, 'action');
        if (action === 'EDIT_PREVIOUS') {
          if (!conversationId) throw new Error('PREVIOUS_BUYER_MESSAGE_NOT_FOUND');
          await this.port.editPreviousBuyerMessage({
            ...scope,
            conversationId,
            text: required(stringField(structured!, 'text'), 'EDIT_TEXT_REQUIRED'),
          });
          previousOperationPlansReply = true;
          continue;
        }
        if (action === 'RECALL_PREVIOUS') {
          if (!conversationId) throw new Error('PREVIOUS_BUYER_MESSAGE_NOT_FOUND');
          await this.port.recallPreviousBuyerMessage({ ...scope, conversationId });
          previousOperationPlansReply = false;
          continue;
        }
        throw new Error(`EXECUTOR_UNSUPPORTED:message:${type ?? 'UNKNOWN'}`);
      }
      if (outOfOrderTransport) {
        if (transportTexts.length < 2) throw new Error('EXECUTOR_OUT_OF_ORDER_REQUIRES_TWO_TEXTS');
        if (!this.port.sendOutOfOrderTexts) throw new Error('EXECUTOR_UNSUPPORTED:outOfOrderTransport');
        const sent = await this.port.sendOutOfOrderTexts({
          ...scope, conversationId, texts: transportTexts,
        });
        conversationId = sent.conversationId;
      }
      if (!conversationId) throw new Error('CONVERSATION_NOT_CREATED');
      if (contextSetup.humanActive === true && !humanPrepared) {
        if (!this.port.setHumanActive) throw new Error('EXECUTOR_UNSUPPORTED:humanActive');
        await this.port.setHumanActive({ ...scope, conversationId });
      }
      if (restartDuring === 'GENERATING') {
        if (!this.port.resumeAfterRestart) throw new Error('EXECUTOR_UNSUPPORTED:restartDuring');
        await this.port.resumeAfterRestart({ ...scope, conversationId, phase: restartDuring });
      }
      let invalidatedReplyJobId: string | undefined;
      if (mutationDuringGeneration) {
        const barrier = await this.port.waitForGenerationBarrier!({ ...scope, conversationId });
        invalidatedReplyJobId = barrier?.replyJobId;
        try {
          if (Object.keys(inventoryChange).length) {
            if (!this.port.changeSkuInventory) throw new Error('EXECUTOR_UNSUPPORTED:changeInventoryDuringGeneration');
            await this.port.changeSkuInventory({
              ...scope,
              conversationId,
              skuExternalId: required(stringField(inventoryChange, 'sku'), 'SKU_EXTERNAL_ID_REQUIRED'),
              inventory: requiredInteger(inventoryChange.to, 'SKU_INVENTORY_REQUIRED'),
            });
          }
          if (Object.keys(orderChange).length) {
            if (!this.port.changeOrderStatus) throw new Error('EXECUTOR_UNSUPPORTED:changeOrderDuringGeneration');
            const orderKey = required(stringField(orderChange, 'orderKey'), 'ORDER_KEY_REQUIRED');
            await this.port.changeOrderStatus({
              ...scope,
              conversationId,
              orderId: required(fixture.orders[orderKey], `ORDER_FIXTURE_NOT_FOUND:${orderKey}`),
              status: required(stringField(orderChange, 'to'), 'ORDER_STATUS_REQUIRED'),
            });
          }
          if (Object.keys(logisticsChange).length) {
            const orderKey = required(stringField(logisticsChange, 'orderKey'), 'ORDER_KEY_REQUIRED');
            if (!this.port.changeLogistics) throw new Error('EXECUTOR_UNSUPPORTED:changeLogisticsDuringGeneration');
            await this.port.changeLogistics({
              ...scope,
              conversationId,
              orderId: required(fixture.orders[orderKey], `ORDER_FIXTURE_NOT_FOUND:${orderKey}`),
              toNode: required(stringField(logisticsChange, 'toNode'), 'LOGISTICS_NODE_REQUIRED'),
            });
          }
        } finally {
          await this.port.releaseGenerationBarrier!({ ...scope, conversationId });
          generationBarrierPrepared = false;
        }
      }
      const projectionInput = {
        workspaceId: fixture.workspaceId,
        tenantId: fixture.tenantId,
        shopId,
        conversationId,
        afterReplyJobId: invalidatedReplyJobId ?? previousTurnReplyJobId,
        ...(invalidatedReplyJobId ? { invalidatedReplyJobId } : {}),
      };
      let projection: ProductionReplyEvalProjection;
      if (restartDuring === 'SEND_OUTBOX_SENDING') {
        if (!this.port.waitForPreTransportSend || !this.port.resumeAfterRestart) {
          throw new Error('EXECUTOR_UNSUPPORTED:restartDuring');
        }
        projection = await this.port.waitForPreTransportSend(projectionInput);
        await this.port.resumeAfterRestart({ ...scope, conversationId, phase: restartDuring, projection });
        projection = await this.port.waitForProjection(projectionInput);
      } else {
        projection = await this.port.waitForProjection(projectionInput);
      }
      if (contextSetup.changeContextBeforeApproval === true) {
        if (!this.port.staleWorkflowBeforeApproval) throw new Error('EXECUTOR_UNSUPPORTED:changeContextBeforeApproval');
        await this.port.staleWorkflowBeforeApproval({ ...scope, conversationId });
        projection = await this.port.waitForProjection(projectionInput);
      }
      const humanEditType = stringField(contextSetup, 'humanEditType');
      if (humanEditType) {
        if (!this.port.applyHumanEdit) throw new Error('EXECUTOR_UNSUPPORTED:humanEditType');
        await this.port.applyHumanEdit({ ...scope, conversationId, editType: humanEditType, projection });
        projection = await this.port.waitForProjection(projectionInput);
      }
      if (contextSetup.advanceTimeMinutes !== undefined) {
        if (!this.port.advanceDraftTime) throw new Error('EXECUTOR_UNSUPPORTED:advanceTimeMinutes');
        await this.port.advanceDraftTime({
          ...scope,
          conversationId,
          minutes: requiredPositiveNumber(contextSetup.advanceTimeMinutes, 'ADVANCE_TIME_REQUIRED'),
        });
        projection = await this.port.waitForProjection(projectionInput);
      }
      return projectProductionReplyExecution(projection);
    } finally {
      if (generationBarrierPrepared) {
        await this.port.releaseGenerationBarrier?.(generationBarrierInput!);
      }
      await this.port.deleteIsolatedWorkspace(fixture.workspaceId);
    }
  }
}

export class PrismaProductionReplyEvalPort implements ProductionReplyEvalPort {
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly messages: MessageApplication,
    private readonly prisma: PrismaService,
    options: { timeoutMs?: number; pollMs?: number } = {},
    private readonly attachments?: AttachmentService,
    private readonly knowledge?: KnowledgeService,
    private readonly invalidation?: ContextInvalidationService,
    private readonly controls?: ConversationReplyControlService,
    private readonly drafts?: ReplyDraftService,
    private readonly evalFaults?: AiEvalFaultRegistry,
    private readonly workflowProposals?: WorkflowProposalService,
    private readonly recovery?: ReplyRecoveryService,
    private readonly sendOutboxes?: SendOutboxService,
  ) {
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.pollMs = options.pollMs ?? 200;
  }

  async createIsolatedWorkspace(): Promise<ProductionReplyEvalFixture> {
    const created = await this.workspaces.create('SEEDED');
    const scope = { workspaceId: created.workspace.id, tenantId: created.tenant.id };
    const [shops, buyers, products, orders] = await Promise.all([
      this.prisma.shop.findMany({ where: scope, select: { id: true, seedKey: true } }),
      this.prisma.buyer.findMany({ where: scope, select: { id: true, seedKey: true } }),
      this.prisma.product.findMany({ where: scope, select: { id: true, seedKey: true } }),
      this.prisma.order.findMany({ where: scope, select: { id: true, seedKey: true } }),
    ]);
    return {
      ...scope,
      shops: indexSeeds(shops),
      buyers: indexSeeds(buyers),
      products: indexSeeds(products),
      orders: indexSeeds(orders),
    };
  }

  async deleteIsolatedWorkspace(workspaceId: string): Promise<void> {
    this.evalFaults?.clear(workspaceId);
    await this.prisma.workspace.deleteMany({ where: { id: workspaceId } });
  }

  async setShopAiMode(input: EvalMessageInput & { mode: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY' }): Promise<void> {
    await this.workspaces.setShopAiMode(evalScope(input), input.shopId, input.mode);
  }

  async configureProviderScenario(input: EvalMessageInput & { primaryProvider: string; fallback: string }): Promise<void> {
    if (!this.evalFaults) throw new Error('EXECUTOR_PROVIDER_FAULTS_UNAVAILABLE');
    if (input.primaryProvider !== 'TIMEOUT') throw new Error(`EXECUTOR_PROVIDER_SCENARIO_UNSUPPORTED:${input.primaryProvider}`);
    if (input.fallback === 'SUCCESS') this.evalFaults.configure(input.workspaceId, 'PRIMARY_TIMEOUT_FALLBACK_SUCCESS');
    else if (input.fallback === 'TIMEOUT' || input.fallback === 'UNAVAILABLE') this.evalFaults.configure(input.workspaceId, 'TOTAL_TIMEOUT');
    else throw new Error(`EXECUTOR_PROVIDER_SCENARIO_UNSUPPORTED:${input.fallback}`);
  }

  async prepareGenerationBarrier(input: EvalMessageInput): Promise<void> {
    if (!this.evalFaults) throw new Error('EXECUTOR_GENERATION_BARRIER_UNAVAILABLE');
    this.evalFaults.prepareGenerationBarrier(input.workspaceId);
  }

  async waitForGenerationBarrier(input: EvalMessageInput & { conversationId: string }): Promise<{ replyJobId: string }> {
    if (!this.evalFaults) throw new Error('EXECUTOR_GENERATION_BARRIER_UNAVAILABLE');
    await withTimeout(
      this.evalFaults.waitForGenerationBarrier(input.workspaceId),
      this.timeoutMs,
      'EXECUTOR_GENERATION_BARRIER_TIMEOUT',
    );
    const replyJob = await this.prisma.replyJob.findFirst({
      where: {
        ...evalScope(input),
        shopId: input.shopId,
        conversationId: input.conversationId,
        status: 'GENERATING',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!replyJob) throw new Error('EXECUTOR_GENERATION_BARRIER_JOB_NOT_FOUND');
    return { replyJobId: replyJob.id };
  }

  async releaseGenerationBarrier(input: EvalMessageInput): Promise<void> {
    this.evalFaults?.releaseGenerationBarrier(input.workspaceId);
  }

  async prepareRestart(input: EvalMessageInput & { phase: string }): Promise<void> {
    if (input.phase === 'GENERATING') {
      if (!this.evalFaults) throw new Error('EXECUTOR_PROVIDER_FAULTS_UNAVAILABLE');
      this.evalFaults.configure(input.workspaceId, 'CRASH_ONCE');
      return;
    }
    if (input.phase === 'SEND_OUTBOX_SENDING') {
      if (!this.evalFaults) throw new Error('EXECUTOR_PROVIDER_FAULTS_UNAVAILABLE');
      this.evalFaults.configure(input.workspaceId, 'CRASH_BEFORE_TRANSPORT_ONCE');
      return;
    }
    throw new Error(`EXECUTOR_RESTART_PHASE_UNSUPPORTED:${input.phase}`);
  }

  async prepareWorkflowApproval(input: EvalMessageInput): Promise<void> {
    const scope = evalScope(input);
    await this.prisma.$transaction(async (tx) => {
      const workflow = await tx.workflow.findFirst({
        where: { ...scope, seedKey: 'wf_after_sales_template' },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      const version = workflow?.versions[0];
      if (!workflow || !version) throw new Error('EXECUTOR_AFTER_SALES_WORKFLOW_FIXTURE_MISSING');
      await tx.workflowVersion.updateMany({
        where: { id: version.id, workflowId: workflow.id, ...scope },
        data: { immutable: true, publishedAt: new Date() },
      });
      await tx.workflow.updateMany({
        where: { id: workflow.id, ...scope },
        data: { status: 'PUBLISHED', activeVersionId: version.id },
      });
    });
  }

  async sendText(input: EvalMessageInput & { text: string }): Promise<{ conversationId: string }> {
    const scope = evalScope(input);
    await this.messages.sendMessage(scope, {
      shopId: input.shopId, buyerId: input.buyerId, kind: 'TEXT', text: input.text,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });
    return { conversationId: await this.resolveConversationId(input) };
  }

  async prepareHumanActive(input: EvalMessageInput): Promise<{ conversationId: string }> {
    if (!this.controls) throw new Error('EXECUTOR_REPLY_CONTROL_UNAVAILABLE');
    const conversation = await this.prisma.conversation.create({
      data: {
        ...evalScope(input),
        shopId: input.shopId,
        buyerId: input.buyerId,
        externalConversationId: `eval-human-${randomUUID()}`,
        idleExpiresAt: new Date(Date.now() + 30 * 60_000),
      },
      select: { id: true },
    });
    await this.controls.takeover({ ...evalScope(input), shopId: input.shopId }, conversation.id);
    return { conversationId: conversation.id };
  }

  async sendDuplicateText(input: EvalMessageInput & { text: string }): Promise<{ conversationId: string }> {
    const externalMessageId = `eval-duplicate-${randomUUID()}`;
    const command = {
      shopId: input.shopId, buyerId: input.buyerId, kind: 'TEXT' as const, text: input.text,
      duplicateExternalMessageId: externalMessageId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    };
    await this.messages.sendMessage(evalScope(input), command);
    const conversationId = await this.resolveConversationId(input);
    await this.messages.sendMessage(evalScope(input), { ...command, conversationId });
    return { conversationId };
  }

  async sendOutOfOrderTexts(input: EvalMessageInput & { texts: string[] }): Promise<{ conversationId: string }> {
    const conversationId = required(input.conversationId, 'OUT_OF_ORDER_CONVERSATION_REQUIRED');
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, ...evalScope(input), shopId: input.shopId, buyerId: input.buyerId },
      select: { lastCommittedSequence: true },
    });
    if (!conversation) throw new Error('OUT_OF_ORDER_CONVERSATION_NOT_FOUND');
    const base = conversation.lastCommittedSequence;
    for (let index = input.texts.length - 1; index >= 0; index -= 1) {
      await this.messages.sendMessage(evalScope(input), {
        shopId: input.shopId, buyerId: input.buyerId, conversationId, kind: 'TEXT',
        text: input.texts[index]!, forcedSequence: base + index + 1,
      });
    }
    return { conversationId };
  }

  async setHumanActive(input: EvalMessageInput & { conversationId: string }): Promise<void> {
    if (!this.controls) throw new Error('EXECUTOR_REPLY_CONTROL_UNAVAILABLE');
    await this.controls.takeover({ ...evalScope(input), shopId: input.shopId }, input.conversationId);
  }

  async changeLogistics(input: EvalMessageInput & { conversationId: string; orderId: string; toNode: string }): Promise<void> {
    if (!this.invalidation) throw new Error('EXECUTOR_INVALIDATION_SERVICE_UNAVAILABLE');
    const order = await this.prisma.order.findFirst({
      where: { id: input.orderId, ...evalScope(input), shopId: input.shopId, buyerId: input.buyerId },
      select: { status: true, logisticsSnapshotJson: true },
    });
    if (!order) throw new Error(`ORDER_FIXTURE_NOT_FOUND:${input.orderId}`);
    const prior = record(order.logisticsSnapshotJson);
    await this.prisma.order.updateMany({
      where: { id: input.orderId, ...evalScope(input), shopId: input.shopId, buyerId: input.buyerId },
      data: { logisticsSnapshotJson: { ...prior, currentNode: input.toNode } },
    });
    const invalidated = await this.invalidation.updateOrderStatus(
      { ...evalScope(input), shopId: input.shopId }, input.orderId, order.status,
    );
    if (!invalidated.updated) throw new Error(`LOGISTICS_MUTATION_FAILED:${input.orderId}`);
  }

  async sendProductCard(input: EvalMessageInput & { productId: string }): Promise<{ conversationId: string }> {
    const scope = evalScope(input);
    await this.messages.sendProductCard(scope, {
      shopId: input.shopId, buyerId: input.buyerId, productId: input.productId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });
    return { conversationId: await this.resolveConversationId(input) };
  }

  async sendOrderCard(input: EvalMessageInput & { orderId: string }): Promise<{ conversationId: string }> {
    const scope = evalScope(input);
    await this.messages.sendOrderCard(scope, {
      shopId: input.shopId, buyerId: input.buyerId, orderId: input.orderId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });
    return { conversationId: await this.resolveConversationId(input) };
  }

  async sendImageFixture(input: EvalMessageInput & { fixture: string }): Promise<{ conversationId: string }> {
    if (!this.attachments) throw new Error('EXECUTOR_IMAGE_SERVICE_UNAVAILABLE');
    const marker = imageFixtureMarker(input.fixture);
    const uploaded = await this.attachments.upload(evalScope(input), {
      shopId: input.shopId,
      buyerId: input.buyerId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      file: {
        buffer: fixturePng(marker),
        mimetype: 'image/png',
        originalname: input.fixture,
      },
    });
    await this.messages.sendMessage(evalScope(input), {
      shopId: input.shopId,
      buyerId: input.buyerId,
      kind: 'IMAGE',
      attachmentId: uploaded.id,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });
    return { conversationId: await this.resolveConversationId(input) };
  }

  async editPreviousBuyerMessage(input: EvalMessageInput & { conversationId: string; text: string }): Promise<void> {
    const messageId = await this.previousBuyerMessageId(input);
    await this.messages.editMessage(evalScope(input), messageId, input.text);
  }

  async recallPreviousBuyerMessage(input: EvalMessageInput & { conversationId: string }): Promise<void> {
    const messageId = await this.previousBuyerMessageId(input);
    await this.messages.recallMessage(evalScope(input), messageId);
  }

  async activateConflict(input: EvalMessageInput & { fixture: string }): Promise<void> {
    if (!this.knowledge) throw new Error('EXECUTOR_KNOWLEDGE_SERVICE_UNAVAILABLE');
    if (input.fixture !== 'conflict_001') throw new Error(`EXECUTOR_CONFLICT_FIXTURE_UNSUPPORTED:${input.fixture}`);
    const scope = evalScope(input);
    await this.knowledge.create(scope, {
      shopId: input.shopId,
      scope: 'STORE',
      question: '普通商品多久发货？',
      answer: '普通现货商品通常24小时内发出。',
    });
    await this.knowledge.create(scope, {
      shopId: input.shopId,
      scope: 'STORE',
      question: '普通商品多久发货？',
      answer: '普通商品通常48小时内发出。',
    });
  }

  async changeSkuInventory(input: EvalMessageInput & { skuExternalId: string; inventory: number }): Promise<void> {
    if (!this.invalidation) throw new Error('EXECUTOR_INVALIDATION_SERVICE_UNAVAILABLE');
    const sku = await this.prisma.productSku.findFirst({
      where: { ...evalScope(input), shopId: input.shopId, externalSkuId: input.skuExternalId },
      select: { id: true, productId: true },
    });
    if (!sku) throw new Error(`SKU_FIXTURE_NOT_FOUND:${input.skuExternalId}`);
    const result = await this.invalidation.updateSkuInventory(
      { ...evalScope(input), shopId: input.shopId }, sku.productId, sku.id, input.inventory,
    );
    if (!result.updated) throw new Error(`SKU_MUTATION_FAILED:${input.skuExternalId}`);
  }

  async changeOrderStatus(input: EvalMessageInput & { orderId: string; status: string }): Promise<void> {
    if (!this.invalidation) throw new Error('EXECUTOR_INVALIDATION_SERVICE_UNAVAILABLE');
    const result = await this.invalidation.updateOrderStatus(
      { ...evalScope(input), shopId: input.shopId }, input.orderId, input.status,
    );
    if (!result.updated) throw new Error(`ORDER_MUTATION_FAILED:${input.orderId}`);
  }

  async applyHumanEdit(input: EvalMessageInput & { conversationId: string; editType: string; projection: ProductionReplyEvalProjection }): Promise<void> {
    if (!this.controls) throw new Error('EXECUTOR_REPLY_CONTROL_UNAVAILABLE');
    const draft = input.projection.replyJob.draft;
    if (!draft) throw new Error('HUMAN_EDIT_DRAFT_REQUIRED');
    let text = draft.aiDraft.trim();
    if (input.editType === 'STYLE_EDIT') {
      text = `您好，${text}`;
    } else if (input.editType === 'FACTUAL_CORRECTION') {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: input.conversationId, ...evalScope(input), shopId: input.shopId },
        select: { currentProductId: true },
      });
      const product = conversation?.currentProductId
        ? await this.prisma.product.findFirst({
            where: { id: conversation.currentProductId, ...evalScope(input), shopId: input.shopId },
            select: { description: true },
          })
        : null;
      const fulfillment = product?.description.match(/预计\s*([^。；;]+发出)/)?.[1]?.trim();
      if (!fulfillment) throw new Error('HUMAN_FACTUAL_CORRECTION_FIXTURE_UNAVAILABLE');
      text = `该商品预售${fulfillment}。`;
    } else {
      throw new Error(`EXECUTOR_HUMAN_EDIT_UNSUPPORTED:${input.editType}`);
    }
    await this.controls.saveHumanFinal(
      { ...evalScope(input), shopId: input.shopId }, input.conversationId,
      { text, sourceDraftId: draft.id, editType: input.editType as 'STYLE_EDIT' | 'FACTUAL_CORRECTION' },
    );
  }

  async advanceDraftTime(input: EvalMessageInput & { conversationId: string; minutes: number }): Promise<void> {
    if (!this.drafts) throw new Error('EXECUTOR_REPLY_DRAFT_SERVICE_UNAVAILABLE');
    await this.drafts.expireDue(
      { ...evalScope(input), shopId: input.shopId },
      new Date(Date.now() + input.minutes * 60_000),
    );
  }

  async staleWorkflowBeforeApproval(input: EvalMessageInput & { conversationId: string }): Promise<void> {
    if (!this.workflowProposals) throw new Error('EXECUTOR_WORKFLOW_PROPOSAL_UNAVAILABLE');
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const proposal = await this.prisma.workflowProposal.findFirst({
        where: { ...evalScope(input), shopId: input.shopId, conversationId: input.conversationId, status: 'WAITING_APPROVAL' },
        orderBy: { createdAt: 'desc' }, select: { id: true, contextVersion: true },
      });
      if (proposal) {
        const advanced = await this.prisma.conversation.updateMany({
          where: { id: input.conversationId, ...evalScope(input), shopId: input.shopId, contextVersion: proposal.contextVersion },
          data: { contextVersion: { increment: 1 }, needsReplan: true },
        });
        if (advanced.count !== 1) throw new Error('EXECUTOR_CONTEXT_MUTATION_CAS_LOST');
        const result = await this.workflowProposals.approve(
          { ...evalScope(input), shopId: input.shopId }, proposal.id,
          { approvedBy: 'production-eval', expectedContextVersion: proposal.contextVersion },
        );
        if (result.status !== 'STALE') throw new Error(`EXECUTOR_WORKFLOW_EXPECTED_STALE:${result.status}`);
        const run = await this.prisma.workflowRun.findFirst({
          where: { ...evalScope(input), shopId: input.shopId, conversationId: input.conversationId, status: 'STALE' },
          select: { id: true },
        });
        if (!run) throw new Error('EXECUTOR_WORKFLOW_STALE_NOT_DURABLE');
        return;
      }
      await delay(this.pollMs);
    }
    throw new Error('EXECUTOR_WORKFLOW_PROPOSAL_TIMEOUT');
  }

  async resumeAfterRestart(input: EvalMessageInput & { conversationId: string; phase: string; projection?: ProductionReplyEvalProjection }): Promise<void> {
    if (!this.recovery) throw new Error('EXECUTOR_RECOVERY_SERVICE_UNAVAILABLE');
    const scope = { ...evalScope(input), shopId: input.shopId };
    if (input.phase === 'GENERATING') {
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        const job = await this.prisma.replyJob.findFirst({
          where: { ...scope, conversationId: input.conversationId, status: 'GENERATING' },
          orderBy: { createdAt: 'desc' }, select: { id: true },
        });
        if (job) {
          const now = new Date();
          await this.prisma.replyJob.updateMany({
            where: { id: job.id, ...scope, status: 'GENERATING' },
            data: { updatedAt: new Date(now.getTime() - 4 * 60_000) },
          });
          const recovered = await this.recovery.recoverOnce(now);
          if (recovered.recoveryPending < 1) throw new Error('EXECUTOR_GENERATING_RECOVERY_NOT_CLAIMED');
          return;
        }
        await delay(this.pollMs);
      }
      throw new Error('EXECUTOR_GENERATING_STATE_TIMEOUT');
    }
    if (input.phase === 'SEND_OUTBOX_SENDING') {
      const sending = input.projection?.replyJob.sendOutbox;
      if (!sending || sending.status !== 'SENDING') {
        throw new Error('EXECUTOR_SEND_RECOVERY_BOUNDARY_UNAVAILABLE');
      }
      // The harness crashes after claim but before fenceBeforeTransport. At
      // that point no transport call is permitted, so recovery may requeue
      // the original AI outbox under its unchanged idempotency key. Creating
      // a human final here would test a different send path and conceal the
      // exactly-once boundary being exercised.
      const now = new Date();
      const aged = await this.prisma.sendOutbox.updateMany({
        where: { id: sending.id, ...scope, status: 'SENDING', transportStartedAt: null },
        data: { updatedAt: new Date(now.getTime() - 60_000) },
      });
      if (!aged.count) throw new Error('EXECUTOR_SEND_PRE_TRANSPORT_CLAIM_NOT_FOUND');
      const recovered = await this.recovery.recoverOnce(now);
      // The live worker may reclaim PENDING immediately, so use the recovery
      // transaction's affected-row count instead of racing a follow-up read.
      if (recovered.preTransport < 1) throw new Error('EXECUTOR_SEND_PRE_TRANSPORT_NOT_REQUEUED');
      return;
    }
    throw new Error(`EXECUTOR_RESTART_PHASE_UNSUPPORTED:${input.phase}`);
  }

  async waitForPreTransportSend(input: {
    workspaceId: string;
    tenantId: string;
    shopId: string;
    conversationId: string;
    afterReplyJobId?: string;
  }): Promise<ProductionReplyEvalProjection> {
    const deadline = Date.now() + this.timeoutMs;
    let latestStatus = 'NOT_CREATED';
    let latestOutboxStatus = 'NOT_CREATED';
    let latestTransportFence = 'NOT_CREATED';
    const projectionScope = {
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      shopId: input.shopId,
      conversationId: input.conversationId,
    };
    while (Date.now() < deadline) {
      const replyJob = await this.prisma.replyJob.findFirst({
        where: {
          ...projectionScope,
          ...(input.afterReplyJobId ? { id: { not: input.afterReplyJobId } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        include: {
          draft: true,
          sendOutbox: true,
          conversation: { select: { humanActive: true } },
        },
      });
      latestStatus = replyJob?.status ?? latestStatus;
      latestOutboxStatus = replyJob?.sendOutbox?.status ?? latestOutboxStatus;
      latestTransportFence = replyJob?.sendOutbox
        ? replyJob.sendOutbox.transportStartedAt === null ? 'PRE_TRANSPORT' : 'STARTED'
        : latestTransportFence;
      if (replyJob?.sendOutbox?.status === 'SENDING' && replyJob.sendOutbox.transportStartedAt === null) {
        return {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          replyJob: {
            id: replyJob.id,
            userTurnId: replyJob.userTurnId,
            status: replyJob.status,
            mode: replyJob.mode,
            conversationHumanActive: replyJob.conversation?.humanActive ?? false,
            draft: replyJob.draft ? {
              id: replyJob.draft.id,
              aiDraft: replyJob.draft.aiDraft,
              status: replyJob.draft.status,
            } : null,
            sendOutbox: {
              id: replyJob.sendOutbox.id,
              status: replyJob.sendOutbox.status,
              payloadJson: replyJob.sendOutbox.payloadJson,
              receiptJson: replyJob.sendOutbox.receiptJson,
            },
          },
          tasks: [],
          evidences: [],
          traceEvents: [],
          invocations: [],
          assistantMessages: [],
        };
      }
      await delay(this.pollMs);
    }
    throw new Error(
      `EXECUTOR_SEND_PRE_TRANSPORT_BOUNDARY_TIMEOUT:${latestStatus}:${latestOutboxStatus}:${latestTransportFence}`,
    );
  }

  async waitForProjection(input: {
    workspaceId: string;
    tenantId: string;
    shopId: string;
    conversationId: string;
    afterReplyJobId?: string;
    invalidatedReplyJobId?: string;
  }): Promise<ProductionReplyEvalProjection> {
    const deadline = Date.now() + this.timeoutMs;
    let latestStatus = 'NOT_CREATED';
    const projectionScope = {
      workspaceId: input.workspaceId,
      tenantId: input.tenantId,
      shopId: input.shopId,
      conversationId: input.conversationId,
    };
    while (Date.now() < deadline) {
      const replyJob = await this.prisma.replyJob.findFirst({
        where: {
          ...projectionScope,
          ...(input.afterReplyJobId ? { id: { not: input.afterReplyJobId } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        include: {
          draft: true,
          sendOutbox: true,
          evidences: true,
          conversation: { select: { humanActive: true } },
        },
      });
      latestStatus = replyJob?.status ?? latestStatus;
      if (replyJob && durableProjectionReady(replyJob)) {
        const [tasks, traceEvents, invocations, assistantMessages] = await Promise.all([
          this.prisma.task.findMany({
            where: { ...projectionScope, userTurnId: replyJob.userTurnId },
            orderBy: { createdAt: 'asc' },
            select: { id: true, intent: true, status: true, resultJson: true, requiredToolsJson: true },
          }),
          this.prisma.traceEvent.findMany({
            where: { ...projectionScope, replyJobId: replyJob.id },
            orderBy: { createdAt: 'asc' },
            select: { id: true, stage: true, payloadJson: true },
          }),
          this.prisma.aIInvocation.findMany({
            // ReplyRuntime AI calls are scoped to workspace/tenant/shop, but do
            // not persist conversationId on AIInvocation.  Every eval case is
            // isolated in its own Workspace, so the durable job timestamp plus
            // the persisted scope is the precise observable boundary here.
            where: {
              workspaceId: input.workspaceId,
              tenantId: input.tenantId,
              shopId: input.shopId,
              createdAt: { gte: replyJob.createdAt },
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true, provider: true, model: true, inputTokens: true, outputTokens: true, durationMs: true },
          }),
          this.prisma.message.findMany({
            where: { ...projectionScope, role: { in: ['ASSISTANT', 'HUMAN'] }, createdAt: { gte: replyJob.createdAt } },
            orderBy: { sequence: 'asc' },
            select: { id: true, externalMessageId: true, contentJson: true },
          }),
        ]);
        const receiptExternalMessageId = stringField(record(replyJob.sendOutbox?.receiptJson), 'externalMessageId');
        if (
          replyJob.sendOutbox?.status === 'SENT'
          && (!receiptExternalMessageId || !assistantMessages.some((message) => message.externalMessageId === receiptExternalMessageId))
        ) {
          // A provider receipt and its buyer-visible Message projection are
          // separate durable commits. AUTO evaluation must observe both.
          await delay(this.pollMs);
          continue;
        }
        const [knowledgeItems, evidenceProducts] = await Promise.all([
          this.prisma.knowledgeItem.findMany({
            where: {
              workspaceId: input.workspaceId,
              tenantId: input.tenantId,
              shopId: input.shopId,
              id: { in: replyJob.evidences.map((entry) => entry.knowledgeItemId) },
            },
            select: { id: true, seedKey: true },
          }),
          this.prisma.product.findMany({
            where: {
              workspaceId: input.workspaceId,
              tenantId: input.tenantId,
              shopId: input.shopId,
              id: { in: replyJob.evidences.flatMap((entry) => entry.productId ? [entry.productId] : []) },
            },
            select: { id: true, seedKey: true },
          }),
        ]);
        const knowledgeKeys = new Map(knowledgeItems.map((entry) => [entry.id, entry.seedKey]));
        const productKeys = new Map(evidenceProducts.map((entry) => [entry.id, entry.seedKey]));
        const invalidatedReplyJobs = input.invalidatedReplyJobId
          ? await this.prisma.replyJob.findMany({
              where: { ...projectionScope, id: input.invalidatedReplyJobId },
              select: {
                id: true,
                sendOutbox: { select: { status: true, receiptJson: true } },
              },
            })
          : [];
        const oldReplySent = invalidatedReplyJobs.some((entry) => entry.sendOutbox?.status === 'SENT'
          && Boolean(stringField(record(entry.sendOutbox.receiptJson), 'externalMessageId')));
        return {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          oldReplySent,
          replyJob: {
            id: replyJob.id,
            userTurnId: replyJob.userTurnId,
            status: replyJob.status,
            mode: replyJob.mode,
            conversationHumanActive: replyJob.conversation?.humanActive ?? false,
            draft: replyJob.draft ? {
              id: replyJob.draft.id,
              aiDraft: replyJob.draft.aiDraft,
              status: replyJob.draft.status,
            } : null,
            sendOutbox: replyJob.sendOutbox ? {
              id: replyJob.sendOutbox.id,
              status: replyJob.sendOutbox.status,
              payloadJson: replyJob.sendOutbox.payloadJson,
              receiptJson: replyJob.sendOutbox.receiptJson,
            } : null,
          },
          tasks,
          evidences: replyJob.evidences.map((entry) => ({
            id: entry.id,
            knowledgeItemId: entry.knowledgeItemId,
            knowledgeVersionId: entry.knowledgeVersionId,
            sourceType: entry.sourceType,
            scope: entry.scope,
            productId: entry.productId,
            retrievalScore: entry.retrievalScore,
            retrievedContentSnapshotJson: entry.retrievedContentSnapshotJson,
            knowledgeKey: knowledgeKeys.get(entry.knowledgeItemId),
            productKey: entry.productId ? productKeys.get(entry.productId) ?? null : null,
          })),
          traceEvents,
          invocations,
          assistantMessages,
        };
      }
      await delay(this.pollMs);
    }
    throw new Error(`PRODUCTION_REPLY_TIMEOUT:${latestStatus}`);
  }

  private async resolveConversationId(input: EvalMessageInput): Promise<string> {
    if (input.conversationId) return input.conversationId;
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        tenantId: input.tenantId,
        shopId: input.shopId,
        buyerId: input.buyerId,
        state: 'ACTIVE',
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (!conversation) throw new Error('CONVERSATION_NOT_CREATED');
    return conversation.id;
  }

  private async previousBuyerMessageId(input: EvalMessageInput & { conversationId: string }): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const message = await this.prisma.message.findFirst({
        where: {
          workspaceId: input.workspaceId,
          tenantId: input.tenantId,
          shopId: input.shopId,
          conversationId: input.conversationId,
          role: 'BUYER',
          status: { notIn: ['RECALLED', 'DELETED'] },
        },
        orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }],
        select: { id: true },
      });
      if (message) return message.id;
      await delay(this.pollMs);
    }
    throw new Error('PREVIOUS_BUYER_MESSAGE_NOT_FOUND');
  }
}

/**
 * Converts a single durable reply projection into the generic quality report
 * shape.  No answer is synthesized here: every field must be recoverable from
 * a committed Task, Evidence snapshot, Draft, SendOutbox, Message, or Trace.
 */
export function projectProductionReplyExecution(
  projection: ProductionReplyEvalProjection,
): ReplyEvalExecution {
  const policy = [...projection.traceEvents]
    .reverse()
    .find((event) => event.stage === 'REPLY_POLICY');
  const policyMode = stringField(record(policy?.payloadJson), 'mode');
  const invocationIds = unique([
    ...projection.traceEvents.flatMap((event) => collectInvocationIds(event.payloadJson)),
    ...projection.invocations.map((invocation) => invocation.id),
  ]);
  const linkedInvocations = projection.invocations.filter((invocation) => invocationIds.includes(invocation.id));
  const send = projection.replyJob.sendOutbox;
  const receiptExternalMessageId = stringField(record(send?.receiptJson), 'externalMessageId');
  const sentMessage = send?.status === 'SENT' && receiptExternalMessageId
    ? projection.assistantMessages.find((message) => message.externalMessageId === receiptExternalMessageId)
    : undefined;
  const sentText = textFromJson(sentMessage?.contentJson);
  const outboxText = textFromJson(send?.payloadJson);
  const draftText = projection.replyJob.draft?.aiDraft.trim() ?? '';
  const taskText = projection.tasks.map((task) => textFromJson(task.resultJson)).find(Boolean) ?? '';
  const output = sentText
    ? { text: sentText, source: 'SENT_MESSAGE' as const, status: send?.status ?? projection.replyJob.status }
    : outboxText
      ? { text: outboxText, source: 'SEND_OUTBOX' as const, status: send?.status ?? projection.replyJob.status }
      : draftText
        ? { text: draftText, source: 'DRAFT' as const, status: projection.replyJob.status }
        : taskText
          ? { text: taskText, source: 'TASK_RESULT' as const, status: projection.replyJob.status }
          : { text: '', source: 'NONE' as const, status: projection.replyJob.status };

  return {
    text: output.text,
    tasks: unique(projection.tasks.map((task) => task.intent)),
    mode: policyMode ?? projectedMode(projection.replyJob),
    evidence: unique(projection.evidences.map((entry) => textFromJson(entry.retrievedContentSnapshotJson)).filter(Boolean)),
    evidenceDetails: projection.evidences.map((entry) => ({
      scope: entry.scope,
      productId: entry.productId,
      sourceType: entry.sourceType,
      text: textFromJson(entry.retrievedContentSnapshotJson),
      retrievalScore: entry.retrievalScore,
      ...(entry.knowledgeKey ? { knowledgeKey: entry.knowledgeKey } : {}),
      ...(entry.productKey !== undefined ? { productKey: entry.productKey } : {}),
    })),
    tools: unique(projection.tasks.flatMap((task) => stringArray(task.requiredToolsJson))),
    taskDetails: projection.tasks.map((task) => ({ intent: task.intent, status: task.status, result: task.resultJson })),
    provider: uniformValue(linkedInvocations.map((invocation) => invocation.provider)),
    model: uniformValue(linkedInvocations.map((invocation) => invocation.model)),
    inputTokens: sum(linkedInvocations.map((invocation) => invocation.inputTokens)),
    outputTokens: sum(linkedInvocations.map((invocation) => invocation.outputTokens)),
    latencyMs: sum(linkedInvocations.map((invocation) => invocation.durationMs ?? 0)),
    cost: null,
    outputSource: output.source,
    terminalStatus: output.status,
    ...(projection.oldReplySent === undefined ? {} : { oldReplySent: projection.oldReplySent }),
    trace: {
      workspaceId: projection.workspaceId,
      conversationId: projection.conversationId,
      replyJobId: projection.replyJob.id,
      userTurnId: projection.replyJob.userTurnId,
      taskIds: projection.tasks.map((task) => task.id),
      evidenceIds: projection.evidences.map((entry) => entry.id),
      knowledgeVersionIds: unique(projection.evidences.map((entry) => entry.knowledgeVersionId)),
      ...(projection.replyJob.draft ? { draftId: projection.replyJob.draft.id } : {}),
      ...(send ? { sendOutboxId: send.id } : {}),
      ...(sentMessage ? { sentMessageId: sentMessage.id } : {}),
      invocationIds,
    },
  };
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringField(value: JsonRecord, key: string): string | undefined {
  return typeof value[key] === 'string' && value[key] ? value[key] : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function textFromJson(value: unknown): string {
  const source = record(value);
  for (const key of ['text', 'answer', 'reply']) {
    const text = stringField(source, key)?.trim();
    if (text) return text;
  }
  const snapshot = record(source.contentSnapshot);
  return stringField(snapshot, 'answer')?.trim() ?? '';
}

function collectInvocationIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectInvocationIds);
  const source = record(value);
  const direct = stringField(source, 'invocationId');
  return unique([
    ...(direct ? [direct] : []),
    ...Object.values(source).flatMap(collectInvocationIds),
  ]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function uniformValue(values: readonly string[]): string | undefined {
  const distinct = unique(values);
  if (!distinct.length) return undefined;
  return distinct.length === 1 ? distinct[0] : distinct.join('+');
}

function projectedMode(replyJob: ProductionReplyEvalProjection['replyJob']): string {
  if (replyJob.conversationHumanActive) return 'MANUAL';
  if (replyJob.draft && !['MANUAL', 'HOLD'].includes(replyJob.mode)) return 'ASSIST';
  return replyJob.mode === 'HOLD' ? 'MANUAL' : replyJob.mode;
}

function required<T>(value: T | undefined | null | '', code: string): T {
  if (value === undefined || value === null || value === '') throw new Error(code);
  return value;
}

function requiredInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(code);
  return Number(value);
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function requiredPositiveNumber(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(code);
  return value;
}

function indexSeeds(rows: Array<{ id: string; seedKey: string }>): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.seedKey, row.id]));
}

function evalScope(input: EvalMessageInput): { workspaceId: string; tenantId: string } {
  return { workspaceId: input.workspaceId, tenantId: input.tenantId };
}

function durableProjectionReady(replyJob: {
  status: string;
  draft: unknown;
  sendOutbox: { status: string } | null;
}): boolean {
  if (replyJob.status === 'WAITING_HUMAN') return true;
  if (['STALE', 'EXPIRED', 'CANCELLED', 'FAILED', 'SENT'].includes(replyJob.status)) return true;
  if (replyJob.status === 'FAST_PATH_READY') {
    return Boolean(replyJob.sendOutbox && ['SENT', 'FAILED', 'UNCERTAIN', 'CANCELLED'].includes(replyJob.sendOutbox.status));
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(code)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function imageFixtureMarker(fixture: string): string {
  if (['damaged_sleeve.png', 'product-damage.png'].includes(fixture)) return 'AICS_FIXTURE:DAMAGED_SLEEVE';
  if (['shipping_label.png', 'shipping-label.png'].includes(fixture)) return 'AICS_FIXTURE:SHIPPING_LABEL';
  throw new Error(`EXECUTOR_UNSUPPORTED:imageFixture:${fixture}`);
}

function fixturePng(marker: string): Buffer {
  return Buffer.concat([ONE_PIXEL_PNG, Buffer.from(marker, 'utf8')]);
}
