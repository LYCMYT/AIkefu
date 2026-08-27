import { describe, expect, it } from 'vitest';
import { navigationItems, resolveAppPath } from './routes';

describe('application routes', () => {
  it('keeps aliases canonical and unknown paths fail closed to Workbench', () => {
    expect(resolveAppPath('/admin/overview')).toBe('/admin');
    expect(resolveAppPath('/products')).toBe('/admin/products');
    expect(resolveAppPath('/not-a-route')).toBe('/workbench');
  });

  it('keeps exactly four primary product entries', () => {
    expect(navigationItems.map((item) => item.path)).toEqual([
      '/workbench',
      '/buyer-simulator',
      '/admin',
      '/scenario-lab',
    ]);
  });
});
