import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { WorkflowRuntimeService } from './workflow-runtime.service';
import { ReplyRuntimeService } from '../replies/reply-runtime.service';
import { WorkflowRealtimePublisher } from './workflow-realtime.publisher';

type Scope = WorkspaceScope & { shopId: string };
type Tx = Record<string, any>;

/**
 * Approval boundary for workflow ActionProposals. V1 deliberately records a
 * deterministic mock receipt only; it has no platform credentials or writes.
 */
@Injectable()
export class WorkflowProposalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime?: WorkflowRuntimeService,
    @Optional() private readonly replyRuntime?: ReplyRuntimeService,
    @Optional() private readonly realtime?: WorkflowRealtimePublisher,
  ) {}

  async approve(scope: Scope, proposalId: string, input: { approvedBy: string; expectedContextVersion?: number } ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const db = tx as Tx;
      const proposal = await db.workflowProposal.findFirst({
        where: { id: proposalId, ...scope, status: 'WAITING_APPROVAL' },
        include: { workflowRun: { select: { completedNodesJson: true } }, conversation: { select: { buyerId: true } } },
      });
      if (!proposal) throw new NotFoundException({ code: 'WORKFLOW_PROPOSAL_NOT_FOUND', message: 'Proposal is not waiting for approval in this Shop' });
      if (input.expectedContextVersion !== undefined && input.expectedContextVersion !== proposal.contextVersion) {
        return this.markStale(db, scope, proposal, 'EXPECTED_CONTEXT_VERSION_MISMATCH');
      }
      const marked = await db.workflowProposal.updateMany({
        where: { id: proposal.id, ...scope, status: 'WAITING_APPROVAL', contextVersion: proposal.contextVersion },
        data: { status: 'REVALIDATING', approvedBy: input.approvedBy, approvedAt: new Date(), decidedAt: new Date() },
      });
      if (marked.count !== 1) throw new NotFoundException({ code: 'WORKFLOW_PROPOSAL_NOT_FOUND', message: 'Proposal is no longer available' });

      const conversation = await db.conversation.findFirst({ where: { id: proposal.conversationId, ...scope }, select: { id: true, contextVersion: true } });
      if (!conversation || conversation.contextVersion !== proposal.contextVersion) return this.markStale(db, scope, proposal, 'CONVERSATION_CONTEXT_STALE');
      const targetExists = await this.targetExists(db, scope, proposal);
      if (!targetExists) return this.markStale(db, scope, proposal, 'PROPOSAL_TARGET_STALE');

      const executing = await db.workflowProposal.updateMany({
        where: { id: proposal.id, ...scope, status: 'REVALIDATING', contextVersion: proposal.contextVersion },
        data: { status: 'EXECUTING' },
      });
      if (executing.count !== 1) throw new NotFoundException({ code: 'WORKFLOW_PROPOSAL_NOT_FOUND', message: 'Proposal execution claim was lost' });

      // Explicitly a synthetic receipt: no refund/exchange/other platform API
      // is called from demo code. A success state is impossible without this.
      const receipt = { kind: 'MOCK_RECEIPT', receiptId: `mock:${randomUUID()}`, proposalId: proposal.id, executedAt: new Date().toISOString() };
      const finished = await db.workflowProposal.updateMany({
        where: { id: proposal.id, ...scope, status: 'EXECUTING', contextVersion: proposal.contextVersion },
        data: { status: 'SUCCEEDED', executionJson: { adapter: 'MOCK_DOYIN', riskLevel: proposal.riskLevel }, receiptJson: receipt, executedAt: new Date() },
      });
      if (finished.count !== 1) throw new NotFoundException({ code: 'WORKFLOW_PROPOSAL_NOT_FOUND', message: 'Proposal execution was not committed' });
      const completed = Array.isArray(proposal.workflowRun?.completedNodesJson) ? proposal.workflowRun.completedNodesJson.filter((id: unknown): id is string => typeof id === 'string') : [];
      if (!completed.includes(proposal.nodeId)) completed.push(proposal.nodeId);
      await db.workflowNodeRun?.updateMany?.({ where: { workflowRunId: proposal.workflowRunId, nodeId: proposal.nodeId, status: 'WAITING_APPROVAL' }, data: { status: 'SUCCEEDED', outputJson: { receipt }, finishedAt: new Date() } });
      await db.workflowRun.updateMany?.({ where: { id: proposal.workflowRunId, ...scope, status: 'WAITING_APPROVAL' }, data: { status: 'RECOVERING', currentNodeId: proposal.nodeId, completedNodesJson: completed } });
      await db.auditLog.create?.({ data: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, action: 'WORKFLOW_PROPOSAL_EXECUTED', entityType: 'WORKFLOW_PROPOSAL', entityId: proposal.id, metadataJson: { shopId: scope.shopId, type: proposal.type, mockReceipt: true } } });
      return { ...proposal, status: 'SUCCEEDED' as const, receiptJson: receipt, workflowRunId: proposal.workflowRunId };
    });
    await this.publishProposal(scope, proposalId, result);
    if (result.status === 'SUCCEEDED' && this.runtime) {
      const recovered = await this.runtime.recover(scope, result.workflowRunId).catch(() => undefined);
      if (recovered?.status === 'COMPLETED') {
        const replyJobId = await this.resumeReplyAfterWorkflow(scope, result.workflowRunId);
        if (replyJobId) await this.replyRuntime?.process(scope, replyJobId);
      }
    }
    return result;
  }

  async scopeForProposal(scope: WorkspaceScope, proposalId: string): Promise<Scope> {
    const proposal = await this.prisma.workflowProposal.findFirst({ where: { id: proposalId, ...scope }, select: { shopId: true } });
    if (!proposal) throw new NotFoundException({ code: 'WORKFLOW_PROPOSAL_NOT_FOUND', message: 'Proposal not found in this Workspace' });
    return { ...scope, shopId: proposal.shopId };
  }

  async reject(scope: Scope, proposalId: string, input: { reason?: string; rejectedBy?: string } = {}) {
    const result = await this.prisma.$transaction(async (tx) => {
      const db = tx as Tx;
      const proposal = await db.workflowProposal.findFirst({ where: { id: proposalId, ...scope, status: 'WAITING_APPROVAL' } });
      if (!proposal) throw new NotFoundException({ code: 'WORKFLOW_PROPOSAL_NOT_FOUND', message: 'Proposal is not waiting for approval in this Shop' });
      const result = await db.workflowProposal.updateMany({
        where: { id: proposal.id, ...scope, status: 'WAITING_APPROVAL' },
        data: { status: 'REJECTED', rejectedReason: input.reason?.slice(0, 500) ?? null, decidedAt: new Date(), approvedBy: input.rejectedBy ?? null },
      });
      if (result.count !== 1) throw new NotFoundException({ code: 'WORKFLOW_PROPOSAL_NOT_FOUND', message: 'Proposal is not waiting for approval in this Shop' });
      await db.workflowNodeRun?.updateMany?.({ where: { workflowRunId: proposal.workflowRunId, nodeId: proposal.nodeId, status: 'WAITING_APPROVAL' }, data: { status: 'FAILED', errorCode: 'WORKFLOW_PROPOSAL_REJECTED', finishedAt: new Date() } });
      await db.workflowRun.updateMany?.({ where: { id: proposal.workflowRunId, ...scope, status: 'WAITING_APPROVAL' }, data: { status: 'CANCELLED', finishedAt: new Date() } });
      await db.task?.updateMany?.({ where: { ...scope, ownerWorkflowRunId: proposal.workflowRunId, status: 'RUNNING' }, data: { status: 'CANCELLED', errorCode: 'WORKFLOW_PROPOSAL_REJECTED' } });
      return { id: proposalId, status: 'REJECTED' as const };
    });
    await this.publishProposal(scope, proposalId, result);
    return result;
  }

  private async markStale(tx: Tx, scope: Scope, proposal: Record<string, any>, failureCode: string) {
    await tx.workflowProposal.updateMany({
      where: { id: proposal.id, ...scope, status: { in: ['WAITING_APPROVAL', 'REVALIDATING'] }, contextVersion: proposal.contextVersion },
      data: { status: 'STALE', failureCode, decidedAt: new Date() },
    });
    await tx.workflowRun.updateMany?.({
      where: { id: proposal.workflowRunId, ...scope, status: { in: ['WAITING_APPROVAL', 'RUNNING', 'RECOVERING'] } },
      data: { status: 'STALE', finishedAt: new Date() },
    });
    await tx.task?.updateMany?.({
      where: { ...scope, ownerWorkflowRunId: proposal.workflowRunId, status: 'RUNNING' },
      data: { status: 'SUPERSEDED', errorCode: failureCode },
    });
    return { ...proposal, status: 'STALE' };
  }

  private async targetExists(tx: Tx, scope: Scope, proposal: Record<string, any>): Promise<boolean> {
    if (proposal.targetEntityType === 'CONVERSATION') return proposal.targetEntityId === proposal.conversationId;
    if (proposal.targetEntityType === 'ORDER') {
      const buyerId = proposal.conversation?.buyerId;
      if (!buyerId) return false;
      const order = await tx.order?.findFirst({ where: { id: proposal.targetEntityId, ...scope, buyerId }, select: { id: true, version: true, status: true } });
      const snapshot = proposal.payloadJson && typeof proposal.payloadJson === 'object' ? (proposal.payloadJson as Record<string, any>).sourceSnapshot : undefined;
      return Boolean(order) && Boolean(snapshot) && snapshot.orderId === order.id && snapshot.version === order.version && snapshot.status === order.status;
    }
    if (proposal.targetEntityType === 'PRODUCT') {
      const product = await tx.product?.findFirst({ where: { id: proposal.targetEntityId, ...scope }, select: { id: true, status: true, contentHash: true } });
      const snapshot = proposal.payloadJson && typeof proposal.payloadJson === 'object' ? (proposal.payloadJson as Record<string, any>).sourceSnapshot : undefined;
      return Boolean(product) && Boolean(snapshot) && snapshot.productId === product.id && snapshot.status === product.status && snapshot.contentHash === (product.contentHash ?? null);
    }
    if (proposal.targetEntityType === 'TASK') return Boolean(await tx.task?.findFirst({ where: { id: proposal.targetEntityId, ...scope, conversationId: proposal.conversationId }, select: { id: true } }));
    return false;
  }

  private async resumeReplyAfterWorkflow(scope: Scope, workflowRunId: string): Promise<string | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const db = tx as Tx;
      const task = await db.task?.findFirst?.({
        where: { ...scope, ownerWorkflowRunId: workflowRunId },
        select: { userTurnId: true, conversationId: true },
      });
      if (!task?.userTurnId) return undefined;
      const replyJob = await db.replyJob?.findFirst?.({
        where: {
          ...scope,
          conversationId: task.conversationId,
          userTurnId: task.userTurnId,
          status: 'WAITING_HUMAN',
          staleReason: 'WORKFLOW_APPROVAL_REQUIRED',
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, sourceContextVersion: true },
      });
      if (!replyJob) return undefined;
      const reopened = await db.replyJob.updateMany({
        where: { id: replyJob.id, ...scope, status: 'WAITING_HUMAN', staleReason: 'WORKFLOW_APPROVAL_REQUIRED' },
        data: { status: 'RECOVERY_PENDING', staleReason: null },
      });
      if (reopened.count !== 1) return undefined;
      await db.replyDraft?.updateMany?.({
        where: { ...scope, replyJobId: replyJob.id, status: 'WAITING_HUMAN' },
        data: { status: 'STALE', staleReason: 'WORKFLOW_APPROVED' },
      });
      return replyJob.id as string;
    });
  }

  private async publishProposal(scope: Scope, proposalId: string, fallback: object): Promise<void> {
    if (!this.realtime) return;
    try {
      const repository = this.prisma as unknown as { workflowProposal?: { findFirst(input: unknown): Promise<object | null> } };
      const durable = await repository.workflowProposal?.findFirst?.({ where: { id: proposalId, ...scope } });
      this.realtime.publishProposal(scope, durable ?? fallback);
    } catch {
      // Realtime is advisory and must not change an approval decision.
    }
  }
}
