import { CustomerMemoryService } from '../src/replies/customer-memory.service';

describe('CustomerMemoryService', () => {
  const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a' };

  it('creates/lists memory only through workspace + tenant + shop + buyer predicates', async () => {
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      buyer: { findFirst: jest.fn().mockResolvedValue({ id: 'buyer-a' }) },
      customerMemory: {
        create: jest.fn().mockResolvedValue({ id: 'memory-a', status: 'ACTIVE' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new CustomerMemoryService(prisma as never);
    const input = { shopId: 'shop-a', type: 'PREFERENCE' as const, key: 'color', value: { preferred: 'black' } };

    await expect(service.create(scope, 'buyer-a', input)).resolves.toMatchObject({ id: 'memory-a', status: 'ACTIVE' });
    expect(prisma.customerMemory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', buyerId: 'buyer-a',
        type: 'PREFERENCE', key: 'color', valueJson: { preferred: 'black' }, status: 'ACTIVE',
        createdBy: 'HUMAN', updatedBy: 'HUMAN',
      }),
    });
    await service.list(scope, 'buyer-a', 'shop-a');
    expect(prisma.customerMemory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', buyerId: 'buyer-a', status: 'ACTIVE' }),
      orderBy: { updatedAt: 'desc' },
    }));
  });

  it('disables/deletes via the full row scope and never updates a same-id cross-shop row', async () => {
    const prisma = {
      customerMemory: {
        findFirst: jest.fn().mockResolvedValue({ id: 'memory-a', shopId: 'shop-a', buyerId: 'buyer-a' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new CustomerMemoryService(prisma as never);

    await expect(service.disable(scope, 'memory-a', 'shop-a')).resolves.toEqual({ id: 'memory-a', status: 'DISABLED' });
    expect(prisma.customerMemory.updateMany).toHaveBeenCalledWith({
      where: { id: 'memory-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', buyerId: 'buyer-a', status: 'ACTIVE' },
      data: { status: 'DISABLED', updatedBy: 'HUMAN' },
    });
    await expect(service.remove(scope, 'memory-a', 'shop-a')).resolves.toEqual({ id: 'memory-a', status: 'DELETED' });
    expect(prisma.customerMemory.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'memory-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a', buyerId: 'buyer-a', status: { not: 'DELETED' } },
      data: { status: 'DELETED', updatedBy: 'HUMAN' },
    });
  });

  it('treats shopId as immutable and refuses same-workspace cross-shop mutations before writes', async () => {
    const prisma = { customerMemory: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() } };
    const service = new CustomerMemoryService(prisma as never);
    const input = { shopId: 'shop-b', type: 'PREFERENCE' as const, key: 'color', value: { preferred: 'black' } };

    await expect(service.update(scope, 'memory-a', input)).rejects.toMatchObject({ response: { code: 'CUSTOMER_MEMORY_NOT_FOUND' } });
    await expect(service.disable(scope, 'memory-a', 'shop-b')).rejects.toMatchObject({ response: { code: 'CUSTOMER_MEMORY_NOT_FOUND' } });
    await expect(service.remove(scope, 'memory-a', 'shop-b')).rejects.toMatchObject({ response: { code: 'CUSTOMER_MEMORY_NOT_FOUND' } });
    expect(prisma.customerMemory.updateMany).not.toHaveBeenCalled();
    expect(prisma.customerMemory.findFirst).toHaveBeenCalledWith({
      where: { id: 'memory-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-b' }, select: { shopId: true, buyerId: true },
    });
  });

  it('excludes expired memories and rejects PII, dynamic facts, and subjective profiles before persistence', async () => {
    const prisma = {
      shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-a' }) },
      buyer: { findFirst: jest.fn().mockResolvedValue({ id: 'buyer-a' }) },
      customerMemory: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new CustomerMemoryService(prisma as never);

    await service.list(scope, 'buyer-a', 'shop-a');
    expect(prisma.customerMemory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }),
    }));
    await expect(service.create(scope, 'buyer-a', {
      shopId: 'shop-a', type: 'PREFERENCE', key: 'contact', value: { phone: '13800138000' },
    })).rejects.toMatchObject({ response: { code: 'CUSTOMER_MEMORY_FORBIDDEN_CONTENT' } });
    await expect(service.create(scope, 'buyer-a', {
      shopId: 'shop-a', type: 'ONGOING_CASE', key: 'order', value: { orderStatus: 'SHIPPED' },
    })).rejects.toMatchObject({ response: { code: 'CUSTOMER_MEMORY_FORBIDDEN_CONTENT' } });
    await expect(service.create(scope, 'buyer-a', {
      shopId: 'shop-a', type: 'PREFERENCE', key: 'persona', value: { personality: 'difficult customer' },
    })).rejects.toMatchObject({ response: { code: 'CUSTOMER_MEMORY_FORBIDDEN_CONTENT' } });
    expect(prisma.customerMemory.create).not.toHaveBeenCalled();
  });
});
