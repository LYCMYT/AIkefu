import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { sanitizeContext, validateWorkflowGraph, type WorkflowDefinition, type WorkflowNodeType } from '@ai-customer-service/core';
import { PrismaService } from '../database/prisma.service';
import { AiRuntimeApplicationService } from '../ai/ai-runtime-application.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { normalizeWorkflowGraph } from './workflow-graph';
import { TraceService } from '../trace/trace.service';
import { toWorkflowRunDto } from './workflow.dto';
import { WorkflowRealtimePublisher } from './workflow-realtime.publisher';

type Scope = WorkspaceScope & { shopId: string };
type Node = { id: string; type: WorkflowNodeType; config?: Record<string, unknown> };
type Edge = { source: string; target: string; id?: string; condition?: string };
type Graph = WorkflowDefinition & { nodes: Node[]; edges: Edge[] };
type Tx = Record<string, any>;
type ConversationSnapshot = { id: string; contextVersion: number; buyerId?: string | null; currentProductId?: string | null; currentOrderId?: string | null };
type RunSnapshot = { id: string; workflowVersionId: string; conversationId: string; contextVersion: number };

/**
 * Bounded graph interpreter. Only short state-transition/read transactions are
 * used; an AI provider is always awaited after its node has been durably
 * claimed and the transaction callback has returned.
 */
