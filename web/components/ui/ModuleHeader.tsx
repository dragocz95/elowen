import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** Sticky, compact module toolbar for operational pages.
 *  Holds title, count, and a right-aligned actions/toggles slot. */
export function ModuleHeader({ title, count, icon: Icon, children }: { title: string; count?: number; icon?: LucideIcon; children?: ReactNode }) {
  return (
    <div className="z-20 -mx-4 -mt-4 mb-5 flex flex-col gap-2 border-b border-border bg-bg px-4 py-3 md:sticky md:top-0 md:min-h-14 md:flex-row md:flex-wrap md:items-center md:gap-x-3 md:py-0">
      <div className="flex items-center gap-2">
        {Icon ? <Icon size={16} className="shrink-0 text-text-muted" aria-hidden /> : null}
        <h1 className="font-display text-base font-semibold tracking-tight text-text">{title}</h1>
        {count !== undefined ? <span className="rounded-full bg-elevated px-2 py-0.5 font-mono text-[11px] text-text-muted">{count}</span> : null}
      </div>
      {children ? (
        <div className="flex flex-wrap items-center gap-2 md:ml-auto">
          {children}
        </div>
      ) : null}
    </div>
  );
}
