import { describe, expect, it } from 'vitest';
import type { Conversation, Message, Product } from '../../api';
import {
  derivePipelineStages,
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
        idempotencyKey: 'outbox-a',
        status: 'UNCERTAIN',
      },
    };
    const stages = derivePipelineStages(conversation, [buyerMessage]);

    expect(stages.map((stage) => stage.key)).toEqual(['sent', 'received', 'draft', 'reply', 'receipt']);
    expect(stages.map((stage) => stage.state)).toEqual(['done', 'done', 'done', 'attention', 'attention']);
    expect(stages[4]?.description).toContain('UNCERTAIN');
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
});
