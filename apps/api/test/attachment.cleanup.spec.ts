import { Logger } from '@nestjs/common';
import { AttachmentCleanupService } from '../src/attachments/attachments.cleanup';
import type { AttachmentService } from '../src/attachments/attachments.service';

describe('AttachmentCleanupService', () => {
  it('contains a transient cleanup rejection and leaves the scheduler retryable', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const cleanupExpired = jest.fn().mockRejectedValue(new Error('storage unavailable'));
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const cleanup = new AttachmentCleanupService({ cleanupExpired } as unknown as AttachmentService);

    cleanup.onApplicationBootstrap();
    await new Promise<void>((resolve) => setImmediate(resolve));
    cleanup.onApplicationShutdown();

    expect(cleanupExpired).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      'Attachment expiry cleanup failed; the next scheduled run will retry',
      expect.any(Error),
    );
    logger.mockRestore();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
});
