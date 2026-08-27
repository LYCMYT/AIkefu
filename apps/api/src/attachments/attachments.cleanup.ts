import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { AttachmentService } from './attachments.service';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Runs the 15-day object lifecycle without requiring a platform cron service. */
@Injectable()
export class AttachmentCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AttachmentCleanupService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly attachments: AttachmentService) {}

  onApplicationBootstrap(): void {
    // Integration modules provide their own deterministic repositories; do not
    // let a background timer escape the test boundary and touch real Prisma.
    if (process.env.NODE_ENV === 'test') return;
    void this.runCleanup();
    this.timer = setInterval(() => void this.runCleanup(), CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** A transient storage/database outage must not become an unhandled rejection. */
  private async runCleanup(): Promise<void> {
    try {
      await this.attachments.cleanupExpired();
    } catch (error) {
      this.logger.error('Attachment expiry cleanup failed; the next scheduled run will retry', error);
    }
  }
}
