import { describe, expect, it } from 'vitest';
import type { Conversation, Message, Product } from '../../api';
import {
  derivePipelineStages,
  deriveCurrentTurnLifecycle,
  liveTestRefreshKind,
  mergeLiveMessages,
  resolveContextProduct,
  shouldRefreshLiveTest,
} from './live-test-model';

const buyerMessage: Message = {
  id: 'message-buyer',
  conversationId: 'conversation-a',
  role: 'BUYER',
  kind: 'TEXT',
  status: 'ACTIVE',
  text: '什么时候发货？',
  sequence: 1,
  sentAt: '2026-08-29T08:00:00.000Z',
};

describe('Live Test projection model', () => {
  it('merges optimistic events and server snapshots by id while preserving edit/recall overlays', () => {
    const server = [{ ...buyerMessage, text: '原始问题' }];
    const optimistic = [buyerMessage, { ...buyerMessage, id: 'message-next', sequence: 2, text: '补充问题' }];
    const messages = mergeLiveMessages(server, optimistic, {
      'message-buyer': { ...buyerMessage, text: '编辑后的问题', status: 'EDITED' },
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: 'message-buyer', text: '编辑后的问题', status: 'EDITED' });
    expect(messages[1]?.id).toBe('message-next');
  });

  it('derives the five visible pipeline stages from the canonical conversation snapshot', () => {
    const conversation: Conversation = {
      id: 'conversation-a',
      currentDraft: {
        id: 'draft-a',
        replyJobId: 'job-a',
        aiDraft: '24小时内发货',
        humanFinal: null,
        editType: null,
        sourceContextVersion: 1,
        status: 'WAITING_HUMAN',
      },
      sendOutbox: {
        id: 'outbox-a',
        replyJobId: 'job-a',
        idempotencyKey: 'outbox-a',
        expectedLastMessageId: 'message-buyer',
        expectedSequence: 1,
        status: 'UNCERTAIN',
      },
      activeReplyJob: { id: 'job-a', conversationId: 'conversation-a', userTurnId: 'turn-a', sourceLastMessageId: 'message-buyer', sourceSequence: 1, status: 'WAITING_HUMAN', mode: 'ASSIST' },
      userTurns: [{ id: 'turn-a', sourceMessageIds: ['message-buyer'], normalizedText: '什么时候发货？', firstSequence: 1, lastSequence: 1, generation: 1, createdAt: '2026-08-29T08:00:00.000Z' }],
    };
    const stages = derivePipelineStages(conversation, [buyerMessage]);

    expect(stages.map((stage) => stage.key)).toEqual(['sent', 'received', 'draft', 'reply', 'receipt']);
    expect(stages.map((stage) => stage.state)).toEqual(['done', 'done', 'done', 'attention', 'attention']);
    expect(stages[4]?.description).toContain('UNCERTAIN');
  });

  it('marks AI processing complete when the final reply and SENT receipt are already visible', () => {
    const response: Message = {
      id: 'message-reply', conversationId: 'conversation-a', role: 'ASSISTANT', kind: 'TEXT', status: 'ACTIVE',
      text: '不建议使用烘干机。', sequence: 2, sentAt: '2026-08-29T08:00:02.000Z',
    };
    const conversation: Conversation = {
      id: 'conversation-a',
      sendOutbox: {
        id: 'outbox-a', replyJobId: 'job-a', idempotencyKey: 'reply-a',
        expectedLastMessageId: 'message-buyer', expectedSequence: 1, status: 'SENT',
      },
    };

    const stages = derivePipelineStages(conversation, [buyerMessage, response]);

    expect(stages.map((stage) => stage.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(stages[2]?.description).toBe('本轮回复已完成');
  });

  it('never mixes an old job or outbox into a newer buyer turn', () => {
    const latestBuyer = { ...buyerMessage, id: 'message-new', sequence: 4, text: '这一轮是新问题' };
    const conversation: Conversation = {
      id: 'conversation-a',
      activeReplyJob: { id: 'job-old', conversationId: 'conversation-a', userTurnId: 'turn-old', sourceLastMessageId: 'message-buyer', sourceSequence: 1, status: 'FAST_PATH_READY', mode: 'AUTO' },
      sendOutbox: { id: 'outbox-old', replyJobId: 'job-old', idempotencyKey: 'old', expectedLastMessageId: 'message-buyer', expectedSequence: 1, status: 'SENT' },
      userTurns: [
        { id: 'turn-new', sourceMessageIds: ['message-new'], normalizedText: latestBuyer.text!, firstSequence: 4, lastSequence: 4, generation: 2, createdAt: '2026-08-29T08:01:00.000Z' },
        { id: 'turn-old', sourceMessageIds: ['message-buyer'], normalizedText: buyerMessage.text!, firstSequence: 1, lastSequence: 1, generation: 1, createdAt: '2026-08-29T08:00:00.000Z' },
      ],
    };

    const stages = derivePipelineStages(conversation, [buyerMessage, latestBuyer]);
    const lifecycle = deriveCurrentTurnLifecycle(conversation, [buyerMessage, latestBuyer]);

    expect(stages.map((stage) => stage.state)).toEqual(['done', 'done', 'active', 'idle', 'idle']);
    expect(stages[2]?.description).toBe('等待当前轮次回复任务');
    expect(lifecycle).toMatchObject({ buyerMessage: { id: 'message-new' } });
    expect(lifecycle.job).toBeUndefined();
    expect(lifecycle.draft).toBeUndefined();
    expect(lifecycle.outbox).toBeUndefined();
  });

  it('uses a sent product card as context unless the operator explicitly selects another product', () => {
    const products: Product[] = [{ id: 'product-a', title: '随身灯' }, { id: 'product-b', title: '机械键盘' }];
    const productMessage: Message = { ...buyerMessage, id: 'product-message', kind: 'GOODS_CARD', productId: 'product-b' };

    expect(resolveContextProduct(undefined, [productMessage], products)?.id).toBe('product-b');
    expect(resolveContextProduct(undefined, [productMessage], products, 'product-a')?.id).toBe('product-a');
  });

  it('refreshes only supported events in the current shop or selected conversation', () => {
    expect(shouldRefreshLiveTest({ eventType: 'MESSAGE_RECEIVED', payload: { shopId: 'shop-a', conversationId: 'conversation-a' } }, 'shop-a', 'conversation-a')).toBe(true);
    expect(shouldRefreshLiveTest({ eventType: 'PRODUCT_LEARNING_UPDATED', payload: { shopId: 'shop-a' } }, 'shop-a', 'conversation-a')).toBe(true);
    expect(shouldRefreshLiveTest({ eventType: 'MESSAGE_RECEIVED', payload: { shopId: 'shop-b', conversationId: 'conversation-a' } }, 'shop-a', 'conversation-a')).toBe(false);
    expect(shouldRefreshLiveTest({ eventType: 'KNOWLEDGE_UPDATED', payload: { shopId: 'shop-a' } }, 'shop-a', 'conversation-a')).toBe(false);
  });

  it('keeps same-shop realtime refreshes in the background without resetting operator state', () => {
    expect(liveTestRefreshKind('', 'token-a', 'shop-a')).toBe('initialize');
    expect(liveTestRefreshKind('token-a:shop-a', 'token-a', 'shop-a')).toBe('background');
    expect(liveTestRefreshKind('token-a:shop-a', 'token-a', 'shop-b')).toBe('initialize');
  });
});
