import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('keeps the four frozen product entries and exposes the active store switcher', () => {
    const html = renderToStaticMarkup(<AppShell activePath="/workbench" activeShopId="shop-a" isResetting={false} onNavigate={() => undefined} onReset={() => undefined} onShopChange={() => undefined} onTraceToggle={() => undefined} routeTitle="消息工作台" shops={[{ id: 'shop-a', name: '像素数码旗舰店', aiMode: 'ASSIST', connectionState: 'CONNECTED' }]} socketLabel="实时已连接" socketReady traceOpen={false} workspaceId="workspace-123"><div>页面内容</div></AppShell>);

    expect((html.match(/class="nav-item/g) ?? []).length).toBe(4);
    expect(html).toContain('像素数码旗舰店');
    expect(html).toContain('aria-label="切换店铺"');
    expect(html).toContain('页面内容');
    expect(html).toContain('服务状态：实时已连接');
    expect(html).toContain('>调试</button>');
  });

  it('does not expose a dead Trace control outside the Workbench', () => {
    const html = renderToStaticMarkup(<AppShell activePath="/admin" activeShopId="shop-a" isResetting={false} onNavigate={() => undefined} onReset={() => undefined} onShopChange={() => undefined} onTraceToggle={() => undefined} routeTitle="数据概览" shops={[{ id: 'shop-a', name: '像素数码旗舰店', aiMode: 'ASSIST', connectionState: 'CONNECTED' }]} socketLabel="实时已连接" socketReady traceOpen={false} workspaceId="workspace-123"><div>页面内容</div></AppShell>);

    expect(html).not.toContain('>调试</button>');
    expect(html).toContain('服务状态：实时已连接');
  });
});
