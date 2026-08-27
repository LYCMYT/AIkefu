import { WorkflowRouterService } from '../src/workflow/workflow-router.service';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

describe('WorkflowRouterService', () => {
  it('selects only the highest-priority matching published workflow and delegates Task ownership to Runtime CAS', async () => {
    const runtime = { start: jest.fn().mockResolvedValue({ id: 'run-a', status: 'COMPLETED' }) };
    const prisma = {
      task: { findMany: jest.fn().mockResolvedValue([{ id: 'task-a', intent: 'PRODUCT_RECOMMENDATION', operation: 'READ' }]) },
      workflow: { findMany: jest.fn().mockResolvedValue([
        { id: 'low', priority: 10, activeVersionId: 'version-low', versions: [{ id: 'version-low', graphJson: { nodes: [{ id: 't', type: 'TRIGGER', config: { intent: 'PRODUCT_RECOMMENDATION' } }], edges: [], settings: { maxSteps: 1, timeoutMs: 1000 } } }] },
        { id: 'high', priority: 90, activeVersionId: 'version-high', versions: [{ id: 'version-high', graphJson: { nodes: [{ id: 't', type: 'TRIGGER', config: { intent: 'PRODUCT_RECOMMENDATION' } }], edges: [], settings: { maxSteps: 1, timeoutMs: 1000 } } }] },
      ]) },
    };
    const service = new WorkflowRouterService(prisma as never, runtime as never);
    await expect(service.route(scope, { conversationId: 'conversation-a', taskIds: ['task-a'] })).resolves.toEqual([{ taskId: 'task-a', workflowId: 'high', runId: 'run-a', status: 'COMPLETED' }]);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.start).toHaveBeenCalledWith(scope, { workflowId: 'high', conversationId: 'conversation-a', taskIds: ['task-a'] });
  });
});
