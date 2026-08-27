import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SendOutboxService } from './send-outbox.service';
import { ReplyDraftService } from './reply-draft.service';
import { ReplyRuntimeService } from './reply-runtime.service';

const RECOVERY_INTERVAL_MS = 30_000;
// Must exceed the whole bounded intent/risk/composer pipeline. `updatedAt` is
// our no-schema lease timestamp; fresh GENERATING work is never recovered.
const GENERATION_STALE_MS = 3 * 60_000;

@Injectable()
export class ReplyRecoveryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ReplyRecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sendOutboxes: SendOutboxService,
    private readonly drafts: ReplyDraftService,
    private readonly runtime?: ReplyRuntimeService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Unit/in-memory startup has no durable rows to recover.
    if (!process.env.DATABASE_URL?.trim()) return;
    await this.recoverOnce().catch((error: unknown) => this.logger.error(this.errorMessage(error)));
    this.timer = setInterval(() => {
      void this.recoverOnce().catch((error: unknown) => this.logger.error(this.errorMessage(error)));
    }, RECOVERY_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async recoverOnce(now = new Date()): Promise<{ recoveryPending: number; stale: number; uncertain: number; expiredDrafts: number }> {
    const jobs = await this.prisma.replyJob.findMany({
      where: {
        OR: [
          { status: 'RECOVERY_PENDING' },
          { status: 'GENERATING', updatedAt: { lt: new Date(now.getTime() - GENERATION_STALE_MS) } },
        ],
      },
      select: {
        id: true,
        workspaceId: true,
        tenantId: true,
        shopId: true,
        conversationId: true,
        sourceContextVersion: true,
        status: true,
      },
      take: 100,
    });
    let recoveryPending = 0;
    let stale = 0;
    const runnable: Array<{ scope: { workspaceId: string; tenantId: string; shopId: string }; replyJobId: string }> = [];
    for (const job of jobs) {
      const scope = { workspaceId: job.workspaceId, tenantId: job.tenantId, shopId: job.shopId };
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: job.conversationId, ...scope },
        select: { id: true, contextVersion: true, humanActive: true, state: true },
      });
      const valid = conversation
        && conversation.state === 'ACTIVE'
        && !conversation.humanActive
        && conversation.contextVersion === job.sourceContextVersion;
      const staleReason = !conversation || conversation.state !== 'ACTIVE' || conversation.contextVersion !== job.sourceContextVersion
        ? 'CONTEXT_STALE'
        : 'HUMAN_ACTIVE';
      if (job.status === 'RECOVERY_PENDING' && valid) {
        recoveryPending += 1;
        runnable.push({ scope, replyJobId: job.id });
        continue;
      }
      const updated = await this.prisma.replyJob.updateMany({
        where: { id: job.id, ...scope, status: job.status, sourceContextVersion: job.sourceContextVersion },
        data: valid ? { status: 'RECOVERY_PENDING', staleReason: null } : { status: 'STALE', staleReason },
      });
      if (valid) {
        recoveryPending += updated.count;
        if (updated.count) runnable.push({ scope, replyJobId: job.id });
      } else stale += updated.count;
    }
    // The scan/claim is durable and short.  Model work begins only after it
    // commits; ReplyRuntime performs its own current-context/human CAS and
    // marks failed generation terminal rather than stranding RECOVERY_PENDING.
    if (this.runtime) {
      await Promise.all(runnable.map(async ({ scope, replyJobId }) => {
        try {
          await this.runtime!.process(scope, replyJobId);
        } catch (error) {
          this.logger.warn(`Reply recovery ${replyJobId} failed: ${this.errorMessage(error)}`);
        }
      }));
    }
    const uncertain = await this.sendOutboxes.recoverUncertain(new Date(now.getTime() - RECOVERY_INTERVAL_MS));
    const expiredDrafts = await this.drafts.expireDueAll(now);
    return { recoveryPending, stale, uncertain, expiredDrafts };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
