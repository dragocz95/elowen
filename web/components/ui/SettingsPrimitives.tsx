import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { HelpTip } from './HelpTip';

function Heading({ title, description, icon: Icon }: { title: string; description?: string; icon?: LucideIcon }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {Icon ? (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated text-text-muted">
          <Icon size={15} aria-hidden />
        </span>
      ) : null}
      <span className="min-w-0 truncate text-sm font-medium text-text">{title}</span>
      {description ? <HelpTip align="left">{description}</HelpTip> : null}
    </span>
  );
}

/** A compact one-line setting. On narrow screens the control drops below the label without changing
 *  reading order, while desktop keeps high-density toggles and short inputs easy to scan. */
export function SettingRow({ title, description, icon, children, className = '' }: {
  title: string; description?: string; icon?: LucideIcon; children: ReactNode; className?: string;
}) {
  return (
    <div className={`flex flex-col gap-3 border-b border-border/70 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between ${className}`}>
      <Heading title={title} description={description} icon={icon} />
      <div className="min-w-0 shrink-0 sm:max-w-[58%]">{children}</div>
    </div>
  );
}

/** Groups related rows into one quiet surface instead of giving every switch its own card. */
export function SettingGroup({ title, description, icon, children, className = '' }: {
  title?: string; description?: string; icon?: LucideIcon; children: ReactNode; className?: string;
}) {
  return (
    <section className={`overflow-hidden rounded-xl border border-border bg-surface px-5 ${className}`}>
      {title ? <header className="border-b border-border/70 py-4"><Heading title={title} description={description} icon={icon} /></header> : null}
      <div>{children}</div>
    </section>
  );
}
