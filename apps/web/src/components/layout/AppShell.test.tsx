import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

const baseProps = {
  activePath: '/showcase' as const,
  activeShopId: 'shop-1',
  isResetting: false,
  onNavigate: () => undefined,
  onReset: () => undefined,
  onShopChange: () => undefined,
  onTraceToggle: () => undefined,
  routeTitle: '引导演示',
  shops: [{ id: 'shop-1', name: '青云演示店', aiMode: 'AUTO_ALLOWED', connectionState: 'CONNECTED' }],
  socketLabel: '实时已连接',
  socketReady: true,
  traceOpen: false,
  workspaceId: 'workspace-1',
};

describe('AppShell recording presentation', () => {
  it('removes application chrome only when Showcase recording mode is enabled', () => {
    const html = renderToStaticMarkup(<AppShell {...baseProps} recordingMode><h1>录制内容</h1></AppShell>);
    expect(html).toContain('recording-shell');
    expect(html).toContain('<h1>录制内容</h1>');
    expect(html).not.toContain('产品模块');
    expect(html).not.toContain('重置演示');
    expect(html).not.toContain('AIkefu · MockDouyin 演示环境');
  });
});
