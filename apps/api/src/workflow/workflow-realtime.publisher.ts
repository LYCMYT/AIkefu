import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  ActionProposal,
  NodeRun,
  TypedWorkspaceEventEnvelope,
  WorkflowRun,
} from '@ai-customer-service/contracts';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { WorkspaceGateway } from '../websocket/workspace.gateway';
import {
  toWorkflowNodeRunDto,
  toWorkflowProposalDto,
  toWorkflowRunDto,
} from './workflow.dto';

type Scope = WorkspaceScope & { shopId: string };
type RecordValue = Record<string, unknown>;

/**
 * A deliberately one-way, post-commit refresh boundary for Workflow state.
 *
 * It has no dependency on the runtime/proposal services, so adding realtime
 * notifications cannot create a Runtime <-> Gateway circular dependency. The
 * caller is responsible for invoking it only after its database transaction
 * resolves. A missing/mismatched durable scope is fail-closed: no event is
 * emitted rather than risking a cross-workspace refresh.
 */
@Injectable()
export class WorkflowRealtimePublisher {
  private readonly versions = new Map<string, number>();

  constructor(@Optional() private readonly gateway?: WorkspaceGateway) {}

  publishRun(scope: Scope, raw: object): void {
    const value = asRecord(raw);
    if (!this.belongsTo(scope, value)) return;
    const workflowRun = toWorkflowRunDto(value) as unknown as WorkflowRun;
    if (!isWorkflowRun(workflowRun)) return;
    const event: TypedWorkspaceEventEnvelope<'WORKFLOW_RUN_UPDATED'> = {
      eventId: randomUUID(),
      eventType: 'WORKFLOW_RUN_UPDATED',
      workspaceId: scope.workspaceId,
      entityType: 'WORKFLOW_RUN',
      entityId: workflowRun.id,
      entityVersion: this.nextVersion(scope, 'WORKFLOW_RUN', workflowRun.id, value),
      occurredAt: new Date().toISOString(),
      payload: { workflowRun },
    };
    this.deliver(event);
  }

  publishNode(scope: Scope, raw: object): void {
    const value = asRecord(raw);
    if (!this.belongsTo(scope, value)) return;
    const nodeRun = cleanNodeDto(toWorkflowNodeRunDto(value)) as unknown as NodeRun;
    if (!isNodeRun(nodeRun)) return;
    const event: TypedWorkspaceEventEnvelope<'WORKFLOW_NODE_UPDATED'> = {
      eventId: randomUUID(),
      eventType: 'WORKFLOW_NODE_UPDATED',
      workspaceId: scope.workspaceId,
      entityType: 'WORKFLOW_NODE',
      entityId: nodeRun.id,
      entityVersion: this.nextVersion(scope, 'WORKFLOW_NODE', nodeRun.id, value),
      occurredAt: new Date().toISOString(),
      payload: { workflowRunId: nodeRun.workflowRunId, nodeRun },
    };
    this.deliver(event);
  }

  publishProposal(scope: Scope, raw: object): void {
    const value = asRecord(raw);
    if (!this.belongsTo(scope, value)) return;
    const proposal = cleanProposalDto(toWorkflowProposalDto(value)) as unknown as ActionProposal;
    if (!isActionProposal(proposal)) return;
    const event: TypedWorkspaceEventEnvelope<'ACTION_PROPOSAL_UPDATED'> = {
      eventId: randomUUID(),
      eventType: 'ACTION_PROPOSAL_UPDATED',
      workspaceId: scope.workspaceId,
      entityType: 'ACTION_PROPOSAL',
      entityId: proposal.id,
      entityVersion: this.nextVersion(scope, 'ACTION_PROPOSAL', proposal.id, value),
      occurredAt: new Date().toISOString(),
      payload: { proposal },
    };
    this.deliver(event);
  }

  private belongsTo(scope: Scope, value: RecordValue): boolean {
    return value.workspaceId === scope.workspaceId
      && value.tenantId === scope.tenantId
      && value.shopId === scope.shopId;
  }

  private nextVersion(scope: Scope, entityType: string, entityId: string, value: RecordValue): number {
    const key = `${scope.workspaceId}:${scope.tenantId}:${scope.shopId}:${entityType}:${entityId}`;
    const prior = this.versions.get(key) ?? 0;
    const durable = timestampVersion(value.updatedAt) ?? timestampVersion(value.createdAt) ?? timestampVersion(value.startedAt) ?? 1;
    const next = Math.max(durable, prior + 1);
    this.versions.set(key, next);
    return next;
  }

  private deliver(event: TypedWorkspaceEventEnvelope<keyof import('@ai-customer-service/contracts').WorkspaceEventPayloadMap>): void {
    try {
      // Realtime is advisory. PostgreSQL remains the source of truth and a
      // reconnect performs a scoped REST refresh if delivery is unavailable.
      this.gateway?.publish(event);
    } catch {
      // Never let a disconnected Socket.IO server turn a committed Workflow
      // transition into an application error.
    }
  }
}

function asRecord(value: object): RecordValue {
  return value as RecordValue;
}

function timestampVersion(value: unknown): number | undefined {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isSafeInteger(time) && time > 0 ? time : undefined;
}

function isWorkflowRun(value: WorkflowRun): boolean {
  return Boolean(value
    && typeof value.id === 'string'
    && typeof value.shopId === 'string'
    && typeof value.conversationId === 'string'
    && typeof value.workflowVersionId === 'string'
    && Array.isArray(value.taskIds)
    && Number.isSafeInteger(value.contextVersion)
    && Array.isArray(value.completedNodeIds)
    && typeof value.status === 'string'
    && typeof value.startedAt === 'string');
}

function isNodeRun(value: NodeRun): boolean {
  return Boolean(value
    && typeof value.id === 'string'
    && typeof value.workflowRunId === 'string'
    && typeof value.nodeId === 'string'
    && typeof value.status === 'string'
    && Number.isSafeInteger(value.retryCount));
}

function isActionProposal(value: ActionProposal): boolean {
  return Boolean(value
    && typeof value.id === 'string'
    && typeof value.shopId === 'string'
    && typeof value.conversationId === 'string'
    && typeof value.type === 'string'
    && typeof value.riskLevel === 'string'
    && typeof value.targetEntityType === 'string'
    && typeof value.targetEntityId === 'string'
    && Number.isSafeInteger(value.contextVersion)
    && typeof value.status === 'string');
}

function cleanNodeDto(value: RecordValue): RecordValue {
  const { workspaceId: _workspaceId, tenantId: _tenantId, shopId: _shopId, workflowRun: _workflowRun, ...dto } = value;
  return dto;
}

function cleanProposalDto(value: RecordValue): RecordValue {
  const { workflowRun: _workflowRun, conversation: _conversation, ...dto } = value;
  return dto;
}
