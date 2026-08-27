import { describe, expect, it } from 'vitest';
import {
  ACTION_PROPOSAL_STATUSES,
  INCIDENT_STATUSES,
  QUALITY_RESULTS,
  SCENARIO_KEYS,
  WORKFLOW_NODE_RUN_STATUSES,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_RUN_STATUSES,
  isActionProposal,
  isCustomerDataDeletionResult,
  isQualityConclusionInput,
  isOperationAccepted,
  isQualityReview,
  isScenarioKey,
  isTraceEvent,
  isWorkflowGraph,
  type ActionProposal,
  type CustomerDataDeletionResult,
  type QualityConclusionInput,
  type QualityReview,
  type Scenario,
  type TraceEvent,
  type WorkflowGraph,
  type WorkflowRun,
} from '../src/index';

describe('Phase 05 contracts', () => {
  it('freezes the eight V1 workflow node types and run states', () => {
    expect(WORKFLOW_NODE_TYPES).toEqual([
      'TRIGGER',
      'CONDITION',
      'QUERY_PRODUCT',
      'QUERY_ORDER',
      'QUERY_LOGISTICS',
      'AI_GENERATE',
      'HUMAN_APPROVAL',
      'END',
    ]);
    expect(WORKFLOW_RUN_STATUSES).toEqual([
      'PENDING',
      'RUNNING',
      'WAITING_APPROVAL',
      'RECOVERING',
      'COMPLETED',
      'FAILED',
      'STALE',
      'CANCELLED',
    ]);
    expect(WORKFLOW_NODE_RUN_STATUSES).toEqual([
      'PENDING',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'WAITING_APPROVAL',
      'STALE',
      'SKIPPED',
    ]);
    expect(WORKFLOW_RUN_STATUSES).not.toContain('LOOP');
  });

  it('requires graph settings and rejects an unknown node type', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', position: { x: 0, y: 0 }, config: {} },
        { id: 'end', type: 'END', position: { x: 320, y: 0 }, config: {} },
      ],
      edges: [{ id: 'edge-1', source: 'trigger', target: 'end' }],
      settings: { maxSteps: 20, timeoutMs: 30_000 },
    };

    expect(isWorkflowGraph(graph)).toBe(true);
    expect(isWorkflowGraph({ ...graph, settings: undefined })).toBe(false);
    expect(isWorkflowGraph({
      ...graph,
      nodes: [{ ...graph.nodes[0], type: 'CUSTOM' }],
    })).toBe(false);
    const conditional = {
      ...graph,
      nodes: [
        { id: 'trigger', type: 'TRIGGER' as const, position: { x: 0, y: 0 }, config: {} },
        { id: 'condition', type: 'CONDITION' as const, position: { x: 160, y: 0 }, config: {} },
        { id: 'end-a', type: 'END' as const, position: { x: 320, y: -40 }, config: {} },
        { id: 'end-b', type: 'END' as const, position: { x: 320, y: 40 }, config: {} },
      ],
      edges: [
        { id: 'trigger-condition', source: 'trigger', target: 'condition' },
        { id: 'condition-true', source: 'condition', target: 'end-a', condition: 'true' },
        { id: 'condition-false', source: 'condition', target: 'end-b', condition: 'false' },
      ],
    } satisfies WorkflowGraph;
    expect(isWorkflowGraph(conditional)).toBe(true);
    expect(isWorkflowGraph({ ...conditional, edges: conditional.edges.map((edge) => edge.id === 'condition-false' ? { ...edge, condition: 'true' } : edge) })).toBe(false);
    expect(isWorkflowGraph({ ...conditional, edges: conditional.edges.map((edge) => edge.id === 'condition-true' ? { ...edge, condition: undefined } : edge) })).toBe(false);
  });

  it('models immutable workflow runs with node runs and task ownership', () => {
    const run: WorkflowRun = {
      id: 'run-1',
      workspaceId: 'workspace-1',
      tenantId: 'tenant-1',
      shopId: 'shop-1',
      conversationId: 'conversation-1',
      workflowVersionId: 'version-1',
      taskIds: ['task-1'],
      contextVersion: 4,
      currentNodeId: 'approval',
      completedNodeIds: ['trigger', 'query'],
      status: 'WAITING_APPROVAL',
      startedAt: '2026-08-27T10:00:00.000Z',
      nodeRuns: [],
    };

    expect(run.workflowVersionId).toBe('version-1');
    expect(run.taskIds).toEqual(['task-1']);
    expect(WORKFLOW_RUN_STATUSES).toContain(run.status);
  });

  it('accepts only allowlisted ActionProposal, QualityReview and operation receipts', () => {
    const proposal: ActionProposal = {
      id: 'proposal-1',
      workspaceId: 'workspace-1',
      tenantId: 'tenant-1',
      shopId: 'shop-1',
      conversationId: 'conversation-1',
      type: 'PROPOSE_COMPENSATION',
      riskLevel: 'HIGH_RISK',
      targetEntityType: 'ORDER',
      targetEntityId: 'order-1',
      payload: { amount: 20 },
      evidenceIds: ['evidence-1'],
      contextVersion: 4,
      status: 'WAITING_APPROVAL',
    };
    const review: QualityReview = {
      id: 'review-1',
      workspaceId: 'workspace-1',
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      status: 'AUTO_REVIEWED',
      deterministicResult: { passed: true, checks: [] },
      judgeResult: { result: 'PASS', relevance: 1, completeness: 1, groundedness: 1, tone: 1, risk: 'LOW' },
      sampleSize: 1,
    };

    expect(isActionProposal(proposal)).toBe(true);
    expect(isActionProposal({ ...proposal, riskLevel: 'UNSAFE' })).toBe(false);
    expect(isQualityReview(review)).toBe(true);
    const conclusion: QualityConclusionInput = { result: 'PASS' };
    expect(QUALITY_RESULTS).toEqual(['PASS', 'FAIL', 'NEEDS_HUMAN']);
    expect(isQualityConclusionInput(conclusion)).toBe(true);
    expect(isQualityConclusionInput({ result: 'UNKNOWN' })).toBe(false);
    expect(isOperationAccepted({ status: 'ACCEPTED', operationId: 'op-1' })).toBe(true);
    expect(isOperationAccepted({ status: 'ACCEPTED' })).toBe(false);
  });

  it('freezes incident statuses, scenario keys and redacted trace event shape', () => {
    expect(INCIDENT_STATUSES).toEqual([
      'OPEN',
      'CORRECTION_DRAFTED',
      'CORRECTED',
      'ROOT_CAUSE_FIXED',
      'REGRESSION_ADDED',
      'RESOLVED',
    ]);
    expect(SCENARIO_KEYS).toHaveLength(8);
    expect(isScenarioKey('service_restart_recovery')).toBe(true);
    expect(isScenarioKey('prompt_injection')).toBe(false);

    const scenario: Scenario = {
      key: 'service_restart_recovery',
      name: '服务重启恢复',
      status: 'READY',
      synthetic: true,
      steps: [],
    };
    const trace: TraceEvent = {
      id: 'trace-event-1',
      workspaceId: 'workspace-1',
      traceId: 'trace-1',
      stage: 'REPLY_POLICY',
      payload: { decision: 'ASSIST' },
      createdAt: '2026-08-27T10:00:00.000Z',
    };

    expect(scenario.synthetic).toBe(true);
    expect(isTraceEvent(trace)).toBe(true);
    expect(isTraceEvent({ ...trace, payload: 'private prompt' })).toBe(false);
  });

  it('freezes the minimal delete-customer-data result with deletion, anonymization and preservation counts', () => {
    const result: CustomerDataDeletionResult = {
      buyerId: 'buyer-1',
      status: 'COMPLETED',
      deleted: {
        conversations: 2,
        messages: 12,
        attachments: 3,
        customerMemories: 1,
        knowledgeCandidates: 1,
      },
      anonymized: { buyers: 1, orders: 4 },
      preserved: { anonymousAggregates: 1, auditFacts: 1 },
      completedAt: '2026-08-27T10:00:00.000Z',
    };

    expect(isCustomerDataDeletionResult(result)).toBe(true);
    expect(isCustomerDataDeletionResult({ ...result, deleted: { ...result.deleted, messages: -1 } })).toBe(false);
    expect(isCustomerDataDeletionResult({ ...result, anonymized: undefined })).toBe(false);
  });
});
