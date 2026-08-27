import type { ReactNode } from 'react';

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-glyph" aria-hidden="true">○</span><strong>{title}</strong><p>{detail}</p>{action}</div>;
}

export function LoadingState({ label }: { label: string }) {
  return <div className="phase05-state"><span className="loading-spinner" /><span>{label}</span></div>;
}

export function ErrorState({ message }: { message: string }) {
  return <div className="phase05-state phase05-state-error" role="alert"><span className="error-mark">!</span><div><strong>快照读取失败</strong><p>{message}</p></div></div>;
}
