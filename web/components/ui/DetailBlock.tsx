'use client';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { HelpTip } from './HelpTip';

/** A labeled block within a detail pane: a small uppercase caption with an icon, an optional hover
 *  "?" for the explanation, and the content below it. Shared so that a plugin surface showing a
 *  managed selection looks identical to the user detail, rather than re-deriving the same markup. */
export function DetailBlock({ icon: Icon, title, hint, children }: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon size={13} aria-hidden />{title}
        {hint ? <HelpTip align="left">{hint}</HelpTip> : null}
      </span>
      {children}
    </section>
  );
}
