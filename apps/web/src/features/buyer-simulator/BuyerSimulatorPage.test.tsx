import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BuyerSimulatorPage } from './BuyerSimulatorPage';

describe('BuyerSimulatorPage first-run state', () => {
  it('does not leave an empty operational Workspace in a permanent loading state', () => {
    const html = renderToStaticMarkup(<BuyerSimulatorPage activeShopId="" onShopChange={() => undefined} refreshKey={0} shops={[]} token="token" />);
    expect(html).toContain('添加店铺后使用买家模拟器');
    expect(html).toContain('href="/workbench"');
    expect(html).not.toContain('正在读取对话');
  });
});
