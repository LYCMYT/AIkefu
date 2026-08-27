import {
  coalesceTaskBundles,
  createTaskBundle,
  executeTaskBundle,
  transitionTask,
} from '../src';

describe('Intent / TaskBundle', () => {
  const read = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    intent: 'INVENTORY_QUERY',
    operation: 'READ' as const,
    riskLevel: 'LOW' as const,
    requiredContext: ['PRODUCT'],
    requiredTools: ['GET_INVENTORY'],
    blocking: false,
    ...overrides,
  });

  it('rejects a plan with more than four independently persisted tasks', () => {
    expect(() => createTaskBundle({ tasks: [read('1'), read('2'), read('3'), read('4'), read('5')] })).toThrow(
      'at most 4 tasks',
    );
  });

  it('runs independent READ tasks in parallel and retains a non-blocking partial result', async () => {
    const bundle = createTaskBundle({ tasks: [read('product'), read('inventory')] });
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const running = executeTaskBundle(bundle, async (task) => {
      started.push(task.id);
      await gate;
      return task.id === 'product'
        ? { status: 'RESOLVED', facts: { productId: 'p-1' }, evidence: ['product'] }
        : { status: 'FAILED', errorCode: 'INVENTORY_UNAVAILABLE' };
    });

    await Promise.resolve();
    expect(started).toEqual(['product', 'inventory']);
    release();

    await expect(running).resolves.toMatchObject({
      status: 'PARTIAL_RESOLVED',
      canAutoReply: true,
      tasks: [
        { id: 'product', status: 'RESOLVED' },
        { id: 'inventory', status: 'FAILED', errorCode: 'INVENTORY_UNAVAILABLE' },
      ],
    });
  });

  it('keeps lifecycle transitions explicit and makes a blocking failure prohibit AUTO', async () => {
    const open = createTaskBundle({ tasks: [read('order', { blocking: true, riskLevel: 'MEDIUM' })] });
    expect(transitionTask(open.tasks[0]!, 'RUNNING')).toMatchObject({ status: 'RUNNING' });
    expect(() => transitionTask(open.tasks[0]!, 'RESOLVED')).toThrow('OPEN -> RESOLVED');

    await expect(
      executeTaskBundle(open, async () => ({ status: 'FAILED', errorCode: 'ORDER_UNAVAILABLE' })),
    ).resolves.toMatchObject({
      status: 'FAILED',
      canAutoReply: false,
      hasBlockingFailure: true,
      tasks: [{ id: 'order', status: 'FAILED', blocking: true }],
    });
  });

  it('coalesces semantically identical open work and supersedes obsolete work from the prior turn', () => {
    const current = createTaskBundle({ tasks: [read('inventory-v1')] });
    const incoming = createTaskBundle({
      tasks: [
        read('inventory-v2'),
        read('logistics-v2', { intent: 'LOGISTICS_QUERY', requiredContext: ['ORDER'], requiredTools: ['GET_LOGISTICS'] }),
      ],
    });

    expect(coalesceTaskBundles(current, incoming)).toMatchObject({
      needsReplan: true,
      supersededTaskIds: ['inventory-v1'],
      tasks: [
        { id: 'inventory-v2', status: 'OPEN' },
        { id: 'logistics-v2', status: 'OPEN' },
      ],
    });
  });
});
