import { validateWorkflowGraph, type WorkflowDefinition } from '../src/workflow';

const base = (): WorkflowDefinition => ({
  nodes: [
    { id: 'trigger', type: 'TRIGGER' },
    { id: 'product', type: 'QUERY_PRODUCT', config: { tool: 'getProduct' } },
    { id: 'end', type: 'END' },
  ],
  edges: [{ source: 'trigger', target: 'product' }, { source: 'product', target: 'end' }],
  settings: { maxSteps: 3, timeoutMs: 3_000 },
});

describe('Workflow graph validation', () => {
  it('accepts only the finite V1 graph and node/tool allowlists', () => {
    expect(validateWorkflowGraph(base())).toEqual({ valid: true, errors: [] });
    const graph = base();
    graph.nodes[1]!.type = 'SCRIPT' as never;
    expect(validateWorkflowGraph(graph)).toMatchObject({ valid: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'NODE_TYPE_NOT_ALLOWED' })]) });
    graph.nodes[1]!.type = 'QUERY_PRODUCT';
    graph.nodes[1]!.config = { tool: 'deleteEverything' };
    expect(validateWorkflowGraph(graph)).toMatchObject({ valid: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'TOOL_NOT_ALLOWED' })]) });
  });

  it('requires one Trigger, a reachable End, no isolated nodes or cycles, and bounded settings', () => {
    const noTrigger = base();
    noTrigger.nodes[0]!.type = 'CONDITION';
    expect(validateWorkflowGraph(noTrigger).errors.map((error) => error.code)).toContain('TRIGGER_COUNT_INVALID');

    const unreachable = base();
    unreachable.edges = [{ source: 'trigger', target: 'product' }];
    expect(validateWorkflowGraph(unreachable).errors.map((error) => error.code)).toEqual(expect.arrayContaining(['END_NOT_REACHABLE', 'ISOLATED_NODE']));

    const cyclic = base();
    cyclic.edges.push({ source: 'product', target: 'trigger' });
    expect(validateWorkflowGraph(cyclic).errors.map((error) => error.code)).toContain('CYCLE_NOT_ALLOWED');

    const bounded = base();
    bounded.settings = { maxSteps: 21, timeoutMs: 30_001 };
    expect(validateWorkflowGraph(bounded).errors.map((error) => error.code)).toEqual(expect.arrayContaining(['MAX_STEPS_INVALID', 'TIMEOUT_INVALID']));
  });

  it('requires every high-risk action path to cross HUMAN_APPROVAL', () => {
    const unsafe = base();
    unsafe.nodes[1] = { id: 'refund', type: 'AI_GENERATE', config: { actionRisk: 'HIGH_RISK', tool: 'refund' } };
    unsafe.edges = [{ source: 'trigger', target: 'refund' }, { source: 'refund', target: 'end' }];
    expect(validateWorkflowGraph(unsafe)).toMatchObject({ valid: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'HIGH_RISK_APPROVAL_REQUIRED', nodeId: 'refund' })]) });

    const safe = base();
    safe.nodes.splice(2, 0, { id: 'approval', type: 'HUMAN_APPROVAL' });
    safe.settings.maxSteps = 4;
    safe.nodes[1] = { id: 'refund', type: 'AI_GENERATE', config: { actionRisk: 'HIGH_RISK', tool: 'refund' } };
    safe.edges = [{ source: 'trigger', target: 'refund' }, { source: 'refund', target: 'approval' }, { source: 'approval', target: 'end' }];
    expect(validateWorkflowGraph(safe)).toEqual({ valid: true, errors: [] });

    const bypass = base();
    bypass.nodes[1] = { id: 'refund', type: 'AI_GENERATE', config: { tool: 'refund', riskLevel: 'HIGH_RISK' } };
    bypass.edges = [{ source: 'trigger', target: 'refund' }, { source: 'refund', target: 'end' }];
    expect(validateWorkflowGraph(bypass).errors.map((error) => error.code)).toContain('HIGH_RISK_APPROVAL_REQUIRED');
  });

  it('rejects paths longer than maxSteps and runtime-ambiguous branch shapes before publish', () => {
    const long = base();
    long.nodes.splice(2, 0, { id: 'generate', type: 'AI_GENERATE' });
    long.edges = [{ source: 'trigger', target: 'product' }, { source: 'product', target: 'generate' }, { source: 'generate', target: 'end' }];
    expect(validateWorkflowGraph(long).errors.map((error) => error.code)).toContain('MAX_STEPS_INVALID');

    const branching = base();
    branching.nodes.splice(2, 0, { id: 'other', type: 'AI_GENERATE' });
    branching.edges = [{ source: 'trigger', target: 'product' }, { source: 'product', target: 'end' }, { source: 'product', target: 'other' }, { source: 'other', target: 'end' }];
    expect(validateWorkflowGraph(branching).errors.map((error) => error.code)).toContain('BRANCH_INVALID');

    const condition = base();
    condition.nodes[1] = { id: 'condition', type: 'CONDITION' };
    condition.edges = [{ source: 'trigger', target: 'condition' }, { source: 'condition', target: 'end' }];
    expect(validateWorkflowGraph(condition).errors.map((error) => error.code)).toContain('BRANCH_INVALID');

    const missingFalse = base();
    missingFalse.nodes = [
      { id: 'trigger', type: 'TRIGGER' }, { id: 'condition', type: 'CONDITION' },
      { id: 'on-true', type: 'QUERY_PRODUCT' }, { id: 'end', type: 'END' },
    ];
    missingFalse.edges = [
      { source: 'trigger', target: 'condition' }, { source: 'condition', target: 'on-true', condition: 'true' }, { source: 'on-true', target: 'end' },
    ];
    missingFalse.settings.maxSteps = 4;
    expect(validateWorkflowGraph(missingFalse).errors.map((error) => error.code)).toContain('BRANCH_INVALID');

    const closed = base();
    closed.nodes = [
      { id: 'trigger', type: 'TRIGGER' }, { id: 'condition', type: 'CONDITION' },
      { id: 'on-true', type: 'QUERY_PRODUCT' }, { id: 'end', type: 'END' },
    ];
    closed.edges = [
      { source: 'trigger', target: 'condition' }, { source: 'condition', target: 'on-true', condition: 'true' },
      { source: 'condition', target: 'end', condition: 'false' }, { source: 'on-true', target: 'end' },
    ];
    closed.settings.maxSteps = 4;
    expect(validateWorkflowGraph(closed)).toEqual({ valid: true, errors: [] });

    const endOutgoing = base();
    endOutgoing.edges.push({ source: 'end', target: 'product' });
    expect(validateWorkflowGraph(endOutgoing).errors.map((error) => error.code)).toEqual(expect.arrayContaining(['BRANCH_INVALID', 'CYCLE_NOT_ALLOWED']));
  });
});
