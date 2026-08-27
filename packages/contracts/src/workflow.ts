import type { IsoDateTime } from './workspace';
import type { ActionProposal } from './incident';

/** The finite V1 graph vocabulary. TEMPLATE_REPLY remains intentionally out of scope. */
export const WORKFLOW_NODE_TYPES = [
  'TRIGGER',
  'CONDITION',
  'QUERY_PRODUCT',
  'QUERY_ORDER',
  'QUERY_LOGISTICS',
  'AI_GENERATE',
  'HUMAN_APPROVAL',
  'END',
] as const;

/** CONDITION runtime output is a closed two-way branch in V1. */
export const WORKFLOW_BRANCH_CONDITIONS = ['true', 'false'] as const;
export type WorkflowBranchCondition = typeof WORKFLOW_BRANCH_CONDITIONS[number];

export type WorkflowNodeType = typeof WORKFLOW_NODE_TYPES[number];

export const WORKFLOW_STATUSES = ['DRAFT', 'PUBLISHED', 'DISABLED'] as const;
export type WorkflowStatus = typeof WORKFLOW_STATUSES[number];

export const WORKFLOW_RUN_STATUSES = [
  'PENDING',
  'RUNNING',
  'WAITING_APPROVAL',
  'RECOVERING',
  'COMPLETED',
  'FAILED',
  'STALE',
  'CANCELLED',
] as const;
export type WorkflowRunStatus = typeof WORKFLOW_RUN_STATUSES[number];

export const WORKFLOW_NODE_RUN_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'WAITING_APPROVAL', 'STALE', 'SKIPPED'] as const;
export type WorkflowNodeRunStatus = typeof WORKFLOW_NODE_RUN_STATUSES[number];

export interface WorkflowSettings {
  maxSteps: number;
  timeoutMs: number;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  condition?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings: WorkflowSettings;
}

export interface Workflow {
  id: string;
  workspaceId?: string;
  tenantId?: string;
  shopId?: string | null;
  name: string;
  type: string;
  priority: number;
  status: WorkflowStatus;
  activeVersionId?: string | null;
  draftVersion?: WorkflowVersion | null;
  activeVersion?: WorkflowVersion | null;
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
}

export interface WorkflowVersion {
  id: string;
  workspaceId?: string;
  tenantId?: string;
  workflowId: string;
  version: number;
  graph: WorkflowGraph;
  publishedAt?: IsoDateTime | null;
  createdAt?: IsoDateTime;
}

export interface NodeRun {
  id: string;
  workflowRunId: string;
  nodeId: string;
  status: WorkflowNodeRunStatus;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  errorCode?: string | null;
  retryCount: number;
  startedAt?: IsoDateTime | null;
  finishedAt?: IsoDateTime | null;
  durationMs?: number | null;
}

export interface WorkflowRun {
  id: string;
  workspaceId?: string;
  tenantId?: string;
  shopId: string;
  conversationId: string;
  workflowVersionId: string;
  taskIds: string[];
  contextVersion: number;
  currentNodeId?: string | null;
  completedNodeIds: string[];
  status: WorkflowRunStatus;
  startedAt: IsoDateTime;
  finishedAt?: IsoDateTime | null;
  updatedAt?: IsoDateTime;
  nodeRuns?: NodeRun[];
  proposals?: ActionProposal[];
}

export interface WorkflowRunFilter {
  workflowId?: string;
  conversationId?: string;
  status?: WorkflowRunStatus;
}

export interface CreateWorkflowInput {
  name: string;
  type: string;
  shopId?: string;
  priority?: number;
}

export interface WorkflowTestRunInput {
  conversationId: string;
}

export function isWorkflowNodeType(value: unknown): value is WorkflowNodeType {
  return typeof value === 'string' && (WORKFLOW_NODE_TYPES as readonly string[]).includes(value);
}

export function isWorkflowGraph(value: unknown): value is WorkflowGraph {
  if (!plainObject(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false;
  const settings = value.settings;
  if (!plainObject(settings)
    || !safeInteger(settings.maxSteps)
    || settings.maxSteps < 1
    || settings.maxSteps > 20
    || !safeInteger(settings.timeoutMs)
    || settings.timeoutMs < 1
    || settings.timeoutMs > 30_000) return false;

  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!plainObject(node)
      || typeof node.id !== 'string'
      || !node.id
      || nodeIds.has(node.id)
      || !isWorkflowNodeType(node.type)
      || !plainObject(node.position)
      || !finiteNumber(node.position.x)
      || !finiteNumber(node.position.y)
      || !plainObject(node.config)) return false;
    nodeIds.add(node.id);
  }
  const conditionBranches = new Set<string>();
  return value.edges.every((edge) => plainObject(edge)
    && typeof edge.id === 'string'
    && typeof edge.source === 'string'
    && typeof edge.target === 'string'
    && nodeIds.has(edge.source)
    && nodeIds.has(edge.target)
    && (edge.condition === undefined || typeof edge.condition === 'string')
    && (() => {
      const source = value.nodes.find((node: Record<string, any>) => plainObject(node) && node.id === edge.source);
      if (!source || source.type !== 'CONDITION') return true;
      if (!(WORKFLOW_BRANCH_CONDITIONS as readonly string[]).includes(edge.condition as string)) return false;
      const branchKey = `${edge.source}:${edge.condition}`;
      if (conditionBranches.has(branchKey)) return false;
      conditionBranches.add(branchKey);
      return true;
    })());
}

function plainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}
