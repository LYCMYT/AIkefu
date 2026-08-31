import type { DeveloperTrace } from '../../api';
import type { ShowcaseRunUpdate } from './showcase-runner';

export interface ShowcaseRecordingQuery {
  enabled: boolean;
  closing: boolean;
}

export interface RecordingTraceRow {
  key: 'raw' | 'turn' | 'tasks' | 'context' | 'evidence' | 'policy' | 'guard' | 'receipt';
  label: string;
  state: 'done' | 'pending';
  summary: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
}

const TRACE_STAGES: Array<{
  key: RecordingTraceRow['key'];
  label: string;
  stages: string[];
}> = [
  { key: 'raw', label: 'Raw Message', stages: ['MESSAGE_COMMITTED'] },
  { key: 'turn', label: 'UserTurn', stages: ['USER_TURN'] },
  { key: 'tasks', label: 'TaskBundle', stages: ['TASKS'] },
  { key: 'context', label: 'Context', stages: ['CONTEXT'] },
  { key: 'evidence', label: 'Evidence', stages: ['EVIDENCE'] },
  { key: 'policy', label: 'Policy', stages: ['REPLY_POLICY'] },
  { key: 'guard', label: 'SendGuard', stages: ['SEND_GUARD'] },
  { key: 'receipt', label: 'Receipt', stages: ['SEND_RECEIPT'] },
];

const RUN_STEP: Record<ShowcaseRunUpdate['status'], string> = {
  NOT_STARTED: '等待开始',
  PREPARING: '恢复场景',
  RUNNING: '链路执行中',
  WAITING_AI: 'AI 处理中',
  WAITING_HUMAN: '等待人工',
  COMPLETED: '场景完成',
  FAILED: '场景未完成',
  CANCELLED: '场景已取消',
};

export function parseShowcaseRecordingQuery(search: string): ShowcaseRecordingQuery {
  const params = new URLSearchParams(search);
  const enabled = params.get('recording') === '1';
  return { enabled, closing: enabled && params.get('closing') === '1' };
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function traceSummary(key: RecordingTraceRow['key'], payload: Record<string, unknown>): string {
  if (key === 'raw') return `${payload.senderRole === 'BUYER' ? '买家' : text(payload.senderRole, '消息')} ${text(payload.kind, '事件')} 已提交`;
  if (key === 'turn') return `聚合 ${numeric(payload.sourceMessageCount)} 条消息`;
  if (key === 'tasks') return `${arrayLength(payload.tasks)} 个任务已持久化`;
  if (key === 'context') return `${arrayLength(payload.contexts)} 个上下文已解析`;
  if (key === 'evidence') return `冻结 ${numeric(payload.evidenceCount)} 条证据`;
  if (key === 'policy') return `${text(payload.mode, '已完成')} 策略已决策`;
  if (key === 'guard') return `${text(payload.phase, '发送前')} ${payload.allowed === true ? '允许发送' : '拒绝发送'}`;
  return `${text(payload.status, '已记录')} 回执已投影`;
}

function safeList(value: unknown, keys: string[]): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
  });
}

export function recordingTraceDetails(key: RecordingTraceRow['key'], payload: Record<string, unknown>): Record<string, unknown> {
  if (key === 'raw') return pick(payload, ['messageId', 'sequence', 'kind', 'senderRole']);
  if (key === 'turn') return pick(payload, ['userTurnId', 'firstSequence', 'lastSequence', 'sourceSequence', 'sourceMessageCount']);
  if (key === 'tasks') return compact({ tasks: safeList(payload.tasks, ['id', 'intent', 'status', 'riskLevel', 'errorCode']) });
  if (key === 'context') return compact({ contexts: safeList(payload.contexts, ['taskId', 'status', 'entitySelected', 'manualRequired']) });
  if (key === 'evidence') return pick(payload, ['evidenceCount', 'sourceTypes', 'knowledgeVersionIds']);
  if (key === 'policy') return pick(payload, ['mode', 'reasons', 'evidenceCount', 'taskStatuses']);
  if (key === 'guard') return pick(payload, ['allowed', 'phase', 'replyJobId', 'failureCode']);
  return pick(payload, ['sendOutboxId', 'senderRole', 'status']);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return compact(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

export function projectRecordingTrace(trace?: DeveloperTrace): RecordingTraceRow[] {
  return TRACE_STAGES.map((definition) => {
    const event = [...(trace?.events ?? [])].reverse().find((candidate) => definition.stages.includes(candidate.stage));
    if (!event) return { key: definition.key, label: definition.label, state: 'pending', summary: '等待真实事件' };
    return {
      key: definition.key,
      label: definition.label,
      state: 'done',
      summary: traceSummary(definition.key, event.payload),
      createdAt: event.createdAt,
      payload: event.payload,
    };
  });
}

export function recordingProgress(selectedIndex: number, total: number, run: ShowcaseRunUpdate) {
  return {
    scene: `SCENE ${String(selectedIndex + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`,
    step: RUN_STEP[run.status],
    detail: run.message,
  };
}
