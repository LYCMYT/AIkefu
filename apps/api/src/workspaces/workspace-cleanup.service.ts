import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class WorkspaceCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;

  constructor(@Inject(WorkspaceService) private readonly workspaces: WorkspaceService) {}

  onApplicationBootstrap(): void {
    void this.workspaces.cleanupExpired();
    this.timer = setInterval(() => void this.workspaces.cleanupExpired(), CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
