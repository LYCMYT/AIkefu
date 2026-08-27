import type { WorkflowDefinition, WorkflowNodeType } from '@ai-customer-service/core';

/**
 * Contracts use React-Flow style source/target edges while early seed data uses
 * from/to.  Normalize once at the persistence boundary so validation and the
 * executor always see the same closed graph language.
 */
export function normalizeWorkflowGraph(value: unknown): WorkflowDefinition & {
  nodes: Array<{ id: string; type: WorkflowNodeType; position: { x: number; y: number }; config: Record<string, unknown> }>;
  edges: Array<{ source: string; target: string; id: string; condition?: string }>;
} | null {
  if (!plainObject(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !plainObject(value.settings)) return null;
  const nodes = value.nodes.map((node, index) => ({
    id: plainObject(node) && typeof node.id === 'string' ? node.id : '',
    type: plainObject(node) ? node.type as WorkflowNodeType : '' as WorkflowNodeType,
    position: plainObject(node) && plainObject(node.position)
      && typeof node.position.x === 'number' && Number.isFinite(node.position.x)
      && typeof node.position.y === 'number' && Number.isFinite(node.position.y)
      ? { x: node.position.x, y: node.position.y }
      : { x: 80 + index * 240, y: 120 },
    config: plainObject(node) && plainObject(node.config) ? node.config : {},
  }));
  const edges = value.edges.map((edge, index) => {
    const source = plainObject(edge) && typeof edge.source === 'string' ? edge.source : plainObject(edge) && typeof edge.from === 'string' ? edge.from : '';
    const target = plainObject(edge) && typeof edge.target === 'string' ? edge.target : plainObject(edge) && typeof edge.to === 'string' ? edge.to : '';
    return {
      source,
      target,
      id: plainObject(edge) && typeof edge.id === 'string' && edge.id ? edge.id : `edge-${index}-${source}-${target}`,
      ...(plainObject(edge) && typeof edge.condition === 'string' ? { condition: edge.condition } : {}),
    };
  });
  const settings = value.settings as Record<string, unknown>;
  return {
    nodes,
    edges,
    settings: { maxSteps: settings.maxSteps as number, timeoutMs: settings.timeoutMs as number },
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
