import { WorkflowRealtimePublisher } from '../src/workflow/workflow-realtime.publisher';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

describe('WorkflowRealtimePublisher', () => {
  it('maps committed Workflow projections to the frozen typed WS payloads with a monotonic entity version', () => {
    const gateway = { publish: jest.fn() };
    const publisher = new WorkflowRealtimePublisher(gateway as never);
    const updatedAt = new Date('2026-08-27T02:00:00.000Z');
    const run = {
      id: 'run-a', ...scope, workflowVersionId: 'version-a', conversationId: 'conversation-a',
      taskIdsJson: ['task-a'], contextVersion: 4, currentNodeId: 'trigger', completedNodesJson: ['trigger'],
      status: 'RUNNING', startedAt: updatedAt, updatedAt,
    };

    publisher.publishRun(scope, run);
    publisher.publishRun(scope, { ...run, status: 'RECOVERING' });

    const [first, second] = gateway.publish.mock.calls.map(([event]) => event);
    expect(first).toMatchObject({
      eventType: 'WORKFLOW_RUN_UPDATED', workspaceId: scope.workspaceId,
      entityType: 'WORKFLOW_RUN', entityId: 'run-a',
      payload: { workflowRun: { id: 'run-a', shopId: scope.shopId, workflowVersionId: 'version-a', taskIds: ['task-a'], completedNodeIds: ['trigger'], status: 'RUNNING' } },
    });
    expect(second.payload.workflowRun.status).toBe('RECOVERING');
    expect(second.entityVersion).toBeGreaterThan(first.entityVersion);
  });

  it('publishes canonical node/proposal refreshes only when the durable entity belongs to the exact scope', () => {
    const gateway = { publish: jest.fn() };
    const publisher = new WorkflowRealtimePublisher(gateway as never);
    const now = new Date('2026-08-27T02:00:00.000Z');

    publisher.publishNode(scope, {
      id: 'node-run-a', ...scope, workflowRunId: 'run-a', nodeId: 'approval', status: 'WAITING_APPROVAL',
      inputJson: { taskIds: ['task-a'] }, outputJson: null, retryCount: 0, startedAt: now, updatedAt: now,
    });
    publisher.publishProposal(scope, {
      id: 'proposal-a', ...scope, conversationId: 'conversation-a', workflowRunId: 'run-a', nodeId: 'approval',
      type: 'REFUND', riskLevel: 'HIGH_RISK', targetEntityType: 'ORDER', targetEntityId: 'order-a',
      payloadJson: { amount: 10 }, evidenceIdsJson: ['evidence-a'], contextVersion: 4, status: 'WAITING_APPROVAL', updatedAt: now,
    });
    publisher.publishRun(scope, {
      id: 'run-other', ...scope, tenantId: 'tenant-other', workflowVersionId: 'version-a', conversationId: 'conversation-a',
      taskIdsJson: [], contextVersion: 4, completedNodesJson: [], status: 'RUNNING', startedAt: now,
    });

    expect(gateway.publish).toHaveBeenCalledTimes(2);
    expect(gateway.publish).toHaveBeenNthCalledWith(1, expect.objectContaining({
      eventType: 'WORKFLOW_NODE_UPDATED', workspaceId: scope.workspaceId, entityType: 'WORKFLOW_NODE', entityId: 'node-run-a',
      payload: { workflowRunId: 'run-a', nodeRun: expect.objectContaining({ id: 'node-run-a', nodeId: 'approval', input: { taskIds: ['task-a'] }, status: 'WAITING_APPROVAL' }) },
    }));
    expect(gateway.publish).toHaveBeenNthCalledWith(2, expect.objectContaining({
      eventType: 'ACTION_PROPOSAL_UPDATED', workspaceId: scope.workspaceId, entityType: 'ACTION_PROPOSAL', entityId: 'proposal-a',
      payload: { proposal: expect.objectContaining({ id: 'proposal-a', payload: { amount: 10 }, evidenceIds: ['evidence-a'], status: 'WAITING_APPROVAL' }) },
    }));
  });
});
