import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ProcessingOutboxStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { KnowledgeService } from './knowledge.service';

const LEASE_MS = 60_000;

/** Dedicated durable consumer for shop-created learning. Message processing
 * deliberately ignores this event family, keeping both retry domains small. */
@Injectable()
export class ProductLearningRequestWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductLearningRequestWorker.name);
  private timer?: NodeJS.Timeout;
  private work?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !process.env.DATABASE_URL?.trim()) return;
    this.runTracked();
    this.timer = setInterval(() => this.runTracked(), 1_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.work;
  }

  private runTracked(): void {
    if (this.work) return;
    const run = this.dispatchOnce()
      .catch(() => this.logger.error('Product learning request dispatch failed; durable retry remains pending'))
      .then(() => undefined)
      .finally(() => { if (this.work === run) this.work = undefined; });
    this.work = run;
  }

  async dispatchOnce(now = new Date()): Promise<{ dispatched: number; failed: number }> {
    await this.prisma.processingOutbox.updateMany({
      where: {
        eventType: 'PRODUCT_LEARNING_REQUESTED',
        status: ProcessingOutboxStatus.DISPATCHING,
        updatedAt: { lt: new Date(now.getTime() - LEASE_MS) },
      },
      data: { status: ProcessingOutboxStatus.PENDING, availableAt: now },
    });
    const rows = await this.prisma.processingOutbox.findMany({
      where: {
        eventType: 'PRODUCT_LEARNING_REQUESTED',
        status: ProcessingOutboxStatus.PENDING,
        availableAt: { lte: now },
      },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      take: 20,
    });
    let dispatched = 0;
    let failed = 0;
    for (const row of rows) {
      const claimed = await this.prisma.processingOutbox.updateMany({
        where: { id: row.id, eventType: 'PRODUCT_LEARNING_REQUESTED', status: ProcessingOutboxStatus.PENDING },
        data: { status: ProcessingOutboxStatus.DISPATCHING, attempts: { increment: 1 } },
      });
      if (claimed.count !== 1) continue;
      const payload = learningRequest(row.payloadJson, row.shopId);
      if (!payload) {
        await this.prisma.processingOutbox.updateMany({
          where: { id: row.id, status: ProcessingOutboxStatus.DISPATCHING },
          data: { status: ProcessingOutboxStatus.FAILED },
        });
        failed += 1;
        continue;
      }
      try {
        const learning = await this.knowledge.startProductLearning(
          { workspaceId: row.workspaceId, tenantId: row.tenantId },
          row.shopId,
          payload.productIds,
        );
        // A reclaimed delivery can observe the original worker's still-fresh
        // RUNNING lease. That is not an acknowledgement: if the original
        // worker dies after we consume this event, no durable request remains
        // to reclaim the stale job. Keep only terminal jobs acknowledged.
        if (!isTerminalProductLearningStatus(learning.status)) {
          const delay = Math.min(30_000, 500 * 2 ** Math.min(row.attempts, 6));
          await this.prisma.processingOutbox.updateMany({
            where: { id: row.id, status: ProcessingOutboxStatus.DISPATCHING },
            data: { status: ProcessingOutboxStatus.PENDING, availableAt: new Date(now.getTime() + delay) },
          });
          continue;
        }
        await this.prisma.$transaction(async (tx) => {
          await tx.processingReceipt.upsert({
            where: { eventId: row.eventId },
            update: {},
            create: {
              workspaceId: row.workspaceId,
              tenantId: row.tenantId,
              shopId: row.shopId,
              eventId: row.eventId,
            },
          });
          await tx.processingOutbox.updateMany({
            where: { id: row.id, status: ProcessingOutboxStatus.DISPATCHING },
            data: { status: ProcessingOutboxStatus.DISPATCHED, dispatchedAt: new Date() },
          });
        });
        dispatched += 1;
      } catch {
        const delay = Math.min(30_000, 500 * 2 ** Math.min(row.attempts, 6));
        await this.prisma.processingOutbox.updateMany({
          where: { id: row.id, status: ProcessingOutboxStatus.DISPATCHING },
          data: { status: ProcessingOutboxStatus.PENDING, availableAt: new Date(now.getTime() + delay) },
        });
      }
    }
    return { dispatched, failed };
  }
}

function learningRequest(value: unknown, scopedShopId: string): { productIds: string[] } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  if (payload.shopId !== scopedShopId || !Array.isArray(payload.productIds)) return undefined;
  const productIds = payload.productIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return productIds.length === payload.productIds.length ? { productIds } : undefined;
}

function isTerminalProductLearningStatus(status: unknown): boolean {
  return status === 'SUCCEEDED' || status === 'PARTIAL_SUCCESS' || status === 'FAILED';
}
