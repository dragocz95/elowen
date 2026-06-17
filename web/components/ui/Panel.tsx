import type { ReactNode } from 'react';

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  const extra = className.trim();
  return <div className={`bg-surface border border-border rounded-lg${extra ? ` ${extra}` : ''}`} style={{ boxShadow: 'var(--shadow-card)' }}>{children}</div>;
}
