/** The deliberately small, closed V1 workflow language. */
export const WORKFLOW_NODE_TYPES = [
  'TRIGGER', 'CONDITION', 'QUERY_PRODUCT', 'QUERY_ORDER',
  'QUERY_LOGISTICS', 'AI_GENERATE', 'HUMAN_APPROVAL', 'END',
] as const;

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];
export type WorkflowNode = { id: string; type: WorkflowNodeType; config?: Record<string, unknown> };
/** Canonical persisted/API graph edge. Legacy from/to is normalized at import. */
export type WorkflowEdge = { source: string; target: string; id?: string; condition?: string };
export type WorkflowDefinition = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings: { maxSteps: number; timeoutMs: number };
};

export type WorkflowValidationError = {
  code:
    | 'NODE_TYPE_NOT_ALLOWED' | 'NODE_ID_INVALID' | 'TRIGGER_COUNT_INVALID'
    | 'END_NOT_REACHABLE' | 'ISOLATED_NODE' | 'CYCLE_NOT_ALLOWED'
    | 'MAX_STEPS_INVALID' | 'TIMEOUT_INVALID' | 'TOOL_NOT_ALLOWED'
    | 'HIGH_RISK_APPROVAL_REQUIRED' | 'EDGE_INVALID' | 'BRANCH_INVALID';
  nodeId?: string;
  edge?: WorkflowEdge;
};

export type WorkflowValidation = { valid: boolean; errors: WorkflowValidationError[] };

const allowedNodeTypes = new Set<string>(WORKFLOW_NODE_TYPES);
const allowedTools = new Set([
  'getProduct', 'getOrder', 'getLogistics', 'getInventory',
  'markRead', 'createInternalTask', 'transferHuman', 'addOrderRemark',
  'refund', 'compensation', 'exchange',
]);

/**
 * Validates before publish.  The validator intentionally knows nothing about
 * arbitrary JavaScript, loops, or external credentials: those constructs are
 * not part of the V1 language and can never reach the runtime.
 */
