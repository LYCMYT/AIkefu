import { normalizeWorkflowGraph } from './workflow-graph';

/** Canonical API projection: Prisma `*Json` columns never escape these mappers. */
export function toWorkflowVersionDto(value: object): Record<string, unknown> {
  const { graphJson, publishedAt, createdAt, ...rest } = value as Record<string, unknown>;
  return { ...rest, graph: normalizeWorkflowGraph(graphJson) ?? graphJson, publishedAt: iso(publishedAt), createdAt: iso(createdAt) };
}

export function toWorkflowDto(value: object): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  const versions = Array.isArray(record.versions) ? record.versions.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object')) : [];
  const { versions: _versions, activeVersionId, createdAt, updatedAt, ...rest } = record;
  const active = typeof activeVersionId === 'string' ? versions.find((entry) => entry.id === activeVersionId) : undefined;
  const draft = versions.find((entry) => entry.immutable === false);
  return {
    ...rest, activeVersionId: activeVersionId ?? null,
    activeVersion: active ? toWorkflowVersionDto(active) : null,
    draftVersion: draft ? toWorkflowVersionDto(draft) : null,
    createdAt: iso(createdAt), updatedAt: iso(updatedAt),
  };
}

export function toWorkflowNodeRunDto(value: object): Record<string, unknown> {
  const { inputJson, outputJson, startedAt, finishedAt, createdAt, ...rest } = value as Record<string, unknown>;
  return { ...rest, input: inputJson ?? null, output: outputJson ?? null, startedAt: iso(startedAt), finishedAt: iso(finishedAt), createdAt: iso(createdAt) };
}

export function toWorkflowProposalDto(value: object): Record<string, unknown> {
  const { payloadJson, evidenceIdsJson, executionJson, receiptJson, approvedAt, decidedAt, executedAt, createdAt, updatedAt, ...rest } = value as Record<string, unknown>;
  return { ...rest, payload: payloadJson, evidenceIds: array(evidenceIdsJson), execution: executionJson ?? null, receipt: receiptJson ?? null, approvedAt: iso(approvedAt), decidedAt: iso(decidedAt), executedAt: iso(executedAt), createdAt: iso(createdAt), updatedAt: iso(updatedAt) };
}

export function toWorkflowRunDto(value: object): Record<string, unknown> {
  const { taskIdsJson, completedNodesJson, nodeRuns, proposals, startedAt, finishedAt, createdAt, updatedAt, ...rest } = value as Record<string, unknown>;
  return {
    ...rest, taskIds: array(taskIdsJson), completedNodeIds: array(completedNodesJson),
    nodeRuns: Array.isArray(nodeRuns) ? nodeRuns.map((entry) => toWorkflowNodeRunDto(entry as object)) : undefined,
    proposals: Array.isArray(proposals) ? proposals.map((entry) => toWorkflowProposalDto(entry as object)) : undefined,
    startedAt: iso(startedAt), finishedAt: iso(finishedAt), createdAt: iso(createdAt), updatedAt: iso(updatedAt),
  };
}

function array(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []; }
function iso(value: unknown): string | null | undefined { return value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : value === null ? null : undefined; }
