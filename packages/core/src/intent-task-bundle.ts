/** Phase 04 keeps planning data deliberately small and deterministic. */
export const MAX_TASKS_PER_BUNDLE = 4;

export type TaskOperation = 'READ' | 'WRITE';
export type TaskRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type TaskStatus = 'OPEN' | 'RUNNING' | 'RESOLVED' | 'AMBIGUOUS' | 'FAILED' | 'SUPERSEDED' | 'CANCELLED';
export type TaskBundleStatus = 'ALL_RESOLVED' | 'PARTIAL_RESOLVED' | 'NEEDS_CLARIFICATION' | 'HIGH_RISK' | 'FAILED';

export interface PlannedTask {
  id: string;
  intent: string;
  operation: TaskOperation;
  riskLevel: TaskRiskLevel;
  requiredContext: string[];
  requiredKnowledge?: Array<'STORE' | 'PRODUCT'>;
  requiredTools: string[];
  blocking: boolean;
}

export interface TaskState extends PlannedTask {
  status: TaskStatus;
  facts?: Record<string, unknown>;
  evidence?: string[];
  errorCode?: string;
}

export interface TaskBundle {
  tasks: TaskState[];
}

export type TaskExecutionResult = {
  status: 'RESOLVED' | 'AMBIGUOUS' | 'FAILED';
  facts?: Record<string, unknown>;
  evidence?: string[];
  errorCode?: string;
};

export interface TaskBundleExecution {
  tasks: TaskState[];
  status: TaskBundleStatus;
  canAutoReply: boolean;
  hasBlockingFailure: boolean;
}

export interface CoalescedTaskBundle {
  needsReplan: true;
  supersededTaskIds: string[];
  tasks: TaskState[];
}

export function createTaskBundle(input: { tasks: PlannedTask[] }): TaskBundle {
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new RangeError('TaskBundle must contain at least one task');
  }
  if (input.tasks.length > MAX_TASKS_PER_BUNDLE) {
    throw new RangeError(`TaskBundle supports at most ${MAX_TASKS_PER_BUNDLE} tasks`);
  }

  const ids = new Set<string>();
  return {
    tasks: input.tasks.map((task) => {
      validateTask(task);
      if (ids.has(task.id)) throw new RangeError(`Task id ${task.id} is duplicated`);
      ids.add(task.id);
      return {
        ...task,
        requiredContext: [...task.requiredContext],
        requiredKnowledge: task.requiredKnowledge ? [...task.requiredKnowledge] : undefined,
        requiredTools: [...task.requiredTools],
        status: 'OPEN' as const,
      };
    }),
  };
}

/** Only legal lifecycle transitions are permitted; callers persist the returned state. */
export function transitionTask(task: TaskState, next: TaskStatus): TaskState {
  const permitted: Record<TaskStatus, TaskStatus[]> = {
    OPEN: ['RUNNING', 'SUPERSEDED', 'CANCELLED'],
    RUNNING: ['RESOLVED', 'AMBIGUOUS', 'FAILED', 'SUPERSEDED', 'CANCELLED'],
    RESOLVED: [],
    AMBIGUOUS: ['RUNNING', 'SUPERSEDED', 'CANCELLED'],
    FAILED: ['RUNNING', 'SUPERSEDED', 'CANCELLED'],
    SUPERSEDED: [],
    CANCELLED: [],
  };
  if (!permitted[task.status].includes(next)) {
    throw new Error(`Illegal Task transition ${task.status} -> ${next}`);
  }
  return { ...task, status: next };
}

/**
 * Runs all read-only lookups together, then any writes serially. Write
 * execution is intentionally left for a future Action Policy owner.
 */
export async function executeTaskBundle(
  bundle: TaskBundle,
  execute: (task: TaskState) => Promise<TaskExecutionResult>,
): Promise<TaskBundleExecution> {
  const run = async (task: TaskState): Promise<TaskState> => {
    const running = transitionTask(task, 'RUNNING');
    try {
      const outcome = await execute(running);
      return {
        ...transitionTask(running, outcome.status),
        facts: outcome.facts ? { ...outcome.facts } : undefined,
        evidence: outcome.evidence ? [...outcome.evidence] : undefined,
        errorCode: outcome.errorCode,
      };
    } catch {
      return { ...transitionTask(running, 'FAILED'), errorCode: 'TASK_EXECUTION_FAILED' };
    }
  };

  const reads = bundle.tasks.filter((task) => task.operation === 'READ');
  const writes = bundle.tasks.filter((task) => task.operation === 'WRITE');
  const completedById = new Map<string, TaskState>();
  await Promise.all(reads.map(async (task) => completedById.set(task.id, await run(task))));
  for (const task of writes) completedById.set(task.id, await run(task));

  const tasks = bundle.tasks.map((task) => completedById.get(task.id) ?? task);
  const hasBlockingFailure = tasks.some((task) => task.blocking && task.status === 'FAILED');
  const hasHighRisk = tasks.some((task) => task.riskLevel === 'HIGH');
  const resolved = tasks.filter((task) => task.status === 'RESOLVED').length;
  const ambiguous = tasks.some((task) => task.status === 'AMBIGUOUS');
  const failed = tasks.some((task) => task.status === 'FAILED');
  const status: TaskBundleStatus = hasBlockingFailure || (failed && resolved === 0)
    ? 'FAILED'
    : hasHighRisk
      ? 'HIGH_RISK'
      : ambiguous
        ? 'NEEDS_CLARIFICATION'
        : failed
          ? 'PARTIAL_RESOLVED'
          : 'ALL_RESOLVED';

  return {
    tasks,
    status,
    canAutoReply: !hasBlockingFailure && !hasHighRisk && !ambiguous,
    hasBlockingFailure,
  };
}

/**
 * A newer turn is replanned as one unit. It supersedes all still-actionable
 * tasks from the prior turn and retains only the new turn's open task set.
 */
export function coalesceTaskBundles(current: TaskBundle, incoming: TaskBundle): CoalescedTaskBundle {
  const supersededTaskIds = current.tasks
    .filter((task) => ['OPEN', 'RUNNING', 'AMBIGUOUS', 'FAILED'].includes(task.status))
    .map((task) => task.id);
  return {
    needsReplan: true,
    supersededTaskIds,
    tasks: incoming.tasks.map((task) => ({
      ...task,
      requiredContext: [...task.requiredContext],
      requiredKnowledge: task.requiredKnowledge ? [...task.requiredKnowledge] : undefined,
      requiredTools: [...task.requiredTools],
    })),
  };
}

function validateTask(task: PlannedTask): void {
  if (!task || typeof task !== 'object') throw new TypeError('Task must be an object');
  if (typeof task.id !== 'string' || task.id.trim().length === 0) throw new TypeError('Task id is required');
  if (typeof task.intent !== 'string' || task.intent.trim().length === 0) throw new TypeError('Task intent is required');
  if (task.operation !== 'READ' && task.operation !== 'WRITE') throw new TypeError('Task operation is invalid');
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(task.riskLevel)) throw new TypeError('Task riskLevel is invalid');
  if (!Array.isArray(task.requiredContext) || !Array.isArray(task.requiredTools)) throw new TypeError('Task requirements are invalid');
  if (typeof task.blocking !== 'boolean') throw new TypeError('Task blocking is required');
}
