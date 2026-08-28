import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@ai-customer-service/contracts';
import {
  addWorkflowEdge,
  addWorkflowNode,
  autoLayoutWorkflowGraph,
  isActionProposalDecisionEnabled,
  moveWorkflowNode,
  removeWorkflowEdge,
  removeWorkflowNode,
  updateWorkflowNodeConfig,
  updateWorkflowSettings,
  workflowGraphEquals,
} from './App';

const graph: WorkflowGraph = {
  nodes: [
    { id: 'trigger', type: 'TRIGGER', position: { x: 0, y: 0 }, config: { intent: 'FAQ' } },
    { id: 'generate', type: 'AI_GENERATE', position: { x: 280, y: 0 }, config: {} },
    { id: 'end', type: 'END', position: { x: 560, y: 0 }, config: {} },
  ],
  edges: [
    { id: 'edge-1', source: 'trigger', target: 'generate' },
    { id: 'edge-2', source: 'generate', target: 'end' },
  ],
  settings: { maxSteps: 20, timeoutMs: 30_000 },
};

describe('Phase 05 Workflow editor helpers', () => {
  it('moves a node without mutating the current draft', () => {
    const moved = moveWorkflowNode(graph, 'generate', { x: 320, y: 120 });
    expect(moved.nodes.find((node) => node.id === 'generate')?.position).toEqual({ x: 320, y: 120 });
    expect(graph.nodes.find((node) => node.id === 'generate')?.position).toEqual({ x: 280, y: 0 });
  });

  it('lays out the directed graph by dependency level without changing graph semantics', () => {
    const arranged = autoLayoutWorkflowGraph(graph);
    expect(arranged.nodes.map((node) => node.position.x)).toEqual([60, 290, 520]);
    expect(arranged.edges).toEqual(graph.edges);
    expect(graph.nodes[1]?.position).toEqual({ x: 280, y: 0 });
  });

  it('adds and removes only allowlisted nodes and their connected edges', () => {
    const withNode = addWorkflowNode(graph, { id: 'approval', type: 'HUMAN_APPROVAL', position: { x: 420, y: 140 }, config: { action: 'REFUND' } });
    expect(withNode.nodes.some((node) => node.id === 'approval')).toBe(true);
    expect(() => addWorkflowNode(graph, { id: 'custom', type: 'CUSTOM' as never, position: { x: 0, y: 0 }, config: {} })).toThrow(/allowlist/i);
    expect(() => addWorkflowNode(graph, { id: 'generate', type: 'END', position: { x: 0, y: 0 }, config: {} })).toThrow(/duplicate/i);
    const removed = removeWorkflowNode(graph, 'generate');
    expect(removed.nodes.map((node) => node.id)).toEqual(['trigger', 'end']);
    expect(removed.edges).toEqual([]);
  });

  it('adds source-to-target edges, rejects missing endpoints and cycles, and removes edges', () => {
    const connected = addWorkflowEdge({ ...graph, edges: [] }, { id: 'edge-3', source: 'trigger', target: 'end' });
    expect(connected.edges).toEqual([{ id: 'edge-3', source: 'trigger', target: 'end' }]);
    expect(() => addWorkflowEdge(connected, { id: 'edge-4', source: 'end', target: 'trigger' })).toThrow(/cycle/i);
    expect(() => addWorkflowEdge(graph, { id: 'edge-3', source: 'missing', target: 'end' })).toThrow(/endpoint/i);
    expect(removeWorkflowEdge(graph, 'edge-1').edges).toEqual([{ id: 'edge-2', source: 'generate', target: 'end' }]);
  });

  it('requires unique true/false conditions for CONDITION branches', () => {
    const conditionGraph: WorkflowGraph = {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', position: { x: 0, y: 0 }, config: {} },
        { id: 'condition', type: 'CONDITION', position: { x: 220, y: 0 }, config: { expression: 'order.status != null' } },
        { id: 'yes', type: 'END', position: { x: 440, y: -60 }, config: {} },
        { id: 'no', type: 'END', position: { x: 440, y: 80 }, config: {} },
      ],
      edges: [{ id: 'trigger-condition', source: 'trigger', target: 'condition' }],
      settings: { maxSteps: 20, timeoutMs: 30_000 },
    };
    const withTrue = addWorkflowEdge(conditionGraph, { id: 'condition-true', source: 'condition', target: 'yes', condition: 'true' });
    const withBoth = addWorkflowEdge(withTrue, { id: 'condition-false', source: 'condition', target: 'no', condition: 'false' });
    expect(withBoth.edges.filter((edge) => edge.source === 'condition').map((edge) => edge.condition)).toEqual(['true', 'false']);
    expect(() => addWorkflowEdge(conditionGraph, { id: 'condition-missing', source: 'condition', target: 'yes' })).toThrow(/condition/i);
    expect(() => addWorkflowEdge(conditionGraph, { id: 'condition-other', source: 'condition', target: 'yes', condition: 'maybe' })).toThrow(/true.*false|branch/i);
    expect(() => addWorkflowEdge(withTrue, { id: 'condition-duplicate', source: 'condition', target: 'no', condition: 'true' })).toThrow(/unique|duplicate|branch/i);
  });

  it('updates the bounded node config/settings and detects a dirty draft', () => {
    const edited = updateWorkflowNodeConfig(graph, 'trigger', 'intent', 'PRODUCT_RECOMMENDATION');
    expect(edited.nodes[0]?.config).toEqual({ intent: 'PRODUCT_RECOMMENDATION' });
    expect(updateWorkflowNodeConfig(graph, 'generate', 'topN', 3).nodes[1]?.config).toEqual({ topN: 3 });
    expect(() => updateWorkflowNodeConfig(graph, 'trigger', 'arbitraryCode' as never, 'eval()')).toThrow(/editable/i);
    const settings = updateWorkflowSettings(graph, { maxSteps: 12, timeoutMs: 10_000 });
    expect(settings.settings).toEqual({ maxSteps: 12, timeoutMs: 10_000 });
    expect(() => updateWorkflowSettings(graph, { maxSteps: 0 })).toThrow(/settings/i);
    expect(workflowGraphEquals(graph, graph)).toBe(true);
    expect(workflowGraphEquals(graph, edited)).toBe(false);
  });

  it('only exposes human approval decisions while waiting for approval', () => {
    expect(isActionProposalDecisionEnabled('WAITING_APPROVAL')).toBe(true);
    for (const status of ['PROPOSED', 'POLICY_CHECKED', 'APPROVED', 'REVALIDATING', 'EXECUTING', 'SUCCEEDED', 'REJECTED', 'STALE', 'FAILED', 'UNCERTAIN', 'CANCELLED']) {
      expect(isActionProposalDecisionEnabled(status)).toBe(false);
    }
  });
});
