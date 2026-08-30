export type StaticAppPath =
  | '/workbench'
  | '/admin'
  | '/admin/shops'
  | '/admin/products'
  | '/admin/knowledge'
  | '/admin/knowledge/candidates'
  | '/admin/knowledge/conflicts'
  | '/admin/workflows'
  | '/admin/quality'
  | '/admin/incidents'
  | '/admin/usage'
  | '/admin/privacy'
  | '/buyer-simulator'
  | '/scenario-lab'
  | '/showcase';

export type AppPath = StaticAppPath
  | `/workbench/shops/${string}`
  | `/live-test/${string}`;

export interface NavigationItem {
  path: StaticAppPath;
  label: string;
  note: string;
}

export const navigationItems: NavigationItem[] = [
  { path: '/workbench', label: '工作台', note: 'Live desk' },
  { path: '/buyer-simulator', label: '买家模拟器', note: 'Buyer view' },
  { path: '/admin', label: '运营后台', note: 'Control room' },
  { path: '/scenario-lab', label: '场景实验室', note: 'Scenarios' },
];

export const navIcons: Record<StaticAppPath, string> = {
  '/workbench': '⌘',
  '/buyer-simulator': '↗',
  '/admin': '▦',
  '/admin/shops': '▦',
  '/admin/products': '▦',
  '/admin/knowledge': '▦',
  '/admin/knowledge/candidates': '▦',
  '/admin/knowledge/conflicts': '▦',
  '/admin/workflows': '▦',
  '/admin/quality': '▦',
  '/admin/incidents': '▦',
  '/admin/usage': '▦',
  '/admin/privacy': '⌁',
  '/scenario-lab': '◌',
  '/showcase': '▶',
};

const canonicalPaths = new Set<StaticAppPath>([
  ...navigationItems.map((item) => item.path),
  '/admin/shops',
  '/admin/products',
  '/admin/knowledge',
  '/admin/knowledge/candidates',
  '/admin/knowledge/conflicts',
  '/admin/workflows',
  '/admin/quality',
  '/admin/incidents',
  '/admin/usage',
  '/admin/privacy',
  '/showcase',
]);

export function resolveAppPath(pathname: string): AppPath {
  if (pathname === '/admin/overview') return '/admin';
  if (pathname === '/products') return '/admin/products';
  if (pathname === '/knowledge') return '/admin/knowledge';
  if (/^\/workbench\/shops\/[^/]+(?:\/settings|\/knowledge\/import)?$/.test(pathname)) return pathname as AppPath;
  if (/^\/live-test\/[^/]+$/.test(pathname)) return pathname as AppPath;
  return canonicalPaths.has(pathname as StaticAppPath) ? pathname as StaticAppPath : '/workbench';
}

export type WorkbenchRoute =
  | { kind: 'home' }
  | { kind: 'shop'; shopId: string }
  | { kind: 'settings'; shopId: string }
  | { kind: 'knowledge-import'; shopId: string };

export function matchWorkbenchRoute(pathname: string): WorkbenchRoute {
  if (pathname === '/workbench') return { kind: 'home' };
  const match = pathname.match(/^\/workbench\/shops\/([^/]+)(?:\/(settings)|\/(knowledge\/import))?$/);
  if (!match) return { kind: 'home' };
  const shopId = decodeURIComponent(match[1] ?? '');
  if (match[2]) return { kind: 'settings', shopId };
  if (match[3]) return { kind: 'knowledge-import', shopId };
  return { kind: 'shop', shopId };
}

export function shopWorkbenchPath(shopId: string): `/workbench/shops/${string}` {
  return `/workbench/shops/${encodeURIComponent(shopId)}`;
}