@Injectable()
export class WorkflowRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly aiRuntime?: AiRuntimeApplicationService,
    @Optional() private readonly traces?: TraceService,
    @Optional() private readonly realtime?: WorkflowRealtimePublisher,
  ) {}

  async start(scope: Scope, input: { workflowId: string; conversationId: string; taskIds: string[] }) {
    const prepared = await this.prisma.$transaction(async (tx) => {
      const db = tx as Tx;
      const workflow = await db.workflow.findFirst({
        where: { id: input.workflowId, workspaceId: scope.workspaceId, tenantId: scope.tenantId, status: 'PUBLISHED' },
        select: { id: true, activeVersionId: true },
      });
      if (!workflow?.activeVersionId) throw new NotFoundException({ code: 'WORKFLOW_NOT_ACTIVE', message: 'Workflow has no active version' });
      const version = await db.workflowVersion.findFirst({
        where: { id: workflow.activeVersionId, workflowId: workflow.id, workspaceId: scope.workspaceId, tenantId: scope.tenantId, immutable: true },
      });
      if (!version) throw new ConflictException({ code: 'WORKFLOW_VERSION_IMMUTABLE_REQUIRED', message: 'Active version must be immutable' });
      const graph = normalizeWorkflowGraph(version.graphJson) as Graph | null;
      if (!graph) throw new ConflictException({ code: 'WORKFLOW_GRAPH_INVALID', message: 'Workflow graph shape is invalid' });
      const validation = validateWorkflowGraph(graph);
      if (!validation.valid) throw new ConflictException({ code: 'WORKFLOW_GRAPH_INVALID', errors: validation.errors });
      const conversation = await db.conversation.findFirst({
        where: { id: input.conversationId, ...scope },
        select: { id: true, contextVersion: true, buyerId: true, currentProductId: true, currentOrderId: true },
      }) as ConversationSnapshot | null;
      if (!conversation) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found in this Shop' });
      const createdRun = await db.workflowRun.create({
        data: { ...scope, workflowVersionId: version.id, conversationId: conversation.id, taskIdsJson: input.taskIds, contextVersion: conversation.contextVersion, status: 'RUNNING' },
      }) as Partial<RunSnapshot> & { id: string };
      // Test doubles and a narrow Prisma select may return only id/status;
      // the immutable snapshot is known from this same transaction.
      const run: RunSnapshot = { ...createdRun, workflowVersionId: version.id, conversationId: conversation.id, contextVersion: conversation.contextVersion };
      const claim = await db.task.updateMany({
        where: { ...scope, id: { in: input.taskIds }, conversationId: conversation.id, ownerWorkflowRunId: null },
        data: { ownerWorkflowRunId: run.id, status: 'RUNNING' },
      });
      if (claim.count !== input.taskIds.length) throw new ConflictException({ code: 'WORKFLOW_TASK_OWNER_CONFLICT', message: 'A task already has a workflow owner' });
      return { run, conversation, graph };
    });

    await this.publishCommittedState(scope, prepared.run.id);
    void this.recordTrace(scope, prepared.run, 'WORKFLOW_RUN_STARTED', { taskCount: input.taskIds.length, contextVersion: prepared.run.contextVersion });

    try {
      return await this.executeGraph(scope, prepared.run, prepared.conversation, prepared.graph, input.taskIds);
    } catch (error) {
      await this.failRun(scope, prepared.run.id, prepared.run.contextVersion);
      throw error;
    }
  }

  async list(scope: WorkspaceScope & { shopId?: string }, filter: { workflowId?: string; conversationId?: string; status?: string } = {}) {
    const runs = await this.prisma.workflowRun.findMany({
      where: { ...scope, ...(filter.workflowId ? { workflowVersion: { workflowId: filter.workflowId } } : {}), ...(filter.conversationId ? { conversationId: filter.conversationId } : {}), ...(filter.status ? { status: filter.status as never } : {}) },
      orderBy: { updatedAt: 'desc' },
      include: { nodeRuns: { orderBy: { createdAt: 'asc' } }, proposals: { orderBy: { createdAt: 'asc' } } },
    });
    return runs.map(toWorkflowRunDto);
  }

  async get(scope: Scope, runId: string) {
    const run = await this.prisma.workflowRun.findFirst({ where: { id: runId, ...scope }, include: { nodeRuns: { orderBy: { createdAt: 'asc' } }, proposals: { orderBy: { createdAt: 'asc' } } } });
    if (!run) throw new NotFoundException({ code: 'WORKFLOW_RUN_NOT_FOUND', message: 'Workflow run not found in this Shop' });
    return toWorkflowRunDto(run);
  }

  async scopeForConversation(scope: WorkspaceScope, conversationId: string): Promise<Scope> {
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, ...scope }, select: { shopId: true } });
    if (!conversation) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found in this Workspace' });
    return { ...scope, shopId: conversation.shopId };
  }

  async scopeForRun(scope: WorkspaceScope, runId: string): Promise<Scope> {
    const run = await this.prisma.workflowRun.findFirst({ where: { id: runId, ...scope }, select: { shopId: true } });
    if (!run) throw new NotFoundException({ code: 'WORKFLOW_RUN_NOT_FOUND', message: 'Workflow run not found in this Workspace' });
    return { ...scope, shopId: run.shopId };
  }

  /** Restart path: preserves the immutable version and continues after logged nodes. */
  async recover(scope: Scope, runId: string) {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, ...scope, status: { in: ['RUNNING', 'RECOVERING'] } },
      include: { workflowVersion: true, nodeRuns: { orderBy: { createdAt: 'asc' } }, conversation: { select: { id: true, contextVersion: true, buyerId: true, currentProductId: true, currentOrderId: true } } },
    }) as any;
    if (!run) throw new NotFoundException({ code: 'WORKFLOW_RUN_NOT_FOUND', message: 'Recoverable workflow run not found in this Shop' });
    const graph = normalizeWorkflowGraph(run.workflowVersion?.graphJson) as Graph | null;
    if (!graph || !run.workflowVersion?.immutable || !validateWorkflowGraph(graph).valid) throw new ConflictException({ code: 'WORKFLOW_GRAPH_INVALID', message: 'Workflow version is not recoverable' });
    if (!run.conversation || run.conversation.contextVersion !== run.contextVersion) {
      await this.prisma.workflowRun.updateMany({ where: { id: run.id, ...scope, status: { in: ['RUNNING', 'RECOVERING'] } }, data: { status: 'STALE', finishedAt: new Date() } });
      await this.prisma.task.updateMany({ where: { ...scope, ownerWorkflowRunId: run.id, status: 'RUNNING' }, data: { status: 'SUPERSEDED', errorCode: 'WORKFLOW_CONTEXT_STALE' } });
      await this.publishCommittedState(scope, run.id);
      return { ...run, status: 'STALE' };
    }
    await this.prisma.workflowRun.updateMany({ where: { id: run.id, ...scope, status: { in: ['RUNNING', 'RECOVERING'] } }, data: { status: 'RECOVERING' } });
    await this.publishCommittedState(scope, run.id);
    const completed = Array.isArray(run.completedNodesJson) ? run.completedNodesJson.filter((id: unknown): id is string => typeof id === 'string') : [];
    const outputs = new Map<string, Record<string, unknown>>();
    for (const entry of run.nodeRuns ?? []) if (entry.status === 'SUCCEEDED' && entry.outputJson && typeof entry.outputJson === 'object') outputs.set(entry.nodeId, entry.outputJson as Record<string, unknown>);
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const lastId = completed.at(-1) as string | undefined;
    const next = lastId ? this.nextFromStored(graph, nodes.get(lastId), outputs.get(lastId), nodes) : graph.nodes.find((node) => node.type === 'TRIGGER');
    if (!next) throw new ConflictException({ code: 'WORKFLOW_RECOVERY_INVALID', message: 'Workflow recovery cursor is invalid' });
    const taskIds = Array.isArray(run.taskIdsJson) ? run.taskIdsJson.filter((id: unknown): id is string => typeof id === 'string') : [];
    return this.executeGraph(scope, { id: run.id, workflowVersionId: run.workflowVersionId, conversationId: run.conversationId, contextVersion: run.contextVersion }, run.conversation, graph, taskIds, { current: next, completed, execution: outputs });
  }

  private async executeGraph(scope: Scope, run: RunSnapshot, initialConversation: ConversationSnapshot, graph: Graph, taskIds: string[], resume?: { current: Node; completed: string[]; execution: Map<string, Record<string, unknown>> }) {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, Edge[]>();
    for (const edge of graph.edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    const trigger = graph.nodes.find((node) => node.type === 'TRIGGER');
    if (!trigger) throw new ConflictException({ code: 'WORKFLOW_GRAPH_INVALID', message: 'Workflow needs exactly one Trigger' });

    const deadline = Date.now() + graph.settings.timeoutMs;
    const completed: string[] = [...(resume?.completed ?? [])];
    const execution = resume?.execution ?? new Map<string, Record<string, unknown>>();
    let current: Node | undefined = resume?.current ?? trigger;
    let conversation = initialConversation;
    let steps = completed.length;
    while (current) {
      if (steps >= graph.settings.maxSteps || Date.now() > deadline) {
        throw new ConflictException({ code: 'WORKFLOW_EXECUTION_LIMIT', message: 'Workflow exceeded its bounded execution budget' });
      }
      steps += 1;
      const claimed = await this.claimNode(scope, run, current, taskIds);
      if (claimed.stale) {
        await this.publishCommittedState(scope, run.id);
        return { ...run, status: 'STALE', currentNodeId: current.id, completedNodesJson: completed };
      }
      conversation = claimed.conversation!;
      await this.publishCommittedState(scope, run.id);

      if (current.type === 'HUMAN_APPROVAL') {
        const waiting = await this.waitForApproval(scope, run, current, conversation, taskIds, completed, execution);
        if (waiting.stale) return { ...run, status: 'STALE', currentNodeId: current.id, completedNodesJson: completed };
        return { ...run, status: 'WAITING_APPROVAL', currentNodeId: current.id, completedNodesJson: completed };
      }

      // QUERY nodes use their own short, scoped read transaction. AI happens
      // below it, fully outside any Prisma interactive transaction.
      const output = current.type.startsWith('QUERY_')
        ? await this.prisma.$transaction((tx) => this.executeReadNode(tx as Tx, scope, current!, conversation))
        : await this.executeNodeOutsideTransaction(scope, current, conversation, taskIds, deadline, execution);
      const finished = await this.completeNode(scope, run, current, conversation, taskIds, output, completed);
      if (finished.stale) {
        await this.publishCommittedState(scope, run.id);
        return { ...run, status: 'STALE', currentNodeId: current.id, completedNodesJson: completed };
      }
      await this.publishCommittedState(scope, run.id);
      completed.push(current.id);
      execution.set(current.id, output);
      void this.recordTrace(scope, run, 'WORKFLOW_NODE_COMPLETED', { nodeId: current.id, nodeType: current.type, completedCount: completed.length });
      if (current.type === 'END') {
        await this.completeRun(scope, run, current.id, completed, taskIds, execution);
        return { ...run, status: 'COMPLETED', currentNodeId: current.id, completedNodesJson: completed };
      }
      current = this.selectNext(current, output, outgoing.get(current.id) ?? [], nodes);
    }
    throw new ConflictException({ code: 'WORKFLOW_GRAPH_INVALID', message: 'Workflow path ended before END' });
  }

  private async claimNode(scope: Scope, run: RunSnapshot, node: Node, taskIds: string[]): Promise<{ stale: boolean; conversation?: ConversationSnapshot }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const db = tx as Tx;
      const conversation = await db.conversation.findFirst({
        where: { id: run.conversationId, ...scope },
        select: { id: true, contextVersion: true, buyerId: true, currentProductId: true, currentOrderId: true },
      }) as ConversationSnapshot | null;
      if (!conversation || conversation.contextVersion !== run.contextVersion) {
        await db.workflowRun.updateMany({ where: { id: run.id, ...scope, status: { in: ['RUNNING', 'RECOVERING'] } }, data: { status: 'STALE', finishedAt: new Date() } });
        await db.task?.updateMany?.({ where: { ...scope, ownerWorkflowRunId: run.id, status: 'RUNNING' }, data: { status: 'SUPERSEDED', errorCode: 'WORKFLOW_CONTEXT_STALE' } });
        return { stale: true };
      }
      await db.workflowNodeRun.upsert({
        where: { workflowRunId_nodeId: { workflowRunId: run.id, nodeId: node.id } },
        update: { status: 'RUNNING', startedAt: new Date(), errorCode: null },
        create: { workflowRunId: run.id, nodeId: node.id, status: 'RUNNING', inputJson: { taskIds }, startedAt: new Date() },
      });
      return { stale: false, conversation };
    });
    return result;
  }

  private async completeNode(scope: Scope, run: RunSnapshot, node: Node, conversation: ConversationSnapshot, taskIds: string[], output: Record<string, unknown>, completed: string[]): Promise<{ stale: boolean }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const db = tx as Tx;
      const live = await db.conversation.findFirst({ where: { id: run.conversationId, ...scope }, select: { contextVersion: true } });
      if (!live || live.contextVersion !== run.contextVersion) {
        await db.workflowNodeRun.updateMany?.({ where: { workflowRunId: run.id, nodeId: node.id, status: 'RUNNING' }, data: { status: 'STALE', finishedAt: new Date(), errorCode: 'WORKFLOW_CONTEXT_STALE' } });
        await db.workflowRun.updateMany({ where: { id: run.id, ...scope, status: { in: ['RUNNING', 'RECOVERING'] } }, data: { status: 'STALE', finishedAt: new Date() } });
        await db.task?.updateMany?.({ where: { ...scope, ownerWorkflowRunId: run.id, status: 'RUNNING' }, data: { status: 'SUPERSEDED', errorCode: 'WORKFLOW_CONTEXT_STALE' } });
        return { stale: true };
      }
      const finishedAt = new Date();
      await db.workflowNodeRun.upsert({
        where: { workflowRunId_nodeId: { workflowRunId: run.id, nodeId: node.id } },
        update: { status: 'SUCCEEDED', inputJson: { taskIds }, outputJson: output, finishedAt, durationMs: 0 },
        create: { workflowRunId: run.id, nodeId: node.id, status: 'SUCCEEDED', inputJson: { taskIds }, outputJson: output, startedAt: finishedAt, finishedAt, durationMs: 0 },
      });
      const advanced = await db.workflowRun.updateMany({
        where: { id: run.id, ...scope, contextVersion: conversation.contextVersion, status: { in: ['RUNNING', 'RECOVERING'] } },
        data: { status: 'RUNNING', currentNodeId: node.id, completedNodesJson: [...completed, node.id] },
      });
      return { stale: advanced.count !== 1 };
    });
    return result;
  }

  private async waitForApproval(scope: Scope, run: RunSnapshot, node: Node, conversation: ConversationSnapshot, taskIds: string[], completed: string[], execution: Map<string, Record<string, unknown>>) {
    const result = await this.prisma.$transaction(async (tx) => {
      const db = tx as Tx;
      const live = await db.conversation.findFirst({ where: { id: run.conversationId, ...scope }, select: { contextVersion: true } });
      if (!live || live.contextVersion !== run.contextVersion) {
        await db.workflowRun.updateMany({ where: { id: run.id, ...scope, status: { in: ['RUNNING', 'RECOVERING'] } }, data: { status: 'STALE', finishedAt: new Date() } });
        await db.task?.updateMany?.({ where: { ...scope, ownerWorkflowRunId: run.id, status: 'RUNNING' }, data: { status: 'SUPERSEDED', errorCode: 'WORKFLOW_CONTEXT_STALE' } });
        return { stale: true };
      }
      await db.workflowNodeRun.upsert({
        where: { workflowRunId_nodeId: { workflowRunId: run.id, nodeId: node.id } },
        update: { status: 'WAITING_APPROVAL', inputJson: { taskIds } },
        create: { workflowRunId: run.id, nodeId: node.id, status: 'WAITING_APPROVAL', inputJson: { taskIds }, startedAt: new Date() },
      });
      const proposal = await this.proposalData(db, scope, run, node, conversation, execution);
      await db.workflowProposal.create({ data: proposal });
      await db.workflowRun.updateMany({
        where: { id: run.id, ...scope, contextVersion: conversation.contextVersion, status: { in: ['RUNNING', 'RECOVERING'] } },
        data: { status: 'WAITING_APPROVAL', currentNodeId: node.id, completedNodesJson: completed },
      });
      return { stale: false };
    });
    await this.publishCommittedState(scope, run.id);
    return result;
  }

  private async completeRun(
    scope: Scope,
    run: RunSnapshot,
    currentNodeId: string,
    completed: string[],
    taskIds: string[],
    execution: Map<string, Record<string, unknown>>,
  ) {
    const resultJson = workflowTaskResult(run.id, execution);
    await this.prisma.$transaction(async (tx) => {
      const db = tx as Tx;
      const finished = await db.workflowRun.updateMany({
        where: { id: run.id, ...scope, contextVersion: run.contextVersion, status: { in: ['RUNNING', 'RECOVERING'] } },
        data: { status: 'COMPLETED', currentNodeId, completedNodesJson: completed, finishedAt: new Date() },
      });
      if (finished.count !== 1) throw new ConflictException({ code: 'WORKFLOW_RUN_COMPLETION_LOST', message: 'Workflow completion claim was lost' });
      // The Workflow-owned TaskResult and terminal Run state are one durable
      // boundary. ReplyRuntime may compose only after it observes this row.
      await db.task?.updateMany?.({
        where: { ...scope, id: { in: taskIds }, conversationId: run.conversationId, ownerWorkflowRunId: run.id, status: 'RUNNING' },
        data: { status: 'RESOLVED', resultJson, errorCode: null },
      });
    });
    await this.publishCommittedState(scope, run.id);
  }

  private async failRun(scope: Scope, runId: string, contextVersion: number) {
    await this.prisma.$transaction(async (tx) => {
      const db = tx as Tx;
      await db.workflowRun.updateMany({
        where: { id: runId, ...scope, contextVersion, status: { in: ['RUNNING', 'RECOVERING'] } },
        data: { status: 'FAILED', finishedAt: new Date() },
      });
      await db.task?.updateMany?.({
        where: { ...scope, ownerWorkflowRunId: runId, status: 'RUNNING' },
        data: { status: 'FAILED', errorCode: 'WORKFLOW_FAILED' },
      });
    }).catch(() => undefined);
    await this.publishCommittedState(scope, runId);
  }

  private async recordTrace(scope: Scope, run: RunSnapshot, stage: string, payload: Record<string, unknown>): Promise<void> {
    try { await this.traces?.record({ ...scope, conversationId: run.conversationId }, `workflow-run:${run.id}`, stage, payload); } catch { /* trace cannot change workflow outcome */ }
  }

  private async publishCommittedState(scope: Scope, workflowRunId: string): Promise<void> {
    if (!this.realtime) return;
    const repository = this.prisma as unknown as {
      workflowRun?: { findFirst(input: unknown): Promise<(Record<string, unknown> & { nodeRuns?: object[]; proposals?: object[] }) | null> };
    };
    if (!repository.workflowRun?.findFirst) return;
    try {
      const run = await repository.workflowRun.findFirst({
        where: { id: workflowRunId, ...scope },
        include: { nodeRuns: { orderBy: { createdAt: 'asc' } }, proposals: { orderBy: { createdAt: 'asc' } } },
      });
      if (!run) return;
      this.realtime.publishRun(scope, run);
      for (const node of run.nodeRuns ?? []) this.realtime.publishNode(scope, { ...scope, ...node });
      for (const proposal of run.proposals ?? []) this.realtime.publishProposal(scope, proposal);
    } catch {
      // PostgreSQL is authoritative; a realtime read/publish failure never
      // rolls back an already committed Workflow transition.
    }
  }

  private selectNext(current: Node, output: Record<string, unknown>, edges: Edge[], nodes: Map<string, Node>): Node {
    let edge: Edge | undefined;
    if (current.type === 'CONDITION') {
      const branch = typeof output.branch === 'string' ? output.branch : undefined;
      edge = edges.find((entry) => entry.condition === branch);
      if (!edge) throw new ConflictException({ code: 'WORKFLOW_CONDITION_UNRESOLVED', message: 'Condition did not select an allowed edge' });
    } else {
      if (edges.length !== 1) throw new ConflictException({ code: 'WORKFLOW_GRAPH_INVALID', message: `Node ${current.id} needs exactly one deterministic successor` });
      edge = edges[0];
    }
    const next = edge ? nodes.get(edge.target) : undefined;
    if (!next) throw new ConflictException({ code: 'WORKFLOW_GRAPH_INVALID', message: 'Workflow edge has no target node' });
    return next;
  }

  private nextFromStored(graph: Graph, current: Node | undefined, output: Record<string, unknown> | undefined, nodes: Map<string, Node>): Node | undefined {
    if (!current || current.type === 'END') return undefined;
    const edges = graph.edges.filter((edge) => edge.source === current.id);
    try { return this.selectNext(current, output ?? {}, edges, nodes); } catch { return undefined; }
  }

  private async executeNodeOutsideTransaction(scope: Scope, node: Node, conversation: ConversationSnapshot, taskIds: string[], deadline: number, execution: Map<string, Record<string, unknown>>): Promise<Record<string, unknown>> {
    switch (node.type) {
      case 'TRIGGER': return { taskIds: [...taskIds] };
      case 'CONDITION': return this.evaluateCondition(node, execution);
      case 'AI_GENERATE': return this.generateAi(scope, node, conversation, taskIds, deadline, execution);
      case 'END': return { completed: true };
      default: throw new ConflictException({ code: 'WORKFLOW_NODE_NOT_EXECUTABLE', message: `Unsupported workflow node ${node.type}` });
    }
  }

  private async executeReadNode(tx: Tx, scope: Scope, node: Node, conversation: ConversationSnapshot): Promise<Record<string, unknown>> {
    if (node.type === 'QUERY_PRODUCT') {
      const productId = typeof node.config?.productId === 'string' ? node.config.productId : conversation.currentProductId ?? undefined;
      const rows = tx.product?.findMany ? await tx.product.findMany({ where: { ...scope, ...(productId ? { id: productId } : {}) }, take: 3, select: { id: true, externalProductId: true, title: true, status: true, recommendable: true } }) : [];
      return { products: rows.map((row: Record<string, unknown>) => ({ id: row.id, externalProductId: row.externalProductId, title: row.title, status: row.status, recommendable: row.recommendable })) };
    }
    // Orders/logistics are buyer-scoped even when a node config contains an
    // orderId. A missing buyer identity is fail-closed, never a shop-wide read.
    if (!conversation.buyerId) return node.type === 'QUERY_LOGISTICS' ? { logistics: [] } : { orders: [] };
    const orderId = typeof node.config?.orderId === 'string' ? node.config.orderId : conversation.currentOrderId ?? undefined;
    const rows = tx.order?.findMany ? await tx.order.findMany({ where: { ...scope, buyerId: conversation.buyerId, ...(orderId ? { id: orderId } : {}) }, take: 3, select: { id: true, externalOrderId: true, status: true, version: true, shippedAt: true, logisticsSnapshotJson: true } }) : [];
    if (node.type === 'QUERY_LOGISTICS') return { logistics: rows.map((row: Record<string, unknown>) => ({ orderId: row.id, status: row.status, version: row.version, shippedAt: row.shippedAt, snapshot: row.logisticsSnapshotJson })) };
    return { orders: rows.map((row: Record<string, unknown>) => ({ id: row.id, externalOrderId: row.externalOrderId, status: row.status, version: row.version, shippedAt: row.shippedAt })) };
  }

  private async generateAi(scope: Scope, node: Node, conversation: ConversationSnapshot, taskIds: string[], deadline: number, execution: Map<string, Record<string, unknown>>): Promise<Record<string, unknown>> {
    const context = sanitizeContext({ workflow: { nodeId: node.id, config: node.config ?? {}, taskIds, conversationId: conversation.id, priorNodeOutputs: Object.fromEntries(execution) } }, ['workflow']).value;
    if (!this.aiRuntime) return { text: '已生成受控工作流草稿。', requiresHuman: false, deterministic: true };
    try {
      const result = await this.aiRuntime.runStructured<{ text: string; requiresHuman: boolean }>(scope, {
        purpose: 'REPLY_GENERATION', schema: 'ReplyGeneration', context, allowedDataClasses: ['workflow'], promptVersion: 'workflow-v1', ragStrategy: 'WORKFLOW_STRUCTURED', contextVersion: conversation.contextVersion, timeoutMs: Math.max(1, deadline - Date.now()),
      });
      return { text: result.output.text, requiresHuman: result.output.requiresHuman, provider: result.provider, model: result.model, fallbackUsed: result.fallbackUsed };
    } catch {
      throw new ConflictException({ code: 'WORKFLOW_AI_FAILED', message: 'AI generation failed closed' });
    }
  }

  private async proposalData(db: Tx, scope: Scope, run: RunSnapshot, node: Node, conversation: ConversationSnapshot, execution: Map<string, Record<string, unknown>>) {
    const config = node.config ?? {};
    // A bare HUMAN_APPROVAL is a manual review gate. It becomes a high-risk
    // action only when an explicit action/risk declares one.
    const type = typeof config.action === 'string' ? config.action : 'CREATE_INTERNAL_TASK';
    const scopedOrder = [...execution.values()].flatMap((output) => Array.isArray(output.orders) ? output.orders : []).find((value): value is Record<string, unknown> => typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).id === 'string');
    const highRisk = isHighRiskAction(type, config.riskLevel);
    const targetEntityType = typeof config.targetEntityType === 'string'
      ? config.targetEntityType
      : (scopedOrder || (highRisk && conversation.currentOrderId) ? 'ORDER' : 'CONVERSATION');
    const targetEntityId = typeof config.targetEntityId === 'string'
      ? config.targetEntityId
      : (scopedOrder ? String(scopedOrder.id) : targetEntityType === 'ORDER' ? conversation.currentOrderId ?? '' : targetEntityType === 'PRODUCT' ? conversation.currentProductId ?? '' : conversation.id);
    let sourceSnapshot: Record<string, unknown> | undefined;
    if (targetEntityType === 'ORDER') {
      const fromRead = scopedOrder && String(scopedOrder.id) === targetEntityId ? scopedOrder : undefined;
      const order = fromRead ?? await db.order?.findFirst?.({ where: { id: targetEntityId, ...scope, buyerId: conversation.buyerId ?? '__missing_buyer__' }, select: { id: true, version: true, status: true } });
      if (!order || !conversation.buyerId) throw new ConflictException({ code: 'PROPOSAL_TARGET_STALE', message: 'High-risk order proposal needs a scoped source snapshot' });
      sourceSnapshot = { orderId: String(order.id), version: order.version, status: order.status };
    } else if (targetEntityType === 'PRODUCT') {
      const product = await db.product?.findFirst?.({ where: { id: targetEntityId, ...scope }, select: { id: true, status: true, contentHash: true } });
      if (!product) throw new ConflictException({ code: 'PROPOSAL_TARGET_STALE', message: 'Product proposal needs a scoped source snapshot' });
      sourceSnapshot = { productId: String(product.id), status: product.status, contentHash: product.contentHash ?? null };
    } else if (highRisk) {
      throw new ConflictException({ code: 'PROPOSAL_TARGET_STALE', message: 'High-risk proposal needs a scoped Order or Product target' });
    }
    const evidenceIdsJson = Array.isArray(config.evidenceIds) ? config.evidenceIds.filter((value): value is string => typeof value === 'string').slice(0, 20) : [];
    const payload = config.payload && typeof config.payload === 'object' && !Array.isArray(config.payload) ? config.payload as Record<string, unknown> : {};
    const payloadJson = { ...payload, action: type, ...(sourceSnapshot ? { sourceSnapshot } : {}) };
    return { ...scope, conversationId: conversation.id, workflowRunId: run.id, nodeId: node.id, type, riskLevel: String(config.riskLevel ?? (highRisk ? 'HIGH_RISK' : 'MEDIUM_WRITE')), targetEntityType, targetEntityId, payloadJson, evidenceIdsJson, contextVersion: conversation.contextVersion, status: 'WAITING_APPROVAL' };
  }

  private evaluateCondition(node: Node, execution: Map<string, Record<string, unknown>>): Record<string, unknown> {
    const explicit = node.config?.branch;
    if (typeof explicit === 'string' && explicit) return { branch: explicit };
    const expression = node.config?.expression;
    // No eval, scripting, interpolation, or arbitrary property access. V1
    // condition language contains only this seeded, bounded factual predicate.
    if (expression === 'order.status != null') {
      const orderPresent = [...execution.values()].some((output) => Array.isArray(output.orders) && output.orders.length > 0);
      return { branch: orderPresent ? 'true' : 'false', expression };
    }
    throw new ConflictException({ code: 'WORKFLOW_CONDITION_UNRESOLVED', message: 'Condition is not in the V1 allowlist' });
  }
}

function isHighRiskAction(type: string, riskLevel: unknown): boolean {
  return riskLevel === 'HIGH_RISK' || ['PROPOSE_COMPENSATION', 'REFUND', 'EXCHANGE', 'refund', 'compensation', 'exchange'].includes(type);
}

function workflowTaskResult(workflowRunId: string, execution: Map<string, Record<string, unknown>>): Record<string, unknown> {
  const nodeResults = Object.fromEntries(execution);
  const reply = [...execution.values()].reverse()
    .map((output) => output.text)
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return {
    workflowRunId,
    workflowStatus: 'COMPLETED',
    ...(reply ? { reply: reply.trim() } : {}),
    nodeResults,
  };
}
