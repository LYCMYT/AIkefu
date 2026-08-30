import { Injectable } from '@nestjs/common';
import type { AiPurpose } from '@ai-customer-service/core';

export type AiEvalProviderScenario = 'PRIMARY_TIMEOUT_FALLBACK_SUCCESS' | 'TOTAL_TIMEOUT' | 'CRASH_ONCE';

export class AiEvalSimulatedCrash extends Error {
  constructor() {
    super('EVAL_SIMULATED_PROCESS_CRASH');
    this.name = 'AiEvalSimulatedCrash';
  }
}

/** Process-local, non-HTTP fault seam used only by the isolated eval CLI. */
@Injectable()
export class AiEvalFaultRegistry {
  private readonly scenarios = new Map<string, AiEvalProviderScenario>();

  configure(workspaceId: string, scenario: AiEvalProviderScenario): void {
    this.scenarios.set(workspaceId, scenario);
  }

  consume(workspaceId: string, purpose: AiPurpose): AiEvalProviderScenario | undefined {
    if (purpose !== 'INTENT_PLANNER') return undefined;
    const scenario = this.scenarios.get(workspaceId);
    if (scenario) this.scenarios.delete(workspaceId);
    return scenario;
  }

  clear(workspaceId: string): void {
    this.scenarios.delete(workspaceId);
  }
}
