import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ShopSummary } from '../../api';
import { LiveTestPage, MessageCard, productLearningPresentation } from './LiveTestPage';

const shop: ShopSummary = {
  id: 'shop-a',
  name: '青云数码演示店',
  platform: 'DOUYIN_DEMO',
  aiMode: 'AUTO_ALLOWED',
  aiReadiness: 'READY',
  connectionState: 'CONNECTED',
  syncComplete: true,
};

describe('LiveTestPage', () => {
  it('uses the scoped shop readiness when a product has no item-level learning projection', () => {
    expect(productLearningPresentation({ id: 'product-a' }, shop)).toEqual({ className: 'succeeded', label: '已完成' });
  });

  it('renders a truthful empty state when the operational Workspace has no shop', () => {
    const html = renderToStaticMarkup(<LiveTestPage activeShopId="" onShopChange={() => undefined} refreshKey={0} shops={[]} token="token" />);
    expect(html).toContain('添加店铺后开始实时联调');
    expect(html).toContain('真实店铺、买家、商品和消息管线');
  });

  it('does not fall back to a deleted shop while a reset foundation snapshot is changing', () => {
    const html = renderToStaticMarkup(<LiveTestPage
      activeShopId={shop.id}
      onShopChange={() => undefined}
      refreshKey={1}
      requestedShopId="replacement-shop"
      shops={[shop]}
      token="token"
    />);
    expect(html).toContain('添加店铺后开始实时联调');
    expect(html).not.toContain('青云数码演示店 · 同一服务端快照');
  });

  it('exposes buyer/store mobile tabs, one shared pipeline, and accessible event controls', () => {
    const html = renderToStaticMarkup(<LiveTestPage activeShopId={shop.id} onShopChange={() => undefined} refreshKey={0} shops={[shop]} socketStatus="connected" token="token" />);

    expect(html).toContain('实时联调');
    expect(html).toContain('<h2 id="live-test-title">实时联调</h2>');
    expect(html).not.toContain('<h1');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="买家消息"');
    expect(html).toContain('aria-label="选择要发送的商品"');
    expect(html).toContain('aria-label="选择要发送的订单"');
    expect(html).toContain('aria-label="店铺端"');
    expect(html).toContain('买家已发送');
    expect(html).toContain('发送回执');
    expect(html).toContain('左侧每次操作只调用一次真实 API');
  });

  it('renders analyzed image messages instead of an empty placeholder', () => {
    const html = renderToStaticMarkup(<MessageCard message={{
      id: 'image-a',
      kind: 'IMAGE',
      role: 'BUYER',
      status: 'ACTIVE',
      content: {
        attachmentId: 'attachment-a',
        analysisStatus: 'READY',
        analysis: { scene: 'PRODUCT_DAMAGE', observations: ['疑似商品破损'] },
      },
    }} />);

    expect(html).toContain('商品破损图片');
    expect(html).toContain('疑似商品破损');
    expect(html).not.toContain('（空消息）');
  });

  it('uses durable card content when expanded product and order projections are absent', () => {
    const productHtml = renderToStaticMarkup(<MessageCard message={{
      id: 'product-card-a', kind: 'GOODS_CARD', role: 'BUYER', status: 'ACTIVE',
      content: { productId: 'product-a', externalProductId: 'MIA-HOODIE', title: '轻薄连帽卫衣' },
    }} />);
    const orderHtml = renderToStaticMarkup(<MessageCard message={{
      id: 'order-card-a', kind: 'ORDER_CARD', role: 'BUYER', status: 'ACTIVE',
      content: { orderId: 'order-a', externalOrderId: 'MIA-20260831-001', status: 'PAID' },
    }} />);

    expect(productHtml).toContain('轻薄连帽卫衣');
    expect(productHtml).toContain('商品上下文已同步');
    expect(productHtml).not.toContain('未命名商品');
    expect(productHtml).not.toContain('价格待同步');
    expect(orderHtml).toContain('MIA-20260831-001');
    expect(orderHtml).toContain('PAID');
    expect(orderHtml).not.toContain('未命名订单');
    expect(orderHtml).not.toContain('订单状态待同步');
  });
});
