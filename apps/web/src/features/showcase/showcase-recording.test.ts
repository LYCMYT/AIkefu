import { describe, expect, it } from 'vitest';
import type { DeveloperTrace } from '../../api';
import {
  parseShowcaseRecordingQuery,
  projectRecordingTrace,
  recordingProgress,
  recordingTraceDetails,
} from './showcase-recording';

const trace: DeveloperTrace = {
  traceId: 'trace-safe',
  events: [
    { id: '1', traceId: 'trace-safe', stage: 'MESSAGE_COMMITTED', payload: { kind: 'TEXT', senderRole: 'BUYER' }, createdAt: '2026-08-31T05:00:00.000Z' },
    { id: '2', traceId: 'trace-safe', stage: 'USER_TURN', payload: { sourceMessageCount: 3 }, createdAt: '2026-08-31T05:00:01.000Z' },
    { id: '3', traceId: 'trace-safe', stage: 'TASKS', payload: { tasks: [{ status: 'SUCCEEDED' }] }, createdAt: '2026-08-31T05:00:02.000Z' },
    { id: '4', traceId: 'trace-safe', stage: 'CONTEXT', payload: { contexts: [{ status: 'RESOLVED' }] }, createdAt: '2026-08-31T05:00:03.000Z' },
    { id: '5', traceId: 'trace-safe', stage: 'EVIDENCE', payload: { evidenceCount: 2 }, createdAt: '2026-08-31T05:00:04.000Z' },
    { id: '6', traceId: 'trace-safe', stage: 'REPLY_POLICY', payload: { mode: 'AUTO' }, createdAt: '2026-08-31T05:00:05.000Z' },
    { id: '7', traceId: 'trace-safe', stage: 'SEND_GUARD', payload: { allowed: true, phase: 'TRANSPORT_FENCE' }, createdAt: '2026-08-31T05:00:06.000Z' },
    { id: '8', traceId: 'trace-safe', stage: 'SEND_RECEIPT', payload: { status: 'SENT' }, createdAt: '2026-08-31T05:00:07.000Z' },
  ],
};

describe('showcase recording presentation', () => {
  it('enables recording and closing modes only through explicit query flags', () => {
    expect(parseShowcaseRecordingQuery('?recording=1')).toEqual({ enabled: true, closing: false });
    expect(parseShowcaseRecordingQuery('?recording=1&closing=1')).toEqual({ enabled: true, closing: true });
    expect(parseShowcaseRecordingQuery('?closing=1')).toEqual({ enabled: false, closing: false });
  });

  it('projects a stable eight-stage trace from real structured events', () => {
    const rows = projectRecordingTrace(trace);
    expect(rows.map((row) => row.label)).toEqual([
      'Raw Message', 'UserTurn', 'TaskBundle', 'Context', 'Evidence', 'Policy', 'SendGuard', 'Receipt',
    ]);
    expect(rows.map((row) => row.state)).toEqual(Array(8).fill('done'));
    expect(rows.map((row) => row.summary)).toEqual([
      '买家 TEXT 已提交', '聚合 3 条消息', '1 个任务已持久化', '1 个上下文已解析',
      '冻结 2 条证据', 'AUTO 策略已决策', 'TRANSPORT_FENCE 允许发送', 'SENT 回执已投影',
    ]);
  });

  it('keeps absent stages visible as pending instead of inventing evidence', () => {
    const rows = projectRecordingTrace({ ...trace, events: trace.events.slice(0, 2) });
    expect(rows).toHaveLength(8);
    expect(rows[0]?.state).toBe('done');
    expect(rows[2]).toMatchObject({ label: 'TaskBundle', state: 'pending', summary: '等待真实事件' });
  });

  it('derives the recording status strip from the actual run state', () => {
    expect(recordingProgress(2, 4, { status: 'WAITING_AI', message: '正在检索偏远地区规则' })).toEqual({
      scene: 'SCENE 03 / 04',
      step: 'AI 处理中',
      detail: '正在检索偏远地区规则',
    });
  });

  it('exposes only an allowlisted detail projection and never raw prompt-like fields', () => {
    const details = recordingTraceDetails('policy', {
      mode: 'ASSIST',
      reasons: ['HIGH_RISK'],
      prompt: 'secret system prompt',
      chainOfThought: 'private reasoning',
      apiKey: 'sk-secret',
    });
    expect(details).toEqual({ mode: 'ASSIST', reasons: ['HIGH_RISK'] });
    expect(JSON.stringify(details)).not.toMatch(/prompt|reasoning|sk-secret/i);
  });
});
