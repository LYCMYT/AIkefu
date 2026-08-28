import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import { ShopAiModeDto, ShopCreateDto } from '../common/request-dtos';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { WorkspaceService } from '../workspaces/workspace.service';

@Controller('shops')
export class ShopsController {
  constructor(@Inject(WorkspaceService) private readonly workspaces: WorkspaceService) {}

  @Get()
  list(@CurrentWorkspace() context: AuthenticatedWorkspace) {
    return this.workspaces.listShops(context);
  }

  @Post()
  create(@CurrentWorkspace() context: AuthenticatedWorkspace, @Body() input: ShopCreateDto) {
    return this.workspaces.createShop(context, input ?? {});
  }

  @Get(':shopId')
  get(@CurrentWorkspace() context: AuthenticatedWorkspace, @Param('shopId') shopId: string) {
    return this.workspaces.getShop(context, shopId);
  }


  @Patch(':shopId/ai-mode')
  setAiMode(
    @CurrentWorkspace() context: AuthenticatedWorkspace,
    @Param('shopId') shopId: string,
    @Body() input: ShopAiModeDto,
  ) {
    return this.workspaces.setShopAiMode(context, shopId, input.mode);
  }
}
