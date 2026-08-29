import { useEffect, useRef } from 'react';
import { Bot, FlaskConical, Import, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface StoreContextMenuProps {
  anchor: { x: number; y: number };
  onClose: () => void;
  onShopChange: (shopId: string) => void;
  open: boolean;
  shopId: string;
}

export function StoreContextMenu({ anchor, onClose, onShopChange, open, shopId }: StoreContextMenuProps) {
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Realtime workspace refreshes re-render Workbench while this menu is open.
  // Keep the latest callback without restarting the focus-management effect,
  // otherwise its cleanup steals focus back to the trigger mid-keyboard flow.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const items = [
    { label: '基础设置', icon: Settings, path: `/workbench/shops/${encodeURIComponent(shopId)}/settings` },
    { label: '导入知识', icon: Import, path: `/workbench/shops/${encodeURIComponent(shopId)}/knowledge/import` },
    { label: 'AI管理中心', icon: Bot, path: '/admin' },
    { label: '打开实时联调', icon: FlaskConical, path: `/live-test/${encodeURIComponent(shopId)}` },
  ] as const;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = menuRef.current;
    const buttons = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    buttons[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(current + step + buttons.length) % buttons.length]?.focus();
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!menu?.contains(event.target as Node)) onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('mousedown', onPointerDown); returnFocusRef.current?.focus(); };
  }, [open]);

  if (!open) return null;
  return <div aria-label="店铺操作" className="store-context-menu" ref={menuRef} role="menu" style={{ left: `clamp(8px, ${anchor.x}px, calc(100vw - 218px))`, top: `clamp(8px, ${anchor.y}px, calc(100vh - 196px))` }}>{items.map(({ label, icon: Icon, path }) => <button key={label} onClick={() => { onShopChange(shopId); navigate(path); onClose(); }} role="menuitem" type="button"><Icon aria-hidden="true" size={17} /><span>{label}</span></button>)}</div>;
}
