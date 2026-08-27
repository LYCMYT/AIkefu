import { Controller, Get, Inject, Param } from '@nestjs/common';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { WorkspaceService } from '../workspaces/workspace.service';

@Controller('shops')
export class ShopsController {
  constructor(@Inject(WorkspaceService) private readonly workspaces: WorkspaceService) {}

  @Get()
  list(@CurrentWorkspace() context: AuthenticatedWorkspace) {
    return this.workspaces.listShops(context);
  }

  @Get(':shopId')
  get(@CurrentWorkspace() context: AuthenticatedWorkspace, @Param('shopId') shopId: string) {
    return this.workspaces.getShop(context, shopId);
  }
}
