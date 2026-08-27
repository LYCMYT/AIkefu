import { WorkflowProposalService } from '../src/workflow/workflow-proposal.service';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };
const proposal = {
  id: 'proposal-a', ...scope, conversationId: 'conversation-a', workflowRunId: 'run-a',
  type: 'REFUND', riskLevel: 'HIGH_RISK', targetEntityType: 'ORDER', targetEntityId: 'order-a',
  evidenceIdsJson: ['evidence-a'], contextVersion: 4, status: 'WAITING_APPROVAL',
  payloadJson: { sourceSnapshot: { orderId: 'order-a', version: 3, status: 'SHIPPED' } },
  conversation: { buyerId: 'buyer-a' }, workflowRun: { completedNodesJson: ['trigger'] },
};

describe('WorkflowProposalService', () => {
  it('fails closed as STALE before execution when the scoped conversation context changed', async () => {
    const tx = {
      workflowProposal: { findFirst: jest.fn().mockResolvedValue(proposal), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 5 }) },
      workflowRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new WorkflowProposalService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);
    await expect(service.approve(scope, 'proposal-a', { approvedBy: 'operator-a' })).resolves.toMatchObject({ status: 'STALE' });
    expect(tx.workflowProposal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'STALE' }) }));
    expect(tx.workflowProposal.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED' }) }));
    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SUPERSEDED', errorCode: 'CONVERSATION_CONTEXT_STALE' } }));
  });

  it('revalidates the scoped target and records a mock receipt before a HIGH_RISK proposal can succeed', async () => {
    const tx = {
      workflowProposal: { findFirst: jest.fn().mockResolvedValue(proposal), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }) },
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', version: 3, status: 'SHIPPED' }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-a' }) }, workflowNodeRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      task: { findFirst: jest.fn().mockResolvedValue({ userTurnId: 'turn-a', conversationId: 'conversation-a' }) },
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({ id: 'reply-a', sourceContextVersion: 4, status: 'WAITING_HUMAN', staleReason: 'WORKFLOW_APPROVAL_REQUIRED' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const runtime = { recover: jest.fn().mockResolvedValue({ id: 'run-a', status: 'COMPLETED' }) };
    const replyRuntime = { process: jest.fn().mockResolvedValue({ status: 'READY_TO_SEND' }) };
    const realtime = { publishRun: jest.fn(), publishNode: jest.fn(), publishProposal: jest.fn() };
    const Service = WorkflowProposalService as unknown as new (...args: any[]) => WorkflowProposalService;
    const service = new Service({ $transaction: jest.fn((work: Function) => work(tx)) } as never, runtime as never, replyRuntime, realtime);
    await expect(service.approve(scope, 'proposal-a', { approvedBy: 'operator-a' })).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(tx.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ...scope, id: 'order-a' }) }));
    expect(tx.workflowProposal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED', receiptJson: expect.objectContaining({ kind: 'MOCK_RECEIPT' }) }) }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'WORKFLOW_PROPOSAL_EXECUTED', entityId: 'proposal-a' }) }));
    expect(tx.workflowNodeRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED' }) }));
    expect(tx.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'RECOVERING' }) }));
    expect(runtime.recover).toHaveBeenCalledWith(scope, 'run-a');
    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'STALE', staleReason: 'WORKFLOW_APPROVED' } }));
    expect(tx.replyJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'RECOVERY_PENDING', staleReason: null } }));
    expect(replyRuntime.process).toHaveBeenCalledWith(scope, 'reply-a');
    expect(realtime.publishProposal).toHaveBeenCalledWith(scope, expect.objectContaining({ id: 'proposal-a', status: 'SUCCEEDED' }));
  });

  it('marks an ORDER proposal STALE when its persisted scoped source snapshot no longer matches', async () => {
    const tx = {
      workflowProposal: { findFirst: jest.fn().mockResolvedValue({ ...proposal, payloadJson: { sourceSnapshot: { orderId: 'order-a', version: 2, status: 'SHIPPED' } } }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }) },
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', version: 3, status: 'SHIPPED' }) },
      workflowRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new WorkflowProposalService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);
    await expect(service.approve(scope, 'proposal-a', { approvedBy: 'operator-a' })).resolves.toMatchObject({ status: 'STALE' });
    expect(tx.workflowProposal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'STALE', failureCode: 'PROPOSAL_TARGET_STALE' }) }));
  });

  it('fails closed when an ORDER proposal has no durable source snapshot, even if the target still exists', async () => {
    const tx = {
      workflowProposal: { findFirst: jest.fn().mockResolvedValue({ ...proposal, payloadJson: {} }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }) },
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', version: 3, status: 'SHIPPED' }) },
      workflowRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new WorkflowProposalService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);
    await expect(service.approve(scope, 'proposal-a', { approvedBy: 'operator-a' })).resolves.toMatchObject({ status: 'STALE' });
    expect(tx.workflowProposal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'STALE', failureCode: 'PROPOSAL_TARGET_STALE' }) }));
  });

  it('cancels owned running Tasks when a waiting proposal is rejected', async () => {
    const tx = {
      workflowProposal: { findFirst: jest.fn().mockResolvedValue(proposal), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowNodeRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new WorkflowProposalService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);

    await expect(service.reject(scope, 'proposal-a', { reason: 'operator rejected' })).resolves.toEqual({ id: 'proposal-a', status: 'REJECTED' });
    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ownerWorkflowRunId: 'run-a', status: 'RUNNING' }), data: { status: 'CANCELLED', errorCode: 'WORKFLOW_PROPOSAL_REJECTED' },
    }));
  });
});
