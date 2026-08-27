import { describe, expect, it } from 'vitest';
import type { DeveloperTrace } from './api';
import { redactDeveloperTracePayload, shouldLoadDeveloperTrace, traceRequestedBySearch, visibleDeveloperTraceEvents } from './App';

describe('Workbench Developer Trace gate', () => {
  it('does not load while the toggle is hidden or without an active conversation', () => {
    expect(shouldLoadDeveloperTrace(false, 'conversation-1')).toBe(false);
    expect(shouldLoadDeveloperTrace(true, '')).toBe(false);
    expect(shouldLoadDeveloperTrace(true, 'conversation-1')).toBe(true);
  });

  it('accepts the explicit trace=1 query opt-in without changing the hidden default', () => {
    expect(traceRequestedBySearch('')).toBe(false);
    expect(traceRequestedBySearch('?trace=0')).toBe(false);
    expect(traceRequestedBySearch('?trace=true')).toBe(false);
    expect(traceRequestedBySearch('?trace=1')).toBe(true);
  });

  it('projects structured events and removes prompt/private fields before display', () => {
    const trace: DeveloperTrace = {
      traceId: 'trace-1',
      conversationId: 'conversation-1',
      events: [{
        id: 'event-1',
        traceId: 'trace-1',
        stage: 'REPLY_POLICY',
        payload: { decision: 'ASSIST', prompt: 'private prompt', nested: { cot: 'hidden', count: 1 } },
        createdAt: '2026-08-27T10:00:00.000Z',
      }],
    };

    expect(visibleDeveloperTraceEvents(trace)).toEqual([{
      id: 'event-1',
      stage: 'REPLY_POLICY',
      createdAt: '2026-08-27T10:00:00.000Z',
      payload: { decision: 'ASSIST', nested: { count: 1 } },
    }]);
    expect(redactDeveloperTracePayload({ token: 'hidden', stage: 'safe' })).toEqual({ stage: 'safe' });
  });
});
