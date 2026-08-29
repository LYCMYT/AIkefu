import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import { Public } from '../auth/public.decorator';
import type { AuthenticatedWorkspace } from './workspace.repository';
import { WorkspaceService } from './workspace.service';
import { DemoWorkspaceProfileDto } from '../common/request-dtos';

@Controller()
export class WorkspaceController {
  constructor(@Inject(WorkspaceService) private readonly workspaces: WorkspaceService) {}

  @Public()
  @Post('demo/workspaces')
  create(@Body() input?: DemoWorkspaceProfileDto) {
    return this.workspaces.create(input?.profile);
  }

  @Get('demo/workspaces/current')
  current(@CurrentWorkspace() context: AuthenticatedWorkspace) {
    return this.workspaces.current(context);
  }

  @Post('demo/workspaces/current/reset')
  @HttpCode(HttpStatus.ACCEPTED)
  async reset(@CurrentWorkspace() context: AuthenticatedWorkspace, @Body() input?: DemoWorkspaceProfileDto) {
    await this.workspaces.reset(context, input?.profile);
    return { operationId: `reset_${randomUUID()}`, status: 'ACCEPTED' };
  }

  @Get('bootstrap')
  bootstrap(@CurrentWorkspace() context: AuthenticatedWorkspace) {
    return this.workspaces.bootstrap(context);
  }
}
