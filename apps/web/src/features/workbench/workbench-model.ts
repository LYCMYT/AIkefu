import type { Conversation } from '../../api';
import { buyerName } from '../shared/view-models';

export type ConversationFilter = 'all' | 'unread' | 'taken_over';

export type ConversationAiDisplayState = '生成中' | '已自动发送' | '已停止' | '需要人工';

export function conversationAiState(conversation: {
  humanActive?: boolean;
  currentDraft?: { status?: string } | null;
  sendOutbox?: { status?: string } | null;
  effectiveMode?: string;
  mode?: string;
}): ConversationAiDisplayState {
  if (conversation.humanActive || conversation.effectiveMode === 'MANUAL' || conversation.mode === 'MANUAL') return '已停止';
  if (conversation.currentDraft?.status === 'GENERATING') return '生成中';
  if (conversation.currentDraft?.status === 'WAITING_HUMAN' || conversation.currentDraft?.status === 'FAILED' || conversation.currentDraft?.status === 'STALE' || conversation.currentDraft?.status === 'EXPIRED') return '需要人工';
  if (conversation.sendOutbox?.status === 'SENT' || conversation.sendOutbox?.status === 'DELIVERED') return '已自动发送';
  return '需要人工';
}

export function filterConversations(conversations: Conversation[], query: string, filter: ConversationFilter): Conversation[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  return conversations.filter((conversation) => {
    if (filter === 'unread' && (conversation.unreadCount ?? 0) === 0) return false;
    if (filter === 'taken_over' && !conversation.humanActive) return false;
    if (!normalizedQuery) return true;
    const message = typeof conversation.lastMessage?.text === 'string' ? conversation.lastMessage.text : '';
    return `${buyerName(conversation.buyer)} ${conversation.externalConversationId ?? ''} ${message}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery);
  });
}
