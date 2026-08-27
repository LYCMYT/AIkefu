import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sanitizeContext } from '@ai-customer-service/core';
import { Prisma, type CustomerMemory } from '@prisma/client';
import type { CustomerMemoryInput } from '@ai-customer-service/contracts';
import { PrismaService } from '../database/prisma.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';

@Injectable()
export class CustomerMemoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: WorkspaceScope, buyerId: string, shopId: string): Promise<CustomerMemory[]> {
    return this.prisma.customerMemory.findMany({
      where: {
        ...scope, shopId, buyerId, status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async create(scope: WorkspaceScope, buyerId: string, input: CustomerMemoryInput): Promise<CustomerMemory> {
    validateMemory(input);
    const [shop, buyer] = await Promise.all([
      this.prisma.shop.findFirst({ where: { id: input.shopId, ...scope }, select: { id: true } }),
      this.prisma.buyer.findFirst({ where: { id: buyerId, ...scope }, select: { id: true } }),
    ]);
    if (!shop || !buyer) throw memoryNotFound();
    return this.prisma.customerMemory.create({
      data: {
        ...scope,
        shopId: input.shopId,
        buyerId,
        type: input.type,
        key: input.key.trim(),
        valueJson: cloneJson(input.value),
        status: 'ACTIVE',
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: 'HUMAN',
        updatedBy: 'HUMAN',
      },
    });
  }

  async update(scope: WorkspaceScope, memoryId: string, input: CustomerMemoryInput): Promise<CustomerMemory> {
    validateMemory(input);
    const row = await this.locate(scope, memoryId, input.shopId);
    const updated = await this.prisma.customerMemory.updateMany({
      where: { id: memoryId, ...scope, shopId: row.shopId, buyerId: row.buyerId, status: { not: 'DELETED' } },
      data: {
        type: input.type,
        key: input.key.trim(),
        valueJson: cloneJson(input.value),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        updatedBy: 'HUMAN',
      },
    });
    if (!updated.count) throw memoryNotFound();
    const memory = await this.prisma.customerMemory.findFirst({ where: { id: memoryId, ...scope, shopId: input.shopId, buyerId: row.buyerId } });
    if (!memory) throw memoryNotFound();
    return memory;
  }

  async disable(scope: WorkspaceScope, memoryId: string, shopId: string): Promise<{ id: string; status: 'DISABLED' }> {
    const row = await this.locate(scope, memoryId, shopId);
    const result = await this.prisma.customerMemory.updateMany({
      where: { id: memoryId, ...scope, shopId: row.shopId, buyerId: row.buyerId, status: 'ACTIVE' },
      data: { status: 'DISABLED', updatedBy: 'HUMAN' },
    });
    if (!result.count) throw memoryNotFound();
    return { id: memoryId, status: 'DISABLED' };
  }

  async remove(scope: WorkspaceScope, memoryId: string, shopId: string): Promise<{ id: string; status: 'DELETED' }> {
    const row = await this.locate(scope, memoryId, shopId);
    const result = await this.prisma.customerMemory.updateMany({
      where: { id: memoryId, ...scope, shopId: row.shopId, buyerId: row.buyerId, status: { not: 'DELETED' } },
      data: { status: 'DELETED', updatedBy: 'HUMAN' },
    });
    if (!result.count) throw memoryNotFound();
    return { id: memoryId, status: 'DELETED' };
  }

  private async locate(scope: WorkspaceScope, memoryId: string, shopId: string): Promise<{ shopId: string; buyerId: string }> {
    const row = await this.prisma.customerMemory.findFirst({
      where: { id: memoryId, ...scope, shopId },
      select: { shopId: true, buyerId: true },
    });
    if (!row) throw memoryNotFound();
    return row;
  }
}

function validateMemory(input: CustomerMemoryInput): void {
  if (!input?.shopId || !input.key?.trim() || !input.value || !['PREFERENCE', 'PRODUCT_PREFERENCE', 'ONGOING_CASE'].includes(input.type)) {
    throw new BadRequestException({ code: 'CUSTOMER_MEMORY_INVALID', message: 'Customer memory input is invalid' });
  }
  if (input.expiresAt && Number.isNaN(new Date(input.expiresAt).getTime())) {
    throw new BadRequestException({ code: 'CUSTOMER_MEMORY_INVALID', message: 'Customer memory expiry is invalid' });
  }
  if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) {
    throw new BadRequestException({ code: 'CUSTOMER_MEMORY_INVALID', message: 'Customer memory expiry must be in the future' });
  }
  // Customer memory is deliberately a tiny, human-maintained preference/case
  // store.  It is never a second copy of messages or operational truth.
  const sanitized = sanitizeContext({ key: input.key, value: input.value }, ['key', 'value']);
  const content = `${input.key} ${JSON.stringify(input.value)}`;
  if (
    sanitized.audit.excludedPII.length > 0 ||
    /(?:order|订单|物流|logistics|tracking|库存|inventory|price|价格|payment|支付|refund|退款|compensation|补偿)/i.test(content) ||
    /(?:persona|personality|画像|情绪|情感|difficult\s+customer|customer\s+type|客户类型)/i.test(content)
  ) {
    throw new BadRequestException({
      code: 'CUSTOMER_MEMORY_FORBIDDEN_CONTENT',
      message: 'Customer memory cannot contain PII, dynamic facts, or subjective profiles',
    });
  }
}

function cloneJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function memoryNotFound(): NotFoundException {
  return new NotFoundException({ code: 'CUSTOMER_MEMORY_NOT_FOUND', message: 'Customer memory not found in this Workspace' });
}
