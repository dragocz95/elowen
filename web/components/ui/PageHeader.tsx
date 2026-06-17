import type { ReactNode } from 'react';

export function PageHeader({ title, count, actions }: { title: string; count?: number; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-5 py-4">
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-lg font-semibold tracking-tight text-text">{title}</h1>
        {count !== undefined && <span className="rounded-full bg-elevated px-2 py-0.5 font-mono text-xs text-text-muted">{count}</span>}
      </div>
      {actions}
    </div>
  );
}
