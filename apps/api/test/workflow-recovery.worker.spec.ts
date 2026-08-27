import { WorkflowRecoveryWorker } from '../src/workflow/workflow-recovery.worker';

describe('WorkflowRecoveryWorker', () => {
  it('contains a bootstrap database failure and leaves the scheduled retry path usable', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://unavailable';
    const prisma = { workflowRun: { findMany: jest.fn().mockRejectedValue(new Error('database unavailable')) } };
    const runtime = { recover: jest.fn() };
    const worker = new WorkflowRecoveryWorker(prisma as never, runtime as never);
    const error = jest.spyOn((worker as unknown as { logger: { error: (message: string) => void } }).logger, 'error').mockImplementation();

    expect(() => worker.onModuleInit()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(prisma.workflowRun.findMany).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Workflow recovery scan failed'));
    await expect(worker.recoverOnce()).rejects.toThrow('database unavailable');
    worker.onModuleDestroy();
    error.mockRestore();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('does not start background recovery without a configured database', () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const prisma = { workflowRun: { findMany: jest.fn() } };
    const worker = new WorkflowRecoveryWorker(prisma as never, {} as never);
    worker.onModuleInit();
    expect(prisma.workflowRun.findMany).not.toHaveBeenCalled();
    worker.onModuleDestroy();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('CAS-claims only stale RUNNING/RECOVERING runs, resumes them, and leaves WAITING_APPROVAL untouched', async () => {
    const updatedAt = new Date('2026-08-27T00:00:00.000Z');
    const prisma = {
      workflowRun: {
        findMany: jest.fn().mockResolvedValue([{ id: 'run-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', updatedAt }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const runtime = { recover: jest.fn().mockResolvedValue({ id: 'run-a', status: 'COMPLETED' }) };
    const worker = new WorkflowRecoveryWorker(prisma as never, runtime as never);
    await worker.recoverOnce(new Date('2026-08-27T00:01:00.000Z'));
    expect(prisma.workflowRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: ['RUNNING', 'RECOVERING'] } }) }));
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'run-a', updatedAt }), data: { status: 'RECOVERING' } }));
    expect(runtime.recover).toHaveBeenCalledWith({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }, 'run-a');
  });
});
