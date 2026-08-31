import type { ReactNode } from 'react';
import { Activity, BarChart3, BookOpenCheck, ChevronDown, Eye, FlaskConical, GitBranch, GraduationCap, LayoutDashboard, MessageSquareText, RefreshCw, ShieldCheck, ShieldX, ShoppingBag, Store, UsersRound } from 'lucide-react';
import { navigationItems, type AppPath, type StaticAppPath } from '../../app/routes';
import { modeLabel, shortId } from '../../features/shared/view-models';
import { Button } from '../ui/primitives';

interface ShellShop { id: string; name: string; aiMode: string; connectionState: string; }
const iconByPath: Partial<Record<StaticAppPath, typeof MessageSquareText>> = { '/workbench': MessageSquareText, '/buyer-simulator': ShoppingBag, '/admin': BarChart3, '/scenario-lab': FlaskConical };
const adminGroups = [
  { label: '工作台', items: [{ path: '/admin' as const, label: '总览', icon: LayoutDashboard }] },
  { label: '店铺与学习', items: [{ path: '/admin/shops' as const, label: '店铺管理', icon: Store }, { path: '/admin/products' as const, label: '商品学习', icon: GraduationCap }] },
  { label: 'AI 控制中心', items: [{ path: '/admin/knowledge' as const, label: '知识管理', icon: BookOpenCheck }, { path: '/admin/workflows' as const, label: 'AI Agent 工作流', icon: GitBranch }, { path: '/admin/quality' as const, label: '质检', icon: ShieldCheck }, { path: '/admin/incidents' as const, label: '错误治理', icon: ShieldX }] },
  { label: '运行与安全', items: [{ path: '/admin/usage' as const, label: 'Usage', icon: Activity }, { path: '/admin/privacy' as const, label: '数据与隐私', icon: UsersRound }] },
] as const;

export interface AppShellProps {
  activePath: AppPath; activeShopId: string; children: ReactNode; isResetting: boolean;
  onNavigate: (path: AppPath) => void; onReset: () => void; onShopChange: (shopId: string) => void;
  onTraceToggle: () => void; routeTitle: string; shops: ShellShop[]; socketLabel: string;
  socketReady: boolean; traceOpen: boolean; workspaceId?: string;
  recordingMode?: boolean;
}

function Brand({ dark = false, onNavigate }: { dark?: boolean; onNavigate: (path: AppPath) => void }) {
  return <a className={`brand ${dark ? 'is-dark' : ''}`} href="/workbench" onClick={(event) => { event.preventDefault(); onNavigate('/workbench'); }}><span className="brand-mark">AI</span><span className="brand-copy"><strong>AIkefu</strong><small>智能客服控制台</small></span></a>;
}

function ModuleNavigation({ activePath, onNavigate }: Pick<AppShellProps, 'activePath' | 'onNavigate'>) {
  return <nav aria-label="产品模块" className="module-navigation">{navigationItems.map((item) => { const Icon = iconByPath[item.path] ?? MessageSquareText; const selected = item.path === '/workbench' ? activePath.startsWith('/workbench') : item.path === '/admin' ? activePath.startsWith('/admin') : activePath === item.path; return <a aria-current={selected ? 'page' : undefined} className={`nav-item ${selected ? 'is-active' : ''}`} href={item.path} key={item.path} onClick={(event) => { event.preventDefault(); onNavigate(item.path); }}><Icon aria-hidden="true" className="nav-icon" size={18} /><span className="nav-label"><strong>{item.label}</strong></span></a>; })}</nav>;
}

function ShopSelect({ activeShopId, onShopChange, shops }: Pick<AppShellProps, 'activeShopId' | 'onShopChange' | 'shops'>) {
  const activeShop = shops.find((shop) => shop.id === activeShopId) ?? shops[0];
  if (!activeShop) return null;
  return <label className="global-shop-switcher"><span className={`shop-status-dot is-${activeShop.connectionState.toLowerCase()}`} /><span className="sr-only">切换店铺</span><select aria-label="切换店铺" onChange={(event) => onShopChange(event.currentTarget.value)} value={activeShop.id}>{shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name} · {modeLabel(shop.aiMode)}</option>)}</select><ChevronDown aria-hidden="true" size={15} /></label>;
}

