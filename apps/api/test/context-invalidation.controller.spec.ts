import { ContextInvalidationController } from '../src/replies/context-invalidation.controller';

describe('ContextInvalidationController', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' } as never;

  it('routes scoped synthetic inventory/order changes through the durable invalidation writer', async () => {
    const invalidation = { updateSkuInventory: jest.fn().mockResolvedValue({ updated: true }), updateOrderStatus: jest.fn().mockResolvedValue({ updated: true }) };
    const controller = new ContextInvalidationController(invalidation as never);

    await expect(controller.inventory(scope, 'shop-a', 'product-a', 'sku-a', { inventory: 0 })).resolves.toEqual({ status: 'ACCEPTED', operationId: 'sku-inventory:sku-a' });
    await expect(controller.orderStatus(scope, 'shop-a', 'order-a', { status: 'SHIPPED' })).resolves.toEqual({ status: 'ACCEPTED', operationId: 'order-status:order-a' });
    expect(invalidation.updateSkuInventory).toHaveBeenCalledWith({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }, 'product-a', 'sku-a', 0);
    expect(invalidation.updateOrderStatus).toHaveBeenCalledWith({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' }, 'order-a', 'SHIPPED');
  });

  it('accepts only frozen order statuses and never acknowledges a scoped fact that was not updated', async () => {
    const invalidation = {
      updateSkuInventory: jest.fn().mockResolvedValue({ updated: false, invalidatedConversations: 0 }),
      updateOrderStatus: jest.fn().mockResolvedValue({ updated: false, invalidatedConversations: 0 }),
    };
    const controller = new ContextInvalidationController(invalidation as never);

    await expect(controller.orderStatus(scope, 'shop-a', 'order-a', { status: 'MADE_UP' })).rejects.toMatchObject({ response: { code: 'ORDER_STATUS_INVALID' } });
    await expect(controller.inventory(scope, 'shop-a', 'product-a', 'sku-a', { inventory: 2 })).rejects.toMatchObject({ response: { code: 'DYNAMIC_FACT_NOT_FOUND' } });
    await expect(controller.orderStatus(scope, 'shop-a', 'order-a', { status: 'SHIPPED' })).rejects.toMatchObject({ response: { code: 'DYNAMIC_FACT_NOT_FOUND' } });
  });
});
