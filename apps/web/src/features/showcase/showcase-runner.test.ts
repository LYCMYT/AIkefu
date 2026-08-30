import { describe, expect, it, vi } from 'vitest';
import type { ShowcaseCatalog, ShowcaseScenario } from '../../api';
import { runShowcaseScenario, type ShowcaseRunnerPort } from './showcase-runner';

const scenario: ShowcaseScenario = {
  id: 'SC-01-PRODUCT-CARE', order: 1, title: '商品知识有据回答', shopKey: 'shop_mia_fashion', buyerKey: 'buyer_002',
  aiMode: 'AUTO_ALLOWED', objective: '真实商品知识',
  steps: [
    { actor: 'SYSTEM', action: 'RESET_SHOWCASE' },
    { actor: 'BUYER', action: 'SEND_GOODS_CARD', productKey: 'fashion_hoodie' },
    { actor: 'BUYER', action: 'SEND_TEXT', text: '这个可以放烘干机吗？' },
    { actor: 'SYSTEM', action: 'WAIT_FOR_BUYER_VISIBLE_REPLY', timeoutMs: 1000 },
  ], expected: {},
};

const catalog: ShowcaseCatalog = {
  version: '1.0', providerMode: 'OFFLINE', multimodalMode: 'FIXTURE', scenarios: [scenario],
  resources: {
    shops: [{ key: 'shop_mia_fashion', name: 'MIA Fashion' }],
    buyers: [{ key: 'buyer_002', externalBuyerId: 'dy_buyer_002' }],
    products: [{ key: 'fashion_hoodie', externalProductId: 'P-F-001' }],
    orders: [],
  },
};

function port(): ShowcaseRunnerPort {
  return {
    reset: vi.fn().mockResolvedValue({ shops: [{ id: 'shop-a', name: 'MIA Fashion' }] }),
    setShopMode: vi.fn().mockResolvedValue(undefined),
    buyers: vi.fn().mockResolvedValue([{ id: 'buyer-a', externalBuyerId: 'dy_buyer_002' }]),
    products: vi.fn().mockResolvedValue([{ id: 'product-a', externalProductId: 'P-F-001' }]),
    orders: vi.fn().mockResolvedValue([]),
    conversations: vi.fn().mockResolvedValue([{ id: 'conversation-a', buyerId: 'buyer-a' }]),
    conversation: vi.fn().mockResolvedValue({
      id: 'conversation-a', buyerId: 'buyer-a', messages: [
        { id: 'buyer-message', role: 'BUYER', status: 'ACTIVE', sequence: 1 },
        { id: 'reply-message', role: 'ASSISTANT', status: 'ACTIVE', sequence: 2 },
      ],
    }),
    productCard: vi.fn().mockResolvedValue({ conversationId: 'conversation-a' }),
    orderCard: vi.fn().mockResolvedValue({ conversationId: 'conversation-a' }),
    text: vi.fn().mockResolvedValue({ conversationId: 'conversation-a' }),
    image: vi.fn().mockResolvedValue({ conversationId: 'conversation-a' }),
    runStaleScenario: vi.fn().mockResolvedValue(undefined),
    scenarioSnapshot: vi.fn().mockResolvedValue(undefined),
    trace: vi.fn().mockResolvedValue({ traceId: 'trace-a', events: [] }),
    sleep: vi.fn().mockResolvedValue(undefined),
  } as unknown as ShowcaseRunnerPort;
}

describe('showcase runner', () => {
  it('executes the catalog actions through the injected real API boundary and observes a visible reply', async () => {
    const api = port();
    const updates: string[] = [];
    await expect(runShowcaseScenario(api, catalog, scenario, (update) => updates.push(update.status))).resolves.toMatchObject({
      status: 'COMPLETED', conversationId: 'conversation-a', trace: { traceId: 'trace-a' },
    });
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(api.setShopMode).toHaveBeenCalledWith('shop-a', 'AUTO_ALLOWED');
    expect(api.productCard).toHaveBeenCalledWith(expect.objectContaining({ shopId: 'shop-a', buyerId: 'buyer-a', productId: 'product-a' }));
    expect(api.text).toHaveBeenCalledWith(expect.objectContaining({ text: '这个可以放烘干机吗？', conversationId: 'conversation-a' }));
    expect(updates).toEqual(expect.arrayContaining(['PREPARING', 'RUNNING', 'WAITING_AI', 'COMPLETED']));
  });

  it('fails closed when the caller cancels before a business action', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runShowcaseScenario(port(), catalog, scenario, () => undefined, controller.signal)).rejects.toThrow('SHOWCASE_CANCELLED');
  });
});
