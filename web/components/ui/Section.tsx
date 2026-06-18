import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function Section({ title, icon: Icon, actions, children, index = 0 }: { title: string; icon?: LucideIcon; actions?: ReactNode; children: ReactNode; index?: number }) {
  return (
    <section className="animate-fade-up bg-surface border border-border rounded-lg overflow-hidden" style={{ boxShadow: 'var(--shadow-card)', animationDelay: `${Math.min(index, 6) * 40}ms` }}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          {Icon ? <Icon size={16} className="text-text-muted" aria-hidden /> : null}
          <h2 className="text-sm font-medium text-text">{title}</h2>
        </div>
        {actions}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}
