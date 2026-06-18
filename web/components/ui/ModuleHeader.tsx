import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** Sticky, compact module toolbar — replaces PageHeader + a Section header on operational
 *  pages. Holds title, count, and a right-aligned actions/toggles slot. */
export function ModuleHeader({ title, count, icon: Icon, children }: { title: string; count?: number; icon?: LucideIcon; children?: ReactNode }) {
  return (
    <div className="sticky top-0 z-20 -mx-4 -mt-4 mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-bg/80 px-4 py-3 backdrop-blur">
      {Icon ? <Icon size={16} className="shrink-0 text-text-muted" aria-hidden /> : null}
      <h1 className="text-base font-semibold tracking-tight text-text">{title}</h1>
      {count !== undefined ? <span className="rounded-full bg-elevated px-2 py-0.5 font-mono text-[11px] text-text-muted">{count}</span> : null}
      {children ? <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}
