import type { ReactNode } from 'react';

/** A page-hero card: a large icon, title + subtitle, a status badge, an optional metadata row, and an
 *  actions slot. Flat OLED styling (hairline border, no shadow). The `icon` node is rendered inside a
 *  48px box; pass an already-styled chip when the icon needs its own colour treatment. */
export function HeroCard({ icon, title, subtitle, badge, meta, actions }: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  meta?: { label: string; value: ReactNode }[];
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          {icon ? <span className="flex h-20 w-20 shrink-0 items-center justify-center">{icon}</span> : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-text">{title}</h2>
              {badge}
            </div>
            {subtitle ? <p className="max-w-prose text-sm leading-relaxed text-text-muted">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
        {meta && meta.length > 0 ? (
          <div className="flex flex-wrap gap-x-8 gap-y-3 border-t border-border pt-4">
            {meta.map((m) => (
              <div key={m.label} className="flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{m.label}</span>
                <span className="text-sm text-text">{m.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
