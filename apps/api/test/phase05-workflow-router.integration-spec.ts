import { PrismaMessageApplication } from '../src/messages/prisma-message.application';
import { ReplyRuntimeService } from '../src/replies/reply-runtime.service';
import { WorkflowRouterService } from '../src/workflow/workflow-router.service';
import { WorkflowRuntimeService } from '../src/workflow/workflow-runtime.service';
import { Prisma } from '@prisma/client';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

/** Durable Task -> outbox -> Router -> immutable Run -> Approval chain. */
describe('Phase 05 workflow router production-service integration', () => {
  it('finishes a claimed workflow route quietly when its demo workspace was deleted', async () => {
    const eventId = 'workflow-route:deleted-workspace';
    const tx = {
      processingReceipt: { findUnique: jest.fn().mockResolvedValue(null) },
      processingOutbox: { findUnique: jest.fn().mockResolvedValue({
        eventId,
        eventType: 'WORKFLOW_ROUTE',
        workspaceId: 'workspace-deleted',
        tenantId: 'tenant-a',
        shopId: 'shop-a',
        payloadJson: { conversationId: 'conversation-a', taskIds: ['task-a'] },
      }) },
    };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
      processingReceipt: { create: jest.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError('deleted scope', { code: 'P2003', clientVersion: 'test' })) },
      processingOutbox: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const router = { route: jest.fn().mockResolvedValue([]) };
    const app = new PrismaMessageApplication(prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never, undefined, undefined, undefined, undefined, undefined, undefined, router as never);

    await expect((app as unknown as { consumeOutbox(id: string): Promise<void> }).consumeOutbox(eventId)).resolves.toBeUndefined();
    expect(router.route).toHaveBeenCalledTimes(1);
    expect(prisma.processingOutbox.findUnique).toHaveBeenCalledWith({ where: { eventId }, select: { id: true } });
  });

  it('routes persisted reply Tasks once through a durable WORKFLOW_ROUTE receipt into a high-risk waiting approval', async () => {
    const outboxes: Array<Record<string, unknown>> = [];
    const receipts: string[] = [];
    const tasks: Array<Record<string, unknown>> = [];
    const graph = {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', config: { intent: 'AFTER_SALES_QUERY' } },
        { id: 'approval', type: 'HUMAN_APPROVAL', config: { action: 'PROPOSE_COMPENSATION', targetEntityType: 'ORDER', targetEntityId: 'order-a' } },
        { id: 'end', type: 'END' },
      ],
      edges: [{ source: 'trigger', target: 'approval' }, { source: 'approval', target: 'end' }], settings: { maxSteps: 3, timeoutMs: 1_000 },
    };
    const tx = {
      task: {
        createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => { tasks.push(...data); return { count: data.length }; }),
        findMany: jest.fn(async () => tasks.map((task) => ({ id: task.id, intent: task.intent, operation: task.operation }))),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      processingOutbox: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { outboxes.push(data); return data; }),
        findUnique: jest.fn(async ({ where }: { where: { eventId: string } }) => outboxes.find((row) => row.eventId === where.eventId) ?? null),
      },
      processingReceipt: {
        findUnique: jest.fn(async ({ where }: { where: { eventId: string } }) => receipts.includes(where.eventId) ? { eventId: where.eventId } : null),
        create: jest.fn(async ({ data }: { data: { eventId: string } }) => { receipts.push(data.eventId); return data; }),
      },
      workflow: {
        findMany: jest.fn().mockResolvedValue([{ id: 'workflow-a', priority: 10, activeVersionId: 'version-a', versions: [{ id: 'version-a', graphJson: graph }] }]),
        findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', activeVersionId: 'version-a', status: 'PUBLISHED' }),
      },
      workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'version-a', immutable: true, graphJson: graph }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4, buyerId: 'buyer-a' }) },
      workflowRun: { create: jest.fn().mockResolvedValue({ id: 'run-a' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowNodeRun: { upsert: jest.fn().mockResolvedValue({}) },
      workflowProposal: { create: jest.fn().mockResolvedValue({ id: 'proposal-a' }) },
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', version: 2, status: 'PAID' }) },
    };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
      processingReceipt: tx.processingReceipt,
      task: tx.task,
      workflow: tx.workflow,
    };
    const workflowRuntime = new WorkflowRuntimeService(prisma as never);
    const router = new WorkflowRouterService(prisma as never, workflowRuntime);
    const replyRuntime = new ReplyRuntimeService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    await (replyRuntime as unknown as { persistTasks: Function }).persistTasks(scope, 'reply-a', 'conversation-a', 'turn-a', [{ id: 'task-a', intent: 'AFTER_SALES_QUERY', operation: 'READ', riskLevel: 'HIGH', requiredContext: ['ORDER'], requiredTools: [], status: 'OPEN', blocking: false }]);
    expect(outboxes).toHaveLength(1);
    expect(outboxes[0]).toMatchObject({ eventType: 'WORKFLOW_ROUTE', aggregateId: 'reply-a', payloadJson: { conversationId: 'conversation-a', taskIds: ['reply-task:reply-a:task-a'] } });

    const app = new PrismaMessageApplication(prisma as never, { publish: jest.fn() } as never, {} as never, {} as never, {} as never, undefined, undefined, undefined, undefined, undefined, undefined, router);
    await (app as unknown as { consumeOutbox(eventId: string): Promise<void> }).consumeOutbox('workflow-route:reply-a');

    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerWorkflowRunId: null }), data: { ownerWorkflowRunId: 'run-a', status: 'RUNNING' } }));
    expect(tx.workflowRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workflowVersionId: 'version-a', taskIdsJson: ['reply-task:reply-a:task-a'] }) }));
    expect(tx.workflowProposal.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'WAITING_APPROVAL', targetEntityId: 'order-a', payloadJson: expect.objectContaining({ sourceSnapshot: { orderId: 'order-a', version: 2, status: 'PAID' } }) }) }));
    expect(receipts).toEqual(['workflow-route:reply-a']);
  });
});
