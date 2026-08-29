import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { matchWorkbenchRoute, resolveAppPath } from './app/routes';
import { EmptyStoreHome } from './features/workbench/EmptyStoreHome';
import { StoreContextMenu } from './features/workbench/StoreContextMenu';
import { conversationAiState } from './features/workbench/workbench-model';

describe('frontend product rearchitecture', () => {
  it('recognizes the shop, settings, and dedicated knowledge import routes', () => {
    expect(resolveAppPath('/workbench/shops/shop-01')).toBe('/workbench/shops/shop-01');
    expect(matchWorkbenchRoute('/workbench/shops/shop-01/settings')).toEqual({ kind: 'settings', shopId: 'shop-01' });
    expect(matchWorkbenchRoute('/workbench/shops/shop-01/knowledge/import')).toEqual({ kind: 'knowledge-import', shopId: 'shop-01' });
  });

  it('renders a truthful zero-shop home with one primary action and six real capabilities', () => {
    const html = renderToStaticMarkup(<MemoryRouter><EmptyStoreHome busy={false} error="" onCreate={async () => undefined} /></MemoryRouter>);
    expect(html).toContain('添加店铺');
    expect(html).toContain('MockDouyin');
    expect((html.match(/workbench-capability-card/g) ?? []).length).toBe(6);
    expect(html).not.toContain('免费用户');
    expect(html).not.toContain('值班中');
    expect(html).not.toContain('未登录');
  });

  it('exposes the four store actions through an accessible menu', () => {
    const html = renderToStaticMarkup(<MemoryRouter><StoreContextMenu open shopId="shop-01" anchor={{ x: 24, y: 48 }} onClose={() => undefined} onShopChange={() => undefined} /></MemoryRouter>);
    for (const label of ['基础设置', '导入知识', 'AI管理中心', '打开实时联调']) expect(html).toContain(label);
    expect(html).toContain('role="menu"');
  });

  it('compresses runtime detail into four customer-service AI states', () => {
    expect(conversationAiState({ humanActive: true })).toBe('已停止');
    expect(conversationAiState({ currentDraft: { status: 'GENERATING' } })).toBe('生成中');
    expect(conversationAiState({ currentDraft: { status: 'WAITING_HUMAN' } })).toBe('需要人工');
    expect(conversationAiState({ sendOutbox: { status: 'SENT' } })).toBe('已自动发送');
  });
});
