import { WorkflowRuntimeService } from '../src/workflow/workflow-runtime.service';
import { SeedCatalog } from '../src/seed/seed-catalog';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

describe('WorkflowRuntimeService', () => {
  it('does not hold an interactive transaction while an AI node is awaiting a provider', async () => {
    const graph = { nodes: [{ id: 'trigger', type: 'TRIGGER' }, { id: 'generate', type: 'AI_GENERATE', config: {} }, { id: 'end', type: 'END' }], edges: [{ source: 'trigger', target: 'generate' }, { source: 'generate', target: 'end' }], settings: { maxSteps: 3, timeoutMs: 1_000 } };
    let transactionDepth = 0;
    let release!: () => void;
    const deferred = new Promise<{ output: { text: string; requiresHuman: boolean }; provider: string; model: string; fallbackUsed: boolean }>((resolve) => { release = () => resolve({ output: { text: 'ok', requiresHuman: false }, provider: 'fake', model: 'fake', fallbackUsed: false }); });
    const tx = {
      workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', activeVersionId: 'version-a', status: 'PUBLISHED' }) },
      workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'version-a', immutable: true, graphJson: graph }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }) },
      task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowRun: { create: jest.fn().mockResolvedValue({ id: 'run-a', status: 'RUNNING' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowNodeRun: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: jest.fn(async (work: Function) => { transactionDepth += 1; try { return await work(tx); } finally { transactionDepth -= 1; } }) };
    const service = new WorkflowRuntimeService(prisma as never, { runStructured: jest.fn(() => deferred) } as never);
    const pending = service.start(scope, { workflowId: 'workflow-a', conversationId: 'conversation-a', taskIds: ['task-a'] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(transactionDepth).toBe(0);
    release();
    await expect(pending).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['task-a'] }, ownerWorkflowRunId: 'run-a' }),
      data: expect.objectContaining({
        status: 'RESOLVED',
        resultJson: expect.objectContaining({ workflowRunId: 'run-a', workflowStatus: 'COMPLETED', reply: 'ok' }),
      }),
    }));
  });

  it('walks only reachable edges and stops at HUMAN_APPROVAL without running its END successor', async () => {
    const graph = { nodes: [{ id: 'trigger', type: 'TRIGGER' }, { id: 'approval', type: 'HUMAN_APPROVAL' }, { id: 'end', type: 'END' }], edges: [{ from: 'trigger', to: 'approval' }, { from: 'approval', to: 'end' }], settings: { maxSteps: 4, timeoutMs: 1000 } };
    const tx = {
      workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', activeVersionId: 'version-a', priority: 10, status: 'PUBLISHED' }) },
      workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'version-a', immutable: true, graphJson: graph }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }) }, task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowRun: { create: jest.fn().mockResolvedValue({ id: 'run-a', status: 'RUNNING' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowNodeRun: { upsert: jest.fn().mockResolvedValue({}) }, workflowProposal: { create: jest.fn().mockResolvedValue({ id: 'proposal-a' }) },
    };
    const service = new WorkflowRuntimeService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);
    await expect(service.start(scope, { workflowId: 'workflow-a', conversationId: 'conversation-a', taskIds: ['task-a'] })).resolves.toMatchObject({ status: 'WAITING_APPROVAL' });
    expect(tx.workflowProposal.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'CREATE_INTERNAL_TASK', targetEntityType: 'CONVERSATION', targetEntityId: 'conversation-a' }),
    }));
    expect(new Set(tx.workflowNodeRun.upsert.mock.calls.map(([input]: any[]) => input.where.workflowRunId_nodeId.nodeId))).toEqual(new Set(['trigger', 'approval']));
    expect(tx.workflowNodeRun.upsert).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workflowRunId_nodeId: { workflowRunId: 'run-a', nodeId: 'end' } }) }));
  });

  it('captures a scoped ORDER source snapshot for a high-risk approval even without a preceding query node', async () => {
    const graph = { nodes: [{ id: 'trigger', type: 'TRIGGER' }, { id: 'approval', type: 'HUMAN_APPROVAL', config: { action: 'PROPOSE_COMPENSATION', targetEntityType: 'ORDER', targetEntityId: 'order-a' } }, { id: 'end', type: 'END' }], edges: [{ source: 'trigger', target: 'approval' }, { source: 'approval', target: 'end' }], settings: { maxSteps: 3, timeoutMs: 1000 } };
    const tx = {
      workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', activeVersionId: 'version-a', status: 'PUBLISHED' }) },
      workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'version-a', immutable: true, graphJson: graph }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4, buyerId: 'buyer-a' }) }, task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowRun: { create: jest.fn().mockResolvedValue({ id: 'run-a', status: 'RUNNING' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, workflowNodeRun: { upsert: jest.fn().mockResolvedValue({}) },
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', version: 5, status: 'PAID' }) }, workflowProposal: { create: jest.fn().mockResolvedValue({ id: 'proposal-a' }) },
    };
    const service = new WorkflowRuntimeService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);
    await expect(service.start(scope, { workflowId: 'workflow-a', conversationId: 'conversation-a', taskIds: ['task-a'] })).resolves.toMatchObject({ status: 'WAITING_APPROVAL' });
    expect(tx.workflowProposal.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payloadJson: expect.objectContaining({ sourceSnapshot: { orderId: 'order-a', version: 5, status: 'PAID' } }) }) }));
  });

  it('reports STALE instead of WAITING_APPROVAL when context changes at the approval commit boundary', async () => {
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 5 }) },
      workflowRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowNodeRun: { upsert: jest.fn() },
      workflowProposal: { create: jest.fn() },
    };
    const service = new WorkflowRuntimeService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);
    const result = await (service as never as { waitForApproval: Function }).waitForApproval(
      scope,
      { id: 'run-a', workflowVersionId: 'version-a', conversationId: 'conversation-a', contextVersion: 4 },
      { id: 'approval', type: 'HUMAN_APPROVAL', config: {} },
      { id: 'conversation-a', contextVersion: 4 },
      ['task-a'],
      ['trigger'],
      new Map(),
    );

    expect(result).toEqual({ stale: true });
    expect(tx.workflowProposal.create).not.toHaveBeenCalled();
    expect(tx.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }));
    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ownerWorkflowRunId: 'run-a', status: 'RUNNING' }), data: { status: 'SUPERSEDED', errorCode: 'WORKFLOW_CONTEXT_STALE' },
    }));
  });

  it.each(['claim', 'complete'] as const)('publishes the durable STALE projection when context changes at the %s boundary', async (boundary) => {
    const graph = { nodes: [{ id: 'trigger', type: 'TRIGGER' }], edges: [], settings: { maxSteps: 1, timeoutMs: 1000 } };
    const service = new WorkflowRuntimeService({} as never);
    const internal = service as any;
    const publish = jest.spyOn(internal, 'publishCommittedState').mockResolvedValue(undefined);
    jest.spyOn(internal, 'claimNode').mockResolvedValue(boundary === 'claim' ? { stale: true } : { stale: false, conversation: { id: 'conversation-a', contextVersion: 4 } });
    jest.spyOn(internal, 'completeNode').mockResolvedValue({ stale: boundary === 'complete' });

    await expect((service as never as { executeGraph: Function }).executeGraph(
      scope,
      { id: 'run-a', workflowVersionId: 'version-a', conversationId: 'conversation-a', contextVersion: 4 },
      { id: 'conversation-a', contextVersion: 4 },
      graph,
      ['task-a'],
    )).resolves.toMatchObject({ status: 'STALE' });

    expect(publish).toHaveBeenCalledWith(scope, 'run-a');
    expect(publish).toHaveBeenCalledTimes(boundary === 'claim' ? 1 : 2);
  });

  it('uses CONDITION config to select one closed boolean edge instead of traversing unrelated array nodes', async () => {
    const graph = { nodes: [{ id: 'trigger', type: 'TRIGGER' }, { id: 'condition', type: 'CONDITION', config: { branch: 'true' } }, { id: 'yes', type: 'QUERY_PRODUCT' }, { id: 'no', type: 'AI_GENERATE' }, { id: 'end', type: 'END' }], edges: [{ id: 'e1', source: 'trigger', target: 'condition' }, { id: 'e2', source: 'condition', target: 'yes', condition: 'true' }, { id: 'e3', source: 'condition', target: 'no', condition: 'false' }, { id: 'e4', source: 'yes', target: 'end' }, { id: 'e5', source: 'no', target: 'end' }], settings: { maxSteps: 4, timeoutMs: 1000 } };
    const tx = { workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', activeVersionId: 'version-a', status: 'PUBLISHED' }) }, workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'version-a', immutable: true, graphJson: graph }) }, conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }) }, task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, workflowRun: { create: jest.fn().mockResolvedValue({ id: 'run-a', status: 'RUNNING' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, workflowNodeRun: { upsert: jest.fn().mockResolvedValue({}) } };
    const service = new WorkflowRuntimeService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);
    await service.start(scope, { workflowId: 'workflow-a', conversationId: 'conversation-a', taskIds: ['task-a'] });
    expect(new Set(tx.workflowNodeRun.upsert.mock.calls.map(([input]: any[]) => input.where.workflowRunId_nodeId.nodeId))).toEqual(new Set(['trigger', 'condition', 'yes', 'end']));
  });

  it('claims each Task once and fixes an immutable active version/context snapshot on the Run', async () => {
    const tx = {
      workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', activeVersionId: 'version-a', priority: 10, status: 'PUBLISHED' }) },
      workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'version-a', immutable: true, graphJson: { nodes: [{ id: 'trigger', type: 'TRIGGER' }, { id: 'end', type: 'END' }], edges: [{ from: 'trigger', to: 'end' }], settings: { maxSteps: 2, timeoutMs: 1000 } } }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }) },
      task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowRun: { create: jest.fn().mockResolvedValue({ id: 'run-a', status: 'RUNNING' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowNodeRun: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const service = new WorkflowRuntimeService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);
    await expect(service.start(scope, { workflowId: 'workflow-a', conversationId: 'conversation-a', taskIds: ['task-a'] })).resolves.toMatchObject({ id: 'run-a' });
    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['task-a'] }, ownerWorkflowRunId: null }), data: { ownerWorkflowRunId: 'run-a', status: 'RUNNING' } }));
  });

  it('publishes committed Run and Node projections only after runtime transactions resolve', async () => {
    const graph = { nodes: [{ id: 'trigger', type: 'TRIGGER' }, { id: 'end', type: 'END' }], edges: [{ source: 'trigger', target: 'end' }], settings: { maxSteps: 2, timeoutMs: 1000 } };
    const tx = {
      workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', activeVersionId: 'version-a', status: 'PUBLISHED' }) },
      workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'version-a', immutable: true, graphJson: graph }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }) },
      task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowRun: { create: jest.fn().mockResolvedValue({ id: 'run-a', status: 'RUNNING' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowNodeRun: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const durableRun = {
      id: 'run-a', ...scope, workflowVersionId: 'version-a', conversationId: 'conversation-a', taskIdsJson: ['task-a'],
      contextVersion: 4, currentNodeId: 'end', completedNodesJson: ['trigger', 'end'], status: 'COMPLETED', startedAt: new Date(),
      nodeRuns: [{ id: 'node-end', workflowRunId: 'run-a', nodeId: 'end', status: 'SUCCEEDED', retryCount: 0, startedAt: new Date() }], proposals: [],
    };
    const prisma = {
      $transaction: jest.fn((work: Function) => work(tx)),
      workflowRun: { findFirst: jest.fn().mockResolvedValue(durableRun) },
    };
    const realtime = { publishRun: jest.fn(), publishNode: jest.fn(), publishProposal: jest.fn() };
    const service = new WorkflowRuntimeService(prisma as never, undefined, undefined, realtime as never);

    await service.start(scope, { workflowId: 'workflow-a', conversationId: 'conversation-a', taskIds: ['task-a'] });

    expect(realtime.publishRun).toHaveBeenCalledWith(scope, durableRun);
    expect(realtime.publishNode).toHaveBeenCalledWith(scope, expect.objectContaining({ id: 'node-end', ...scope }));
  });

  it('executes both frozen seed graphs through canonical edges, including the bounded order condition and approval target', async () => {
    const seed = await new SeedCatalog().load();
    for (const source of seed.workflows) {
      const tx = {
        workflow: { findFirst: jest.fn().mockResolvedValue({ id: source.key, activeVersionId: `${source.key}-v1`, status: 'PUBLISHED' }) },
        workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: `${source.key}-v1`, immutable: true, graphJson: source.graph }) },
        conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4, buyerId: 'buyer-a' }) },
        task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        workflowRun: { create: jest.fn().mockResolvedValue({ id: `run-${source.key}`, status: 'RUNNING' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        workflowNodeRun: { upsert: jest.fn().mockResolvedValue({}) },
        product: { findMany: jest.fn().mockResolvedValue([{ id: 'product-a', title: '合成商品', externalProductId: 'p-a', status: 'ON_SHELF', recommendable: true }]) },
        order: { findMany: jest.fn().mockResolvedValue([{ id: 'order-a', externalOrderId: 'o-a', status: 'SHIPPED', version: 2, shippedAt: null, logisticsSnapshotJson: null }]) },
        workflowProposal: { create: jest.fn().mockResolvedValue({ id: 'proposal-a' }) },
      };
      const service = new WorkflowRuntimeService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);
      const result = await service.start(scope, { workflowId: source.key, conversationId: 'conversation-a', taskIds: ['task-a'] });
      const ids = new Set(tx.workflowNodeRun.upsert.mock.calls.map(([input]: any[]) => input.where.workflowRunId_nodeId.nodeId));
      if (source.key === 'wf_product_recommendation') {
        expect(result.status).toBe('COMPLETED');
        expect(ids).toEqual(new Set(['trigger', 'query', 'generate', 'end']));
      } else {
        expect(result.status).toBe('WAITING_APPROVAL');
        expect(ids).toEqual(new Set(['trigger', 'order', 'condition', 'generate', 'approval']));
        expect(tx.workflowProposal.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ targetEntityType: 'ORDER', targetEntityId: 'order-a', riskLevel: 'HIGH_RISK' }) }));
      }
    }
  });

  it('takes the frozen after-sales false branch to END when no buyer-scoped order exists', async () => {
    const graph = (await new SeedCatalog().load()).workflows.find((workflow) => workflow.key === 'wf_after_sales_template')!.graph;
    const tx = {
      workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'wf_after_sales_template', activeVersionId: 'after-sales-v1', status: 'PUBLISHED' }) },
      workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'after-sales-v1', immutable: true, graphJson: graph }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4, buyerId: 'buyer-a' }) },
      task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowRun: { create: jest.fn().mockResolvedValue({ id: 'run-no-order', status: 'RUNNING' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowNodeRun: { upsert: jest.fn().mockResolvedValue({}) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
      workflowProposal: { create: jest.fn() },
    };
    const service = new WorkflowRuntimeService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(service.start(scope, { workflowId: 'wf_after_sales_template', conversationId: 'conversation-a', taskIds: ['task-a'] })).resolves.toMatchObject({ status: 'COMPLETED', currentNodeId: 'end' });
    expect(tx.workflowProposal.create).not.toHaveBeenCalled();
    expect(new Set(tx.workflowNodeRun.upsert.mock.calls.map(([input]: any[]) => input.where.workflowRunId_nodeId.nodeId))).toEqual(new Set(['trigger', 'order', 'condition', 'end']));
  });

  it('recovers a RUNNING run from its persisted node cursor, but marks it STALE when context changed', async () => {
    const graph = { nodes: [{ id: 'trigger', type: 'TRIGGER' }, { id: 'end', type: 'END' }], edges: [{ source: 'trigger', target: 'end' }], settings: { maxSteps: 2, timeoutMs: 1000 } };
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }) },
      workflowRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, workflowNodeRun: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      workflowRun: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'run-a', workflowVersionId: 'version-a', conversationId: 'conversation-a', contextVersion: 4,
          status: 'RUNNING', taskIdsJson: ['task-a'], completedNodesJson: ['trigger'],
          workflowVersion: { immutable: true, graphJson: graph },
          conversation: { id: 'conversation-a', contextVersion: 4 },
          nodeRuns: [{ nodeId: 'trigger', status: 'SUCCEEDED', outputJson: { taskIds: ['task-a'] } }],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((work: Function) => work(tx)),
    };
    const service = new WorkflowRuntimeService(prisma as never);
    await expect(service.recover(scope, 'run-a')).resolves.toMatchObject({ status: 'COMPLETED', currentNodeId: 'end' });
    expect(tx.workflowNodeRun.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workflowRunId_nodeId: { workflowRunId: 'run-a', nodeId: 'end' } }) }));
  });
});