function TopActions(props: AppShellProps & { showTrace: boolean }) {
  return <div className="topbar-actions"><ShopSelect {...props} />{props.showTrace && <button className={`trace-toggle ${props.traceOpen ? 'is-on' : ''}`} onClick={props.onTraceToggle} type="button"><Eye aria-hidden="true" size={16} />调试</button>}<Button aria-label="重置演示" className="shell-reset-button" disabled={props.isResetting} onClick={props.onReset} variant="secondary"><RefreshCw aria-hidden="true" className={props.isResetting ? 'is-spinning' : ''} size={16} />{props.isResetting ? '重置中…' : '重置演示'}</Button><span aria-label={`服务状态：${props.socketLabel}`} className={`connection-pill ${props.socketReady ? 'is-ready' : ''}`}><i />{props.socketLabel}</span></div>;
}

export function AppShell(props: AppShellProps) {
  const { activePath, children, onNavigate, routeTitle, socketLabel, socketReady, workspaceId } = props;
  if (props.recordingMode) return <main className="recording-shell">{children}</main>;
  const isAdmin = activePath.startsWith('/admin');
  const isWorkbench = activePath.startsWith('/workbench');
  if (isAdmin) return <main className="app-shell admin-shell"><aside aria-label="AI管理中心导航" className="sidebar admin-sidebar"><Brand onNavigate={onNavigate} /><div className="workspace-switcher"><span className="workspace-avatar">W</span><div><small>演示 Workspace</small><strong>{shortId(workspaceId)}</strong></div></div><nav className="admin-navigation">{adminGroups.map((group) => <section key={group.label}><span>{group.label}</span>{group.items.map(({ path, label, icon: Icon }) => { const selected = path === '/admin' ? activePath === '/admin' : activePath.startsWith(path); return <a aria-current={selected ? 'page' : undefined} className={selected ? 'is-active' : ''} href={path} key={path} onClick={(event) => { event.preventDefault(); onNavigate(path); }}><Icon aria-hidden="true" size={17} />{label}</a>; })}</section>)}</nav><button className="admin-return-workbench" onClick={() => onNavigate('/workbench')} type="button"><MessageSquareText size={17} />返回工作台</button><div className="sidebar-footer"><Activity aria-hidden="true" size={15} /><span className={`status-dot ${socketReady ? 'is-ready' : ''}`} /><span>{socketLabel}</span><small>MockDouyin</small></div></aside><section className="content admin-content"><header className="topbar admin-topbar"><div className="topbar-title"><div className="breadcrumb"><span>AI管理中心</span><i>/</i><span>{routeTitle}</span></div><h1>{routeTitle}</h1></div><TopActions {...props} showTrace={false} /></header>{children}<footer className="page-footer"><span>AIkefu AI管理中心</span><span>真实 Workspace 数据 · {socketLabel}</span></footer></section></main>;
  return <main className={`module-shell ${isWorkbench ? 'workbench-shell' : 'standalone-shell'}`}><header className="module-topbar"><Brand dark onNavigate={onNavigate} /><ModuleNavigation activePath={activePath} onNavigate={onNavigate} /><div className="module-topbar-status"><span className={`status-dot ${socketReady ? 'is-ready' : ''}`} />{socketLabel}</div></header><section className="module-content"><header className="topbar module-pagebar"><div className="topbar-title"><div className="breadcrumb"><span>{isWorkbench ? '工作台' : '独立模块'}</span><i>/</i><span>{routeTitle}</span></div><h1>{routeTitle}</h1></div><TopActions {...props} showTrace={isWorkbench} /></header>{children}<footer className="page-footer"><span>AIkefu · MockDouyin 演示环境</span><span>Workspace {shortId(workspaceId)} · {socketLabel}</span></footer></section></main>;
}
