import { WorkflowController } from '../src/workflow/workflow.controller';

const workspace = { workspaceId: 'workspace-a', tenantId: 'tenant-a', workspaceToken: 'token-a' };
const scoped = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

describe('WorkflowController contract scope derivation', () => {
  it('runs and approves without trusting a client shopId, deriving the persisted scoped entity instead', async () => {
    const workflows = { list: jest.fn(), create: jest.fn(), get: jest.fn(), updateDraft: jest.fn(), publish: jest.fn(), setEnabled: jest.fn() };
    const runtime = { scopeForConversation: jest.fn().mockResolvedValue(scoped), start: jest.fn().mockResolvedValue({ id: 'run-a' }), list: jest.fn(), scopeForRun: jest.fn(), get: jest.fn() };
    const proposals = { scopeForProposal: jest.fn().mockResolvedValue(scoped), approve: jest.fn().mockResolvedValue({ status: 'SUCCEEDED' }), reject: jest.fn() };
    const controller = new WorkflowController(workflows as never, runtime as never, proposals as never);
    await expect(controller.testRun(workspace as never, 'workflow-a', { conversationId: 'conversation-a' })).resolves.toEqual({ status: 'ACCEPTED', operationId: 'run-a' });
    expect(runtime.scopeForConversation).toHaveBeenCalledWith(workspace, 'conversation-a');
    expect(runtime.start).toHaveBeenCalledWith(scoped, { workflowId: 'workflow-a', conversationId: 'conversation-a', taskIds: [] });
    await controller.approve(workspace as never, 'proposal-a', { expectedContextVersion: 4 });
    expect(proposals.scopeForProposal).toHaveBeenCalledWith(workspace, 'proposal-a');
    expect(proposals.approve).toHaveBeenCalledWith(scoped, 'proposal-a', expect.objectContaining({ expectedContextVersion: 4 }));
  });

  it('passes canonical workflow projections through its REST list rather than Prisma graphJson fields', async () => {
    const workflows = { list: jest.fn().mockResolvedValue([{ id: 'workflow-a', activeVersion: { graph: { nodes: [], edges: [], settings: { maxSteps: 1, timeoutMs: 1 } } }, draftVersion: null }]), create: jest.fn(), get: jest.fn(), updateDraft: jest.fn(), publish: jest.fn(), setEnabled: jest.fn() };
    const controller = new WorkflowController(workflows as never, {} as never, {} as never);
    const result = await controller.list(workspace as never);
    expect(result).toEqual([expect.objectContaining({ activeVersion: expect.objectContaining({ graph: expect.any(Object) }) })]);
    expect(result[0]).not.toHaveProperty('graphJson');
  });
});
