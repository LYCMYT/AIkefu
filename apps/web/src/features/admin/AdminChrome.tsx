import { useNavigate } from 'react-router-dom';
import type { AppPath } from '../../app/routes';

export type AdminSection = 'overview' | 'shops' | 'products' | 'knowledge' | 'workflows' | 'quality' | 'incidents' | 'usage' | 'privacy';

export function AdminTabs({ active }: { active: AdminSection }) {
  const navigate = useNavigate();
  const tabs: Array<{ key: AdminSection; path: AppPath; label: string; note: string }> = [
    { key: 'overview', path: '/admin', label: '总览', note: 'Overview' },
    { key: 'shops', path: '/admin/shops', label: '店铺', note: 'Shops' },
    { key: 'products', path: '/admin/products', label: '商品学习', note: 'Products' },
    { key: 'knowledge', path: '/admin/knowledge', label: '知识运营', note: 'Knowledge' },
    { key: 'workflows', path: '/admin/workflows', label: '工作流', note: 'Workflow' },
    { key: 'quality', path: '/admin/quality', label: '质检', note: 'Quality' },
    { key: 'incidents', path: '/admin/incidents', label: '错误治理', note: 'Incidents' },
    { key: 'usage', path: '/admin/usage', label: '用量', note: 'Usage' },
    { key: 'privacy', path: '/admin/privacy', label: '数据与隐私', note: 'Privacy' },
  ];
  return <div className="admin-tabs" role="tablist" aria-label="运营模块">{tabs.map((tab) => <a aria-selected={active === tab.key} className={active === tab.key ? 'is-active' : ''} href={tab.path} key={tab.path} onClick={(event) => { event.preventDefault(); navigate(tab.path); }} role="tab">{tab.label} <small>{tab.note}</small></a>)}</div>;
}

export function AdminPageHeader({ overline, title, description }: { overline: string; title: string; description: string }) {
  return <section className="admin-page-header panel-surface"><div><span className="overline">{overline}</span><h2>{title}</h2><p>{description}</p></div><span className="observe-only">REST SNAPSHOT</span></section>;
}
