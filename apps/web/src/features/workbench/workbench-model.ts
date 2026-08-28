import type { Conversation } from '../../api';
import { buyerName } from '../shared/view-models';

export type ConversationFilter = 'all' | 'unread' | 'taken_over';

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
