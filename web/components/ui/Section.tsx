import type { ReactNode } from 'react';

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-surface border border-border rounded-lg overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
        <h2 className="text-sm font-medium text-text">{title}</h2>
        {actions}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}
