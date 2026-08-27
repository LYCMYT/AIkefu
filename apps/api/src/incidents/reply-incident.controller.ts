import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { ReplyIncidentService } from './reply-incident.service';
@Controller() export class ReplyIncidentController {
  constructor(private readonly incidents: ReplyIncidentService) {}
  @Post('replies/:replyId/incidents')
  async create(@CurrentWorkspace() s: AuthenticatedWorkspace, @Param('replyId') replyId: string, @Body() b: {errorType:string;severity:string}) {
    const context = await this.incidents.contextForReply(s, replyId);
    return this.incidents.create(context, { ...b, replyMessageId: replyId, conversationId: context.conversationId });
  }
  @Get('incidents') list(@CurrentWorkspace() s: AuthenticatedWorkspace, @Query('conversationId') conversationId?: string, @Query('status') status?: string, @Query('severity') severity?: string) {
    return this.incidents.list(s, { ...(conversationId?.trim() ? { conversationId: conversationId.trim() } : {}), ...(status !== undefined ? { status } : {}), ...(severity !== undefined ? { severity } : {}) });
  }
  @Post('incidents/:id/root-cause') @HttpCode(HttpStatus.ACCEPTED)
  async root(@CurrentWorkspace() s: AuthenticatedWorkspace,@Param('id') id:string,@Body() b:{rootCause:string}) { const incident = await this.incidents.rootCause(await this.incidents.scopeForIncident(s, id), id, b.rootCause); return { status: 'ACCEPTED' as const, operationId: incident.id }; }
  @Post('incidents/:id/correction') @HttpCode(HttpStatus.ACCEPTED)
  async correction(@CurrentWorkspace() s: AuthenticatedWorkspace,@Param('id') id:string,@Body() b:{correctedAnswer:string;sendToBuyer:boolean}) {
    const result = await this.incidents.correction(await this.incidents.scopeForIncident(s, id), id, b);
    return { ...result, operationId: result.sendOutboxId ?? result.incidentId };
  }
  @Post('incidents/:id/add-regression') @HttpCode(HttpStatus.ACCEPTED)
  async regression(@CurrentWorkspace() s: AuthenticatedWorkspace,@Param('id') id:string,@Body() b:{caseId?:string}) { const result = await this.incidents.regression(await this.incidents.scopeForIncident(s, id), id, b); return { status: 'ACCEPTED' as const, operationId: result.incident.id, evalCaseId: result.evalCaseId }; }
  @Post('incidents/:id/resolve') @HttpCode(HttpStatus.ACCEPTED)
  async resolve(@CurrentWorkspace() s: AuthenticatedWorkspace,@Param('id') id:string) { const incident = await this.incidents.resolve(await this.incidents.scopeForIncident(s, id),id); return { status: 'ACCEPTED' as const, operationId: incident.id }; }
}
