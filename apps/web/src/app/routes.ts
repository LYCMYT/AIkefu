export type AppPath =
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
  | '/scenario-lab';

export interface NavigationItem {
  path: AppPath;
  label: string;
  note: string;
}

export const navigationItems: NavigationItem[] = [
  { path: '/workbench', label: '工作台', note: 'Live desk' },
  { path: '/buyer-simulator', label: '买家模拟器', note: 'Buyer view' },
  { path: '/admin', label: '运营后台', note: 'Control room' },
  { path: '/scenario-lab', label: '场景实验室', note: 'Scenarios' },
];

export const navIcons: Record<AppPath, string> = {
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
};

const canonicalPaths = new Set<AppPath>([
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
]);

export function resolveAppPath(pathname: string): AppPath {
  if (pathname === '/admin/overview') return '/admin';
  if (pathname === '/products') return '/admin/products';
  if (pathname === '/knowledge') return '/admin/knowledge';
  return canonicalPaths.has(pathname as AppPath) ? pathname as AppPath : '/workbench';
}
