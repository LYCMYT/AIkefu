import type { ReactNode } from 'react';
import { Activity, BarChart3, ChevronDown, Eye, FlaskConical, MessageSquareText, RefreshCw, ShoppingBag } from 'lucide-react';
import { navigationItems, type AppPath } from '../../app/routes';
import { modeLabel, shortId } from '../../features/shared/view-models';
import { Button } from '../ui/primitives';

interface ShellShop {
  id: string;
  name: string;
  aiMode: string;
  connectionState: string;
}

const iconByPath = {
  '/workbench': MessageSquareText,
  '/buyer-simulator': ShoppingBag,
  '/admin': BarChart3,
  '/scenario-lab': FlaskConical,
} satisfies Partial<Record<AppPath, typeof MessageSquareText>>;

export interface AppShellProps {
  activePath: AppPath;
  activeShopId: string;
  children: ReactNode;
  isResetting: boolean;
  onNavigate: (path: AppPath) => void;
  onReset: () => void;
  onShopChange: (shopId: string) => void;
  onTraceToggle: () => void;
  routeTitle: string;
  shops: ShellShop[];
  socketLabel: string;
  socketReady: boolean;
  traceOpen: boolean;
  workspaceId?: string;
}

export function AppShell({ activePath, activeShopId, children, isResetting, onNavigate, onReset, onShopChange, onTraceToggle, routeTitle, shops, socketLabel, socketReady, traceOpen, workspaceId }: AppShellProps) {
  const activeNav = activePath.startsWith('/admin/') ? navigationItems.find((item) => item.path === '/admin')! : navigationItems.find((item) => item.path === activePath) ?? navigationItems[0]!;
  const activeShop = shops.find((shop) => shop.id === activeShopId) ?? shops[0];

  return <main className={`app-shell route-${activePath.slice(1)}`}>
    <aside aria-label="主导航" className="sidebar">
      <a className="brand" href="/workbench" onClick={(event) => { event.preventDefault(); onNavigate('/workbench'); }}><span className="brand-mark">AI</span><span className="brand-copy"><strong>AIkefu</strong><small>智能客服控制台</small></span></a>
      <div className="workspace-switcher"><span className="workspace-avatar">W</span><div><small>当前 Workspace</small><strong>{shortId(workspaceId)}</strong></div><ChevronDown aria-hidden="true" size={16} /></div>
      <nav aria-label="Primary" className="navigation">{navigationItems.map((item) => {
        const Icon = iconByPath[item.path as keyof typeof iconByPath] ?? MessageSquareText;
        const selected = item.path === activePath || (item.path === '/admin' && activePath.startsWith('/admin/'));
        return <a aria-current={selected ? 'page' : undefined} className={`nav-item ${selected ? 'is-active' : ''}`} href={item.path} key={item.path} onClick={(event) => { event.preventDefault(); onNavigate(item.path); }}><Icon aria-hidden="true" className="nav-icon" size={19} /><span className="nav-label"><strong>{item.label}</strong><small>{item.note}</small></span></a>;
      })}</nav>
      <div className="sidebar-divider" />
      <div className="sidebar-shortcuts"><span className="overline">快捷入口</span><button onClick={() => onNavigate('/buyer-simulator')} type="button"><ShoppingBag aria-hidden="true" size={16} />打开买家模拟器</button><button onClick={onTraceToggle} type="button"><Eye aria-hidden="true" size={16} />Developer Trace <i className={traceOpen ? 'is-on' : ''} /></button></div>
      <div className="sidebar-footer"><Activity aria-hidden="true" size={15} /><span className={`status-dot ${socketReady ? 'is-ready' : ''}`} /><span>{socketLabel}</span><small>MockDouyin</small></div>
    </aside>
    <section className="content">
      <header className="topbar"><div className="topbar-title"><div className="breadcrumb"><span>AIkefu</span><i>/</i><span>{activeNav.label}</span></div><h1>{routeTitle}</h1></div><div className="topbar-actions">
        <label className="global-shop-switcher"><span className={`shop-status-dot is-${(activeShop?.connectionState ?? 'DISCONNECTED').toLowerCase()}`} /><span className="sr-only">切换店铺</span><select aria-label="切换店铺" onChange={(event) => onShopChange(event.currentTarget.value)} value={activeShop?.id ?? ''}>{shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name} · {modeLabel(shop.aiMode)}</option>)}</select><ChevronDown aria-hidden="true" size={15} /></label>
        <button className={`trace-toggle ${traceOpen ? 'is-on' : ''}`} onClick={onTraceToggle} type="button"><Eye aria-hidden="true" size={16} />Trace</button>
        <Button aria-label="Reset demo" className="shell-reset-button" disabled={isResetting} onClick={onReset} variant="secondary"><RefreshCw aria-hidden="true" className={isResetting ? 'is-spinning' : ''} size={16} />{isResetting ? '重置中…' : 'Reset demo'}</Button>
        <span aria-label="当前用户" className="user-avatar">A</span>
      </div></header>
      {children}
      <footer className="page-footer"><span>AIkefu · 当前 Workspace 隔离</span><span>API READY · {socketLabel}</span></footer>
    </section>
  </main>;
}
