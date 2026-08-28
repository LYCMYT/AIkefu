import { describe, expect, it } from 'vitest';
import type { Conversation } from '../../api';
import { filterConversations } from './workbench-model';

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
});
