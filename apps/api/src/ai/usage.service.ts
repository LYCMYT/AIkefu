import { Injectable } from '@nestjs/common';
import type { UsageSummary } from '@ai-customer-service/contracts';
import { PrismaService } from '../database/prisma.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(scope: WorkspaceScope): Promise<UsageSummary> {
    const rows = await this.prisma.aIUsage.findMany({
      where: { workspaceId: scope.workspaceId, tenantId: scope.tenantId },
      select: {
        purpose: true,
        inputTokens: true,
        outputTokens: true,
        success: true,
        fallbackUsed: true,
      },
    });

    const result: UsageSummary = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      failures: 0,
      fallbacks: 0,
      fastPathReplies: 0,
      byPurpose: {},
    };
    for (const row of rows) {
      result.calls += 1;
      result.inputTokens += row.inputTokens;
      result.outputTokens += row.outputTokens;
      result.failures += row.success ? 0 : 1;
      result.fallbacks += row.fallbackUsed ? 1 : 0;
      result.fastPathReplies += row.purpose === 'FAST_CHAT' ? 1 : 0;
      const purpose = result.byPurpose[row.purpose] ?? {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        failures: 0,
        fallbacks: 0,
      };
      purpose.calls += 1;
      purpose.inputTokens += row.inputTokens;
      purpose.outputTokens += row.outputTokens;
      purpose.failures += row.success ? 0 : 1;
      purpose.fallbacks += row.fallbackUsed ? 1 : 0;
      result.byPurpose[row.purpose] = purpose;
    }
    return result;
  }
}
