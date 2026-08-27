import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { normalizeWorkflowGraph } from './workflow-graph';
import { WorkflowRuntimeService } from './workflow-runtime.service';

type Scope = WorkspaceScope & { shopId: string };

/** Routes each unowned Task to one published workflow; Runtime's updateMany CAS is the owner fence. */
@Injectable()
export class WorkflowRouterService {
  constructor(private readonly prisma: PrismaService, private readonly runtime: WorkflowRuntimeService) {}

  async route(scope: Scope, input: { conversationId: string; taskIds: string[] }) {
    const tasks = await this.prisma.task.findMany({
      where: { ...scope, conversationId: input.conversationId, id: { in: input.taskIds }, ownerWorkflowRunId: null },
      select: { id: true, intent: true, operation: true },
    });
    if (!tasks.length) return [];
    const workflows = (await this.prisma.workflow.findMany({
      where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, status: 'PUBLISHED', activeVersionId: { not: null } },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
      include: { versions: { where: { immutable: true }, orderBy: { version: 'desc' } } },
    })).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    const routed: Array<{ taskId: string; workflowId: string; runId: string; status: string }> = [];
    for (const task of tasks) {
      const workflow = workflows.find((entry) => matchesIntent(entry.versions.find((version) => version.id === entry.activeVersionId)?.graphJson, task.intent));
      if (!workflow) continue;
      try {
        const run = await this.runtime.start(scope, { workflowId: workflow.id, conversationId: input.conversationId, taskIds: [task.id] });
        routed.push({ taskId: task.id, workflowId: workflow.id, runId: run.id, status: String(run.status) });
      } catch (error) {
        // A competing router already owns this Task. That is normal at-least-
        // once delivery behavior; any other failure is deliberately surfaced.
        if (isOwnerConflict(error)) continue;
        throw error;
      }
    }
    return routed;
  }
}

function matchesIntent(rawGraph: unknown, intent: string): boolean {
  const graph = normalizeWorkflowGraph(rawGraph);
  const trigger = graph?.nodes.find((node) => node.type === 'TRIGGER');
  return trigger?.config?.intent === intent;
}

function isOwnerConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'response' in error
    && typeof (error as { response?: unknown }).response === 'object'
    && (error as { response?: { code?: unknown } }).response?.code === 'WORKFLOW_TASK_OWNER_CONFLICT';
}
