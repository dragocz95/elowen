import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** Sticky, compact module toolbar — replaces PageHeader + a Section header on operational
 *  pages. Holds title, count, and a right-aligned actions/toggles slot. */
export function ModuleHeader({ title, count, icon: Icon, children }: { title: string; count?: number; icon?: LucideIcon; children?: ReactNode }) {
  return (
    <div className="z-20 -mx-4 -mt-4 mb-5 flex flex-col gap-2 border-b border-border bg-bg px-4 py-3 md:sticky md:top-0 md:flex-row md:flex-wrap md:items-center md:gap-x-3">
      <div className="flex items-center gap-2">
        {Icon ? <Icon size={16} className="shrink-0 text-text-muted" aria-hidden /> : null}
        <h1 className="text-base font-semibold tracking-tight text-text">{title}</h1>
        {count !== undefined ? <span className="rounded-full bg-elevated px-2 py-0.5 font-mono text-[11px] text-text-muted">{count}</span> : null}
      </div>
      {children ? (
        <div className="no-scrollbar -mx-4 flex items-center gap-2 overflow-x-auto px-4 [&>*]:shrink-0 md:mx-0 md:ml-auto md:flex-wrap md:overflow-visible md:px-0">
          {children}
        </div>
      ) : null}
    </div>
  );
}
