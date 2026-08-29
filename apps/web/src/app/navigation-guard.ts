export const UNSAVED_SETTINGS_MESSAGE = '设置尚未保存，确认离开吗？';

/**
 * Keep the route guard side-effect free so every SPA entry point can share
 * exactly the same decision and unit tests can cover the dangerous branches.
 */
export function confirmNavigation(
  dirty: boolean,
  currentPath: string,
  nextPath: string,
  confirm: (message: string) => boolean,
): boolean {
  if (!dirty || currentPath === nextPath) return true;
  return confirm(UNSAVED_SETTINGS_MESSAGE);
}
