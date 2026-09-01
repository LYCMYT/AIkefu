import type { DeveloperTrace } from '../../api';
import type { ShowcaseRunUpdate } from './showcase-runner';

export interface ShowcaseRecordingQuery {
  enabled: boolean;
  closing: boolean;
  version: 'none' | 'v1' | 'v2';
  focus: ShowcaseRecordingFocus;
}

export type ShowcaseRecordingFocus = 'all' | 'buyer' | 'evidence' | 'turn' | 'stale' | 'risk' | 'quality' | 'trace';

const RECORDING_FOCUS_STATES = new Set<ShowcaseRecordingFocus>([
  'all', 'buyer', 'evidence', 'turn', 'stale', 'risk', 'quality', 'trace',
]);

export interface RecordingTraceRow {
  key: 'raw' | 'turn' | 'tasks' | 'context' | 'evidence' | 'policy' | 'delivery';
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
  { key: 'delivery', label: 'SendGuard / Receipt', stages: ['SEND_GUARD', 'SEND_RECEIPT'] },
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
  const recording = params.get('recording');
  const version = recording === 'v2' ? 'v2' : recording === '1' ? 'v1' : 'none';
  const enabled = version !== 'none';
  const requestedFocus = params.get('focus') as ShowcaseRecordingFocus | null;
  const focus = requestedFocus && RECORDING_FOCUS_STATES.has(requestedFocus) ? requestedFocus : 'all';
  return { enabled, closing: enabled && params.get('closing') === '1', version, focus };
}

export function showcaseRecordingClasses(recording: ShowcaseRecordingQuery): string {
  if (!recording.enabled) return 'showcase-page';
  return [
    'showcase-page',
    'is-recording',
    recording.version === 'v2' ? 'is-recording-v2' : '',
    recording.version === 'v2' ? `focus-${recording.focus}` : '',
  ].filter(Boolean).join(' ');
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
  if (key === 'delivery') return `SendGuard ${payload.guardAllowed === true ? 'PASS' : 'BLOCK'} · ${text(payload.receiptStatus, '等待回执')}`;
  return '已记录';
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
  return pick(payload, ['guardAllowed', 'guardPhase', 'guardReplyJobId', 'guardFailureCode', 'sendOutboxId', 'senderRole', 'receiptStatus']);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return compact(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

export function projectRecordingTrace(trace?: DeveloperTrace): RecordingTraceRow[] {
  return TRACE_STAGES.map((definition) => {
    if (definition.key === 'delivery') {
      const guard = [...(trace?.events ?? [])].reverse().find((candidate) => candidate.stage === 'SEND_GUARD');
      const receipt = [...(trace?.events ?? [])].reverse().find((candidate) => candidate.stage === 'SEND_RECEIPT');
      if (!guard || !receipt) return { key: definition.key, label: definition.label, state: 'pending', summary: '等待真实事件' };
      const payload = {
        guardAllowed: guard.payload.allowed,
        guardPhase: guard.payload.phase,
        guardReplyJobId: guard.payload.replyJobId,
        guardFailureCode: guard.payload.failureCode,
        sendOutboxId: receipt.payload.sendOutboxId,
        senderRole: receipt.payload.senderRole,
        receiptStatus: receipt.payload.status,
      };
      return {
        key: definition.key,
        label: definition.label,
        state: 'done',
        summary: traceSummary(definition.key, payload),
        createdAt: receipt.createdAt,
        payload,
      };
    }
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
