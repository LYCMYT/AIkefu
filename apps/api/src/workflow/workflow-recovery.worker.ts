import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { WorkflowRuntimeService } from './workflow-runtime.service';

/** Durable restart recovery; a waiting human approval is intentionally never claimed. */
@Injectable()
export class WorkflowRecoveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowRecoveryWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly staleMs = 35_000; // exceeds the V1 30 s workflow deadline.

  constructor(private readonly prisma: PrismaService, private readonly runtime: WorkflowRuntimeService) {}

  onModuleInit() {
    // Test modules commonly supply deterministic service doubles without a
    // database.  More importantly, startup recovery is best-effort: a
    // transient database outage must not escape as an unhandled rejection or
    // prevent the application from booting.  The interval remains retryable.
    if (!process.env.DATABASE_URL?.trim()) return;
    this.timer = setInterval(() => void this.runScheduledRecovery(), 30_000);
    this.timer.unref?.();
    void this.runScheduledRecovery();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async runScheduledRecovery(): Promise<void> {
    try {
      await this.recoverOnce();
    } catch {
      // Do not include driver error details: they can contain a connection
      // string.  The next interval is deliberately allowed to retry.
      this.logger.error('Workflow recovery scan failed; next scheduled run will retry');
    }
  }

  async recoverOnce(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const cutoff = new Date(now.getTime() - this.staleMs);
      const candidates = await this.prisma.workflowRun.findMany({
        where: { status: { in: ['RUNNING', 'RECOVERING'] }, updatedAt: { lte: cutoff } },
        select: { id: true, workspaceId: true, tenantId: true, shopId: true, updatedAt: true },
        take: 50,
        orderBy: { updatedAt: 'asc' },
      });
      for (const candidate of candidates) {
        const claimed = await this.prisma.workflowRun.updateMany({
          where: { id: candidate.id, workspaceId: candidate.workspaceId, tenantId: candidate.tenantId, shopId: candidate.shopId, updatedAt: candidate.updatedAt, status: { in: ['RUNNING', 'RECOVERING'] } },
          data: { status: 'RECOVERING' },
        });
        if (claimed.count !== 1) continue;
        await this.runtime.recover({ workspaceId: candidate.workspaceId, tenantId: candidate.tenantId, shopId: candidate.shopId }, candidate.id).catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }
}
