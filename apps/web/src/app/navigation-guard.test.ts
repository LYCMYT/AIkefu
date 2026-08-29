import { describe, expect, it, vi } from 'vitest';
import { confirmNavigation } from './navigation-guard';

describe('confirmNavigation', () => {
  it('allows clean or same-route navigation without prompting', () => {
    const confirm = vi.fn(() => false);
    expect(confirmNavigation(false, '/workbench/shops/shop-1/settings', '/buyer-simulator', confirm)).toBe(true);
    expect(confirmNavigation(true, '/workbench/shops/shop-1/settings', '/workbench/shops/shop-1/settings', confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('blocks a dirty settings route when the user declines', () => {
    const confirm = vi.fn(() => false);
    expect(confirmNavigation(true, '/workbench/shops/shop-1/settings', '/buyer-simulator', confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith('设置尚未保存，确认离开吗？');
  });

  it('allows a dirty settings route when the user confirms', () => {
    const confirm = vi.fn(() => true);
    expect(confirmNavigation(true, '/workbench/shops/shop-1/settings', '/admin', confirm)).toBe(true);
  });
});
