import type { ReactNode } from 'react';

export function PageHeader({ title, count, actions }: { title: string; count?: number; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <h1 className="uppercase tracking-wide text-sm text-text">{title}</h1>
        {count !== undefined && <span className="font-mono text-xs text-text-muted">{count}</span>}
      </div>
      {actions}
    </div>
  );
}
