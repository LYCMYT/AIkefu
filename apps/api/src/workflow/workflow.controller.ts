import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import {
  CreateWorkflowDto,
  WorkflowApproveDto,
  WorkflowGraphDto,
  WorkflowRejectDto,
  WorkflowTestRunDto,
} from '../common/request-dtos';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { WorkflowService } from './workflow.service';
import { WorkflowRuntimeService } from './workflow-runtime.service';
import { WorkflowProposalService } from './workflow-proposal.service';

@Controller()
export class WorkflowController {
  constructor(private readonly workflows: WorkflowService, private readonly runtime: WorkflowRuntimeService, private readonly proposals: WorkflowProposalService) {}

  @Get('workflows')
  list(@CurrentWorkspace() scope: AuthenticatedWorkspace) { return this.workflows.list(scope); }

  @Post('workflows')
  create(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Body() input: CreateWorkflowDto) {
    if (!input?.name?.trim() || !input?.type?.trim()) throw bad('WORKFLOW_NAME_TYPE_REQUIRED', 'name and type are required');
    return this.workflows.create(scope, { name: input.name.trim(), type: input.type.trim(), priority: input.priority });
  }

  @Get('workflows/:workflowId')
  get(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('workflowId') workflowId: string) { return this.workflows.get(scope, workflowId); }

  @Put('workflows/:workflowId/draft')
  updateDraft(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('workflowId') workflowId: string, @Body() graph: WorkflowGraphDto) {
    return this.workflows.updateDraft(scope, workflowId, graph as never);
  }

  @Post('workflows/:workflowId/publish')
  publish(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('workflowId') workflowId: string) { return this.workflows.publish(scope, workflowId); }

  @Post('workflows/:workflowId/enable')
  @HttpCode(HttpStatus.ACCEPTED)
  async enable(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('workflowId') workflowId: string) { await this.workflows.setEnabled(scope, workflowId, true); return accepted(workflowId); }

  @Post('workflows/:workflowId/disable')
  @HttpCode(HttpStatus.ACCEPTED)
  async disable(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('workflowId') workflowId: string) { await this.workflows.setEnabled(scope, workflowId, false); return accepted(workflowId); }

  @Post('workflows/:workflowId/test-run')
  @HttpCode(HttpStatus.ACCEPTED)
  async testRun(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('workflowId') workflowId: string, @Body() input: WorkflowTestRunDto) {
    const conversationId = required(input?.conversationId, 'CONVERSATION_ID_REQUIRED');
    const run = await this.runtime.start(await this.runtime.scopeForConversation(scope, conversationId), { workflowId, conversationId, taskIds: [] });
    return accepted(run.id);
  }

  @Get('workflow-runs')
  listRuns(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Query('shopId') shopId: string | undefined, @Query('workflowId') workflowId?: string, @Query('conversationId') conversationId?: string, @Query('status') status?: string) {
    return this.runtime.list({ ...scope, ...(shopId?.trim() ? { shopId: shopId.trim() } : {}) }, { workflowId, conversationId, status });
  }

  @Get('workflow-runs/:runId')
  async getRun(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('runId') runId: string) { return this.runtime.get(await this.runtime.scopeForRun(scope, runId), runId); }

  @Post('action-proposals/:proposalId/approve')
  @HttpCode(HttpStatus.ACCEPTED)
  async approve(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('proposalId') proposalId: string, @Body() input: WorkflowApproveDto) {
    await this.proposals.approve(await this.proposals.scopeForProposal(scope, proposalId), proposalId, { approvedBy: input?.approvedBy?.trim() || 'demo-operator', expectedContextVersion: input?.expectedContextVersion });
    return accepted(proposalId);
  }

  @Post('action-proposals/:proposalId/reject')
  @HttpCode(HttpStatus.ACCEPTED)
  async reject(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('proposalId') proposalId: string, @Body() input: WorkflowRejectDto) {
    await this.proposals.reject(await this.proposals.scopeForProposal(scope, proposalId), proposalId, { reason: input?.reason, rejectedBy: 'demo-operator' });
    return accepted(proposalId);
  }
}

function required(value: string | undefined, code: string) { if (!value?.trim()) throw bad(code, 'conversationId is required'); return value.trim(); }
function accepted(operationId: string) { return { status: 'ACCEPTED' as const, operationId }; }
function bad(code: string, message: string) { return new BadRequestException({ code, message }); }
