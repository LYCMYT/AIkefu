import { Injectable } from '@nestjs/common';
import type { AiPurpose } from '@ai-customer-service/core';

export type AiEvalProviderScenario =
  | 'PRIMARY_TIMEOUT_FALLBACK_SUCCESS'
  | 'TOTAL_TIMEOUT'
  | 'CRASH_ONCE'
  | 'CRASH_BEFORE_TRANSPORT_ONCE';

export class AiEvalSimulatedCrash extends Error {
  constructor() {
    super('EVAL_SIMULATED_PROCESS_CRASH');
    this.name = 'AiEvalSimulatedCrash';
  }
}

type GenerationBarrier = {
  reached: Promise<void>;
  releaseSignal: Promise<void>;
  markReached(): void;
  release(): void;
};

type RestartCrashSignal = {
  crashed: Promise<void>;
  markCrashed(): void;
};

/** Process-local, non-HTTP fault seam used only by the isolated eval CLI. */
@Injectable()
export class AiEvalFaultRegistry {
  private readonly scenarios = new Map<string, AiEvalProviderScenario>();
  private readonly generationBarriers = new Map<string, GenerationBarrier>();
  private readonly restartCrashSignals = new Map<string, RestartCrashSignal>();

  configure(workspaceId: string, scenario: AiEvalProviderScenario): void {
    this.scenarios.set(workspaceId, scenario);
  }

  consume(workspaceId: string, purpose: AiPurpose): AiEvalProviderScenario | undefined {
    if (purpose !== 'INTENT_PLANNER') return undefined;
    const scenario = this.scenarios.get(workspaceId);
    if (scenario === 'CRASH_BEFORE_TRANSPORT_ONCE') return undefined;
    if (scenario) this.scenarios.delete(workspaceId);
    return scenario;
  }

  /** Test-only restart seam: stop after durable claim, before transport fence. */
  consumeSendBeforeTransport(workspaceId: string): boolean {
    if (this.scenarios.get(workspaceId) !== 'CRASH_BEFORE_TRANSPORT_ONCE') return false;
    this.scenarios.delete(workspaceId);
    return true;
  }

  prepareGenerationBarrier(workspaceId: string): void {
    if (this.generationBarriers.has(workspaceId)) throw new Error('EVAL_GENERATION_BARRIER_ALREADY_ACTIVE');
    this.generationBarriers.set(workspaceId, generationBarrier());
  }

  async waitForGenerationBarrier(workspaceId: string): Promise<void> {
    const barrier = this.generationBarriers.get(workspaceId);
    if (!barrier) throw new Error('EVAL_GENERATION_BARRIER_NOT_PREPARED');
    await barrier.reached;
  }

  async pauseAtGenerationBarrier(workspaceId: string): Promise<void> {
    const barrier = this.generationBarriers.get(workspaceId);
    if (!barrier) return;
    barrier.markReached();
    await barrier.releaseSignal;
  }

  releaseGenerationBarrier(workspaceId: string): void {
    const barrier = this.generationBarriers.get(workspaceId);
    if (!barrier) return;
    this.generationBarriers.delete(workspaceId);
    barrier.release();
  }

  prepareRestartCrash(workspaceId: string): void {
    if (this.restartCrashSignals.has(workspaceId)) throw new Error('EVAL_RESTART_CRASH_ALREADY_ACTIVE');
    this.restartCrashSignals.set(workspaceId, restartCrashSignal());
  }

  async waitForRestartCrash(workspaceId: string): Promise<void> {
    const signal = this.restartCrashSignals.get(workspaceId);
    if (!signal) throw new Error('EVAL_RESTART_CRASH_NOT_PREPARED');
    await signal.crashed;
  }

  markRestartCrash(workspaceId: string): void {
    this.restartCrashSignals.get(workspaceId)?.markCrashed();
  }

  clear(workspaceId: string): void {
    this.releaseGenerationBarrier(workspaceId);
    const restartCrash = this.restartCrashSignals.get(workspaceId);
    this.restartCrashSignals.delete(workspaceId);
    restartCrash?.markCrashed();
    this.scenarios.delete(workspaceId);
  }
}

function generationBarrier(): GenerationBarrier {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
  return { reached, releaseSignal, markReached, release };
}

function restartCrashSignal(): RestartCrashSignal {
  let markCrashed!: () => void;
  const crashed = new Promise<void>((resolve) => { markCrashed = resolve; });
  return { crashed, markCrashed };
}
