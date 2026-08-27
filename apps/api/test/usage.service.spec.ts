import { UsageService } from '../src/ai/usage.service';

describe('UsageService', () => {
  it('aggregates the whole current workspace while retaining workspace and tenant isolation', async () => {
    const prisma = {
      aIUsage: {
        findMany: jest.fn().mockResolvedValue([
          { purpose: 'FAST_CHAT', inputTokens: 10, outputTokens: 4, success: true, fallbackUsed: false },
          { purpose: 'SUMMARY', inputTokens: 20, outputTokens: 8, success: false, fallbackUsed: true },
        ]),
      },
    };
    const service = new UsageService(prisma as never);

    await expect(service.summary({ workspaceId: 'workspace-a', tenantId: 'tenant-a' })).resolves.toEqual({
      calls: 2,
      inputTokens: 30,
      outputTokens: 12,
      estimatedCost: 0,
      failures: 1,
      fallbacks: 1,
      fastPathReplies: 1,
      byPurpose: {
        FAST_CHAT: { calls: 1, inputTokens: 10, outputTokens: 4, failures: 0, fallbacks: 0 },
        SUMMARY: { calls: 1, inputTokens: 20, outputTokens: 8, failures: 1, fallbacks: 1 },
      },
    });
    expect(prisma.aIUsage.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a', tenantId: 'tenant-a' },
      select: {
        purpose: true,
        inputTokens: true,
        outputTokens: true,
        success: true,
        fallbackUsed: true,
      },
    });
  });
});
