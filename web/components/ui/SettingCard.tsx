import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** One settings card: an icon chip, title + optional description, and the control below. `tone`
 *  switches the chip to the accent palette (used for the active/primary card in a group). */
export function SettingCard({ title, description, icon: Icon, tone = 'default', children }: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'accent';
  children: ReactNode;
}) {
  const chip = tone === 'accent'
    ? 'border-accent/40 bg-accent/10 text-accent'
    : 'border-border bg-elevated text-text-muted';
  return (
    <div className="card-interactive flex flex-col gap-3.5 rounded-xl border border-border bg-surface p-5">
      <div className="flex items-start gap-3">
        {Icon ? (
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${chip}`}>
            <Icon size={15} aria-hidden />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-text">{title}</span>
          {description ? <span className="text-xs leading-relaxed text-text-muted">{description}</span> : null}
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
