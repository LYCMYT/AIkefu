import { WorkflowService } from '../src/workflow/workflow.service';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };
const graph = {
  nodes: [
    { id: 'trigger', type: 'TRIGGER', position: { x: 40, y: 80 }, config: {} },
    { id: 'end', type: 'END', position: { x: 360, y: 80 }, config: {} },
  ],
  edges: [{ id: 'trigger-end', source: 'trigger', target: 'end' }],
  settings: { maxSteps: 2, timeoutMs: 1_000 },
};

describe('WorkflowService', () => {
  it('allows an invalid editable draft, reports validation errors, and only rejects it at publish', async () => {
    const invalid = { ...graph, nodes: [{ id: 'end', type: 'END' as const }] };
    const prisma = {
      workflowVersion: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ id: 'draft-a', immutable: false, graphJson: invalid }),
      },
      workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', versions: [{ id: 'draft-a', immutable: false, graphJson: invalid }] }) },
      $transaction: jest.fn((work: Function) => work({
        workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', activeVersionId: null }), updateMany: jest.fn() },
        workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'draft-a', immutable: false, graphJson: invalid }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      })),
    };
    const service = new WorkflowService(prisma as never);
    await expect(service.updateDraft(scope, 'workflow-a', invalid)).resolves.toBeDefined();
    await expect(service.validate(scope, 'workflow-a')).resolves.toMatchObject({ valid: false });
    await expect(service.publish(scope, 'workflow-a')).rejects.toMatchObject({ response: { code: 'WORKFLOW_GRAPH_INVALID' } });
  });

  it('clones an immutable active version to the next editable draft before updating it', async () => {
    const tx = {
      workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', activeVersionId: 'version-1' }) },
      workflowVersion: {
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 'version-1', version: 1, immutable: true, graphJson: graph }),
        create: jest.fn().mockResolvedValue({ id: 'draft-2', version: 2, immutable: false }), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new WorkflowService({ $transaction: jest.fn((work: Function) => work(tx)), workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', versions: [] }) } } as never);
    await expect(service.updateDraft(scope, 'workflow-a', graph as never)).resolves.toBeDefined();
    expect(tx.workflowVersion.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workflowId: 'workflow-a', version: 2, immutable: false }) }));
  });

  it('refuses to enable a workflow without an immutable active version', async () => {
    const service = new WorkflowService({
      workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', activeVersionId: null }), updateMany: jest.fn() },
    } as never);
    await expect(service.setEnabled(scope, 'workflow-a', true)).rejects.toMatchObject({ response: { code: 'WORKFLOW_ACTIVE_VERSION_REQUIRED' } });
  });

  it('saves a scoped Draft then validates/publishes an immutable version with active-version CAS', async () => {
    const tx = {
      workflow: { findFirst: jest.fn().mockResolvedValue({ id: 'workflow-a', activeVersionId: null, status: 'DRAFT' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workflowVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'version-a', workflowId: 'workflow-a', version: 1, immutable: false, graphJson: graph }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new WorkflowService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);
    await expect(service.publish(scope, 'workflow-a')).resolves.toMatchObject({ id: 'version-a', immutable: true });
    expect(tx.workflowVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'version-a', immutable: false }), data: expect.objectContaining({ immutable: true }) }));
    expect(tx.workflow.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'workflow-a', activeVersionId: null }), data: expect.objectContaining({ activeVersionId: 'version-a', status: 'PUBLISHED' }) }));
  });

  it('projects canonical workflow/version DTOs and never leaks graphJson storage fields', async () => {
    const prisma = {
      workflow: { findMany: jest.fn().mockResolvedValue([{ id: 'workflow-a', ...scope, name: '流程', type: 'SHOP', priority: 1, status: 'PUBLISHED', activeVersionId: 'version-a', versions: [{ id: 'version-a', workflowId: 'workflow-a', version: 1, immutable: true, graphJson: graph, createdAt: new Date('2026-01-01') }, { id: 'draft-b', workflowId: 'workflow-a', version: 2, immutable: false, graphJson: graph }] }]) },
    };
    const service = new WorkflowService(prisma as never);
    await expect(service.list(scope)).resolves.toEqual([expect.objectContaining({
      id: 'workflow-a', activeVersion: expect.objectContaining({ id: 'version-a', graph }), draftVersion: expect.objectContaining({ id: 'draft-b', graph }),
    })]);
    const result = await service.list(scope);
    expect(result[0]).not.toHaveProperty('versions');
    expect(result[0]!.activeVersion).not.toHaveProperty('graphJson');
  });
});
