import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { TraceService } from './trace.service';

@Controller()
export class TraceController {
  constructor(private readonly traces: TraceService) {}

  @Get('replies/:replyId/trace')
  reply(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('replyId') replyId: string, @Query('trace') trace?: string) {
    return this.traces.replyTrace(scope, replyId, trace === '1');
  }

  @Get('conversations/:conversationId/trace')
  conversation(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('conversationId') conversationId: string, @Query('trace') trace?: string) {
    return this.traces.conversationTrace(scope, conversationId, trace === '1');
  }
}
