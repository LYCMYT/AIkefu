import { useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ className = '', variant = 'secondary', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button className={`ui-button is-${variant} ${className}`.trim()} type={type} {...props} />;
}

export function IconButton({ label, className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button aria-label={label} className={`ui-icon-button ${className}`.trim()} title={label} type={type} {...props} />;
}

export function Card({ className = '', ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`ui-card ${className}`.trim()} {...props} />;
}

export function Badge({ className = '', ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`ui-badge ${className}`.trim()} {...props} />;
}

export function StatusBadge({ tone = 'neutral', className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }) {
  return <span className={`ui-status-badge is-${tone} ${className}`.trim()} {...props} />;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="ui-page-header"><div>{eyebrow && <span className="ui-eyebrow">{eyebrow}</span>}<h2>{title}</h2>{description && <p>{description}</p>}</div>{actions && <div className="ui-page-actions">{actions}</div>}</header>;
}

interface TabItem<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function SegmentedTabs<T extends string>({ label, value, items, onChange }: { label: string; value: T; items: Array<TabItem<T>>; onChange: (value: T) => void }) {
  return <div aria-label={label} className="ui-segmented-tabs" role="tablist">{items.map((item) => <button aria-selected={item.value === value} className={item.value === value ? 'is-active' : ''} key={item.value} onClick={() => onChange(item.value)} role="tab" type="button">{item.label}{item.count !== undefined && <Badge>{item.count}</Badge>}</button>)}</div>;
}

export function Drawer({ open, title, onClose, children, className = '' }: { open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string }) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  return <div className="ui-drawer-layer"><button aria-label={`关闭${title}`} className="ui-drawer-backdrop" onClick={onClose} type="button" /><aside aria-label={title} aria-modal="true" className={`ui-drawer ${className}`.trim()} role="dialog"><header><h2>{title}</h2><IconButton label={`关闭${title}`} onClick={onClose}><X aria-hidden="true" size={18} /></IconButton></header><div className="ui-drawer-body">{children}</div></aside></div>;
}

export function ConfirmDialog({ open, title, description, confirmLabel = '确认', busy = false, onCancel, onConfirm }: { open: boolean; title: string; description: string; confirmLabel?: string; busy?: boolean; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    if (!open || busy) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel, open]);
  if (!open) return null;
  return <div className="ui-dialog-layer"><button aria-label="关闭确认窗口" className="ui-dialog-backdrop" disabled={busy} onClick={onCancel} type="button" /><section aria-labelledby="ui-confirm-title" aria-modal="true" className="ui-confirm-dialog" role="dialog"><span className="ui-confirm-mark">!</span><h2 id="ui-confirm-title">{title}</h2><p>{description}</p><div><Button disabled={busy} onClick={onCancel} variant="secondary">取消</Button><Button disabled={busy} onClick={onConfirm} variant="danger">{busy ? '处理中…' : confirmLabel}</Button></div></section></div>;
}
