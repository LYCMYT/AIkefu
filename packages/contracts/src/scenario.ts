import type { IsoDateTime } from './workspace';

export const SCENARIO_KEYS = [
  'continuous_messages',
  'message_during_generation',
  'two_buyers',
  'two_shops',
  'duplicate_and_reorder',
  'ai_timeout_fallback',
  'service_restart_recovery',
  'realtime_state_change',
] as const;
export type ScenarioKey = typeof SCENARIO_KEYS[number];

export const SCENARIO_STATUSES = ['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'RESETTING'] as const;
export type ScenarioStatus = typeof SCENARIO_STATUSES[number];
export const SCENARIO_STEP_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'] as const;
export type ScenarioStepStatus = typeof SCENARIO_STEP_STATUSES[number];

export interface ScenarioStep {
  key: string;
  label: string;
  status: ScenarioStepStatus;
  expected?: string;
  actual?: string;
}

export interface Scenario {
  key: ScenarioKey;
  name: string;
  status: ScenarioStatus;
  synthetic: true;
  description?: string;
  expectedResult?: string;
  steps?: ScenarioStep[];
  traceId?: string | null;
  lastRunAt?: IsoDateTime | null;
  updatedAt?: IsoDateTime;
}

export function isScenarioKey(value: unknown): value is ScenarioKey {
  return typeof value === 'string' && (SCENARIO_KEYS as readonly string[]).includes(value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
