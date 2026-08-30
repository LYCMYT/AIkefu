import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ShopSummary } from '../../api';
import { LiveTestPage, productLearningPresentation } from './LiveTestPage';

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
});
