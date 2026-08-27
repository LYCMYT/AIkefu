import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DataRetentionService, type DataRetentionResult } from './data-retention.service';

const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Server-only retry loop for the durable lifecycle entrypoint. A failed pass
 * leaves the underlying rows/tombstones eligible for the next interval.
 */
@Injectable()
export class DataRetentionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DataRetentionWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly retention: DataRetentionService) {}

  onApplicationBootstrap(): void {
    // Unit/integration modules deliberately have no live database or object
    // storage. Explicit calls to runOnce remain deterministic in those tests.
    if (process.env.NODE_ENV === 'test' || !process.env.DATABASE_URL?.trim()) return;
    void this.runSafely();
    this.timer = setInterval(() => void this.runSafely(), retentionIntervalMs());
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = new Date()): Promise<DataRetentionResult> {
    return this.retention.runOnce(now);
  }

  private async runSafely(): Promise<void> {
    try {
      await this.runOnce();
    } catch {
      // Provider/driver diagnostics may contain connection metadata. Keep the
      // log intentionally non-sensitive and retry on the next interval.
      this.logger.error('Data retention cleanup failed; the next scheduled run will retry');
    }
  }
}

function retentionIntervalMs(): number {
  const configured = Number(process.env.DATA_RETENTION_INTERVAL_MS);
  return Number.isSafeInteger(configured) && configured >= 60_000 ? configured : DEFAULT_RETENTION_INTERVAL_MS;
}
