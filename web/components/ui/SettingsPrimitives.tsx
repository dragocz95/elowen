import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { HelpTip } from './HelpTip';

function Heading({ title, description, icon: Icon }: { title: string; description?: string; icon?: LucideIcon }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      {Icon ? <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border/60 bg-[rgb(255_255_255_/_0.018)] text-text-muted"><Icon size={15} aria-hidden /></span> : null}
      <span className="min-w-0 truncate text-sm font-medium text-text">{title}</span>
      {description ? <HelpTip align="left">{description}</HelpTip> : null}
    </span>
  );
}

/** A single horizontal control-surface row. */
export function SettingRow({ title, description, icon, children, className = '' }: {
  title: string; description?: string; icon?: LucideIcon; children: ReactNode; className?: string;
}) {
  return (
    <div className={`flex flex-col gap-3 border-b border-border/35 py-4.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between ${className}`}>
      <Heading title={title} description={description} icon={icon} />
      <div className="min-w-0 shrink-0 sm:max-w-[58%]">{children}</div>
    </div>
  );
}

/** A logical group without a card shell; groups are separated only by one quiet divider. */
export function SettingGroup({ title, description, icon, children, className = '' }: {
  title?: string; description?: string; icon?: LucideIcon; children: ReactNode; className?: string;
}) {
  return (
    <section className={`overflow-hidden border-b border-border/40 bg-transparent px-1 last:border-b-0 ${className}`}>
      {title ? <header className="border-b border-border/30 py-4"><Heading title={title} description={description} icon={icon} /></header> : null}
      <div>{children}</div>
    </section>
  );
}
