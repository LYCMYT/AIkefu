import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { CustomerMemoryInput } from '@ai-customer-service/contracts';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { CustomerMemoryService } from './customer-memory.service';

@Controller('buyers')
export class CustomerMemoryController {
  constructor(private readonly memories: CustomerMemoryService) {}

  @Get(':buyerId/memories')
  list(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('buyerId') buyerId: string,
    @Query('shopId') shopId?: string,
  ) {
    if (!shopId) throw new BadRequestException({ code: 'SHOP_ID_REQUIRED', message: 'shopId is required' });
    return this.memories.list(scope, buyerId, shopId);
  }

  @Post(':buyerId/memories')
  create(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('buyerId') buyerId: string,
    @Body() input: CustomerMemoryInput,
  ) {
    return this.memories.create(scope, buyerId, input);
  }
}

@Controller('memories')
export class MemoryMutationController {
  constructor(private readonly memories: CustomerMemoryService) {}

  @Patch(':memoryId')
  update(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('memoryId') memoryId: string, @Body() input: CustomerMemoryInput) {
    return this.memories.update(scope, memoryId, input);
  }

  @Post(':memoryId/disable')
  disable(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('memoryId') memoryId: string, @Body() input: { shopId?: string }) {
    return this.memories.disable(scope, memoryId, requiredShopId(input?.shopId));
  }

  @Delete(':memoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('memoryId') memoryId: string, @Query('shopId') shopId?: string): Promise<void> {
    await this.memories.remove(scope, memoryId, requiredShopId(shopId));
  }
}

function requiredShopId(value?: string): string {
  if (!value?.trim()) throw new BadRequestException({ code: 'SHOP_ID_REQUIRED', message: 'shopId is required' });
  return value.trim();
}
