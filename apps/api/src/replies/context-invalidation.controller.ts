import { BadRequestException, Body, Controller, HttpCode, HttpStatus, NotFoundException, Param, Patch } from '@nestjs/common';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { ContextInvalidationService } from './context-invalidation.service';

/** Scoped synthetic sync commands for Phase 04 dynamic-fact invalidation. */
@Controller('shops/:shopId/dynamic-facts')
export class ContextInvalidationController {
  constructor(private readonly invalidation: ContextInvalidationService) {}

  @Patch('products/:productId/skus/:skuId/inventory')
  @HttpCode(HttpStatus.ACCEPTED)
  async inventory(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Param('skuId') skuId: string,
    @Body() input: { inventory?: number },
  ) {
    if (!Number.isSafeInteger(input?.inventory) || Number(input.inventory) < 0) throw inputError('SKU_INVENTORY_INVALID');
    const result = await this.invalidation.updateSkuInventory({ ...scope, shopId }, productId, skuId, Number(input.inventory));
    if (!result.updated) throw factNotFound();
    return { status: 'ACCEPTED' as const, operationId: `sku-inventory:${skuId}` };
  }

  @Patch('orders/:orderId/status')
  @HttpCode(HttpStatus.ACCEPTED)
  async orderStatus(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('shopId') shopId: string,
    @Param('orderId') orderId: string,
    @Body() input: { status?: string },
  ) {
    const status = input?.status?.trim();
    if (!status || !ORDER_STATUSES.has(status)) throw inputError('ORDER_STATUS_INVALID');
    const result = await this.invalidation.updateOrderStatus({ ...scope, shopId }, orderId, status);
    if (!result.updated) throw factNotFound();
    return { status: 'ACCEPTED' as const, operationId: `order-status:${orderId}` };
  }
}

const ORDER_STATUSES = new Set(['WAITING_SHIPMENT', 'SHIPPED', 'COMPLETED']);

function inputError(code: string): BadRequestException {
  return new BadRequestException({ code, message: code });
}

function factNotFound(): NotFoundException {
  return new NotFoundException({ code: 'DYNAMIC_FACT_NOT_FOUND', message: 'Dynamic fact not found in this Shop' });
}
