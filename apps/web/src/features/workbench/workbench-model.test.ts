import { describe, expect, it } from 'vitest';
import type { Conversation } from '../../api';
import { CONVERSATION_SNAPSHOT_FALLBACK_MS, conversationAiExplanation, filterConversations, shouldClearConversationSelection } from './workbench-model';

const conversations: Conversation[] = [
  { id: 'unread', buyer: { id: 'buyer-a', displayName: '小林' }, unreadCount: 2, humanActive: false },
  { id: 'taken', buyer: { id: 'buyer-b', displayName: '阿杰' }, unreadCount: 0, humanActive: true },
];

describe('workbench conversation filters', () => {
  it('filters unread and taken-over conversations using real snapshot fields', () => {
    expect(filterConversations(conversations, '', 'unread').map((item) => item.id)).toEqual(['unread']);
    expect(filterConversations(conversations, '', 'taken_over').map((item) => item.id)).toEqual(['taken']);
  });

  it('combines the status filter with buyer search', () => {
    expect(filterConversations(conversations, '小林', 'all').map((item) => item.id)).toEqual(['unread']);
    expect(filterConversations(conversations, '阿杰', 'unread')).toEqual([]);
  });

  it('explains the operator-facing reason instead of exposing internal status names', () => {
    expect(conversationAiExplanation({ humanActive: true }, { aiMode: 'AUTO_ALLOWED', aiReadiness: 'READY' })).toBe('人工已接管，AI 不会发送本轮回复');
    expect(conversationAiExplanation({ effectiveMode: 'ASSIST' }, { aiMode: 'AUTO_ALLOWED', aiReadiness: 'READY' })).toBe('AI 已开启，本轮因风险或证据不足需要人工确认');
    expect(conversationAiExplanation({}, { aiMode: 'AUTO_ALLOWED', aiReadiness: 'PREPARING', settingsConfirmed: false })).toBe('请先确认基础设置，完成后 AI 才能自动回复');
    expect(conversationAiExplanation({}, { aiMode: 'MANUAL_ONLY', aiReadiness: 'OFF' })).toBe('店铺 AI 已关闭，新消息仅由人工处理');
  });

  it('keeps the selected conversation while a realtime list refresh is in flight', () => {
    expect(shouldClearConversationSelection(true, 'conversation-a', [])).toBe(false);
    expect(shouldClearConversationSelection(false, 'conversation-a', [{ id: 'conversation-a' }])).toBe(false);
    expect(shouldClearConversationSelection(false, 'conversation-a', [{ id: 'conversation-b' }])).toBe(true);
  });

  it('uses a bounded fallback refresh when a websocket event is missed during navigation', () => {
    expect(CONVERSATION_SNAPSHOT_FALLBACK_MS).toBeGreaterThanOrEqual(2_000);
    expect(CONVERSATION_SNAPSHOT_FALLBACK_MS).toBeLessThanOrEqual(5_000);
  });
});
