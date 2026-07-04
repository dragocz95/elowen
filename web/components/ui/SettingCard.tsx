import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { HelpTip } from './HelpTip';

/** One settings card: an icon chip, title + optional description, and the control below. `tone`
 *  switches the chip to the accent palette (used for the active/primary card in a group).
 *  `description` renders as a HelpTip (?) next to the title rather than as text below it. */
export function SettingCard({ title, description, icon: Icon, tone = 'default', className, children }: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'accent';
  /** Extra classes on the card root — e.g. `@sm:col-span-2` to span a two-column settings grid. */
  className?: string;
  children: ReactNode;
}) {
  const chip = tone === 'accent'
    ? 'border-accent/40 bg-accent/10 text-accent'
    : 'border-border bg-elevated text-text-muted';
  return (
    <div className={`card-interactive flex flex-col gap-3.5 rounded-xl border border-border bg-surface p-5 ${className ?? ''}`}>
      <div className="flex items-start gap-3">
        {Icon ? (
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${chip}`}>
            <Icon size={15} aria-hidden />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm font-medium text-text">
            {title}
            {description ? <HelpTip align="left">{description}</HelpTip> : null}
          </span>
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