export function validateWorkflowGraph(definition: WorkflowDefinition): WorkflowValidation {
  const errors: WorkflowValidationError[] = [];
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (!node.id.trim() || ids.has(node.id)) errors.push({ code: 'NODE_ID_INVALID', nodeId: node.id });
    ids.add(node.id);
    if (!allowedNodeTypes.has(node.type)) errors.push({ code: 'NODE_TYPE_NOT_ALLOWED', nodeId: node.id });
    const tool = node.config?.tool;
    if (typeof tool === 'string' && !allowedTools.has(tool)) errors.push({ code: 'TOOL_NOT_ALLOWED', nodeId: node.id });
  }
  if (definition.nodes.filter((node) => node.type === 'TRIGGER').length !== 1) errors.push({ code: 'TRIGGER_COUNT_INVALID' });
  // maxSteps limits one executed path. A branching graph can legitimately
  // contain more nodes than any one path visits.
  if (!Number.isInteger(definition.settings.maxSteps) || definition.settings.maxSteps < 1 || definition.settings.maxSteps > 20) {
    errors.push({ code: 'MAX_STEPS_INVALID' });
  }
  if (!Number.isInteger(definition.settings.timeoutMs) || definition.settings.timeoutMs < 1 || definition.settings.timeoutMs > 30_000) errors.push({ code: 'TIMEOUT_INVALID' });

  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const edge of definition.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) {
      errors.push({ code: 'EDGE_INVALID', edge });
      continue;
    }
    adjacency.get(edge.source)!.push(edge.target);
  }
  for (const node of definition.nodes) {
    const outgoing = definition.edges.filter((edge) => edge.source === node.id);
    if (node.type === 'END') {
      if (outgoing.length !== 0) errors.push({ code: 'BRANCH_INVALID', nodeId: node.id });
      continue;
    }
    if (node.type !== 'CONDITION') {
      if (outgoing.length !== 1) errors.push({ code: 'BRANCH_INVALID', nodeId: node.id });
      continue;
    }
    const conditions = outgoing.map((edge) => edge.condition);
    // V1's sole branching primitive is a closed boolean condition. Requiring
    // both labels prevents a no-order/false result from falling off the graph
    // or silently reaching a later action through an arbitrary default.
    if (conditions.length !== 2 || conditions.some((condition) => typeof condition !== 'string' || !condition.trim()) || new Set(conditions).size !== conditions.length || !conditions.includes('true') || !conditions.includes('false')) {
      errors.push({ code: 'BRANCH_INVALID', nodeId: node.id });
    }
  }
  const trigger = definition.nodes.find((node) => node.type === 'TRIGGER');
  const reachable = trigger ? walk(trigger.id, adjacency) : new Set<string>();
  const ends = definition.nodes.filter((node) => node.type === 'END');
  if (!ends.length || !ends.some((end) => reachable.has(end.id))) errors.push({ code: 'END_NOT_REACHABLE' });
  for (const node of definition.nodes) {
    if (!reachable.has(node.id) || (node.type !== 'END' && !canReachEnd(node.id, adjacency, new Set(ends.map((end) => end.id))))) {
      errors.push({ code: 'ISOLATED_NODE', nodeId: node.id });
    }
  }
  const cyclic = hasCycle(adjacency);
  if (cyclic) errors.push({ code: 'CYCLE_NOT_ALLOWED' });
  if (trigger && !cyclic && longestPathLength(trigger.id, adjacency, new Map()) > definition.settings.maxSteps) {
    errors.push({ code: 'MAX_STEPS_INVALID' });
  }

  for (const node of definition.nodes) {
    if (!isHighRiskNode(node)) continue;
    if (canReachEndWithoutApproval(node.id, adjacency, new Set(ends.map((end) => end.id)), new Set(definition.nodes.filter((entry) => entry.type === 'HUMAN_APPROVAL').map((entry) => entry.id)))) {
      errors.push({ code: 'HIGH_RISK_APPROVAL_REQUIRED', nodeId: node.id });
    }
  }
  return { valid: errors.length === 0, errors };
}

function isHighRiskNode(node: WorkflowNode): boolean {
  if (node.type === 'HUMAN_APPROVAL') return false;
  const config = node.config ?? {};
  if (config.actionRisk === 'HIGH_RISK' || config.riskLevel === 'HIGH_RISK') return true;
  const action = typeof config.action === 'string' ? config.action : typeof config.tool === 'string' ? config.tool : '';
  return ['refund', 'compensation', 'exchange', 'PROPOSE_COMPENSATION', 'REFUND', 'EXCHANGE'].includes(action);
}

function longestPathLength(id: string, adjacency: Map<string, string[]>, memo: Map<string, number>): number {
  const known = memo.get(id);
  if (known !== undefined) return known;
  const children = adjacency.get(id) ?? [];
  const length = children.length ? 1 + Math.max(...children.map((child) => longestPathLength(child, adjacency, memo))) : 1;
  memo.set(id, length);
  return length;
}

function walk(start: string, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  return seen;
}

function canReachEnd(start: string, adjacency: Map<string, string[]>, ends: Set<string>): boolean {
  return [...walk(start, adjacency)].some((node) => ends.has(node));
}

function hasCycle(adjacency: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    const cyclic = (adjacency.get(id) ?? []).some(visit);
    visiting.delete(id);
    done.add(id);
    return cyclic;
  };
  return [...adjacency.keys()].some(visit);
}

function canReachEndWithoutApproval(start: string, adjacency: Map<string, string[]>, ends: Set<string>, approvals: Set<string>): boolean {
  const queue = [start];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current) || approvals.has(current)) continue;
    seen.add(current);
    if (ends.has(current)) return true;
    queue.push(...(adjacency.get(current) ?? []));
  }
  return false;
}
