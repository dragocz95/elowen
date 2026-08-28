import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { Button } from './Button';
import { useTranslation } from '../../lib/i18n';

/** "There is nothing here", said once. The parts are named — `empty-state__*` — for the same reason the
 *  field and the toolbar are: this block appears inside every register in the app, so a design has to be
 *  able to restate it without every module passing a prop about how it should look. */
export function EmptyState({ title, description, icon: Icon, action }: { title: string; description?: string; icon?: LucideIcon; action?: ReactNode }) {
  return (
    <div className="empty-state flex animate-fade-up flex-col items-center justify-center gap-3 py-14 text-center">
      {Icon ? <Icon size={28} strokeWidth={1.25} className="empty-state__icon text-text-muted/40" aria-hidden /> : null}
      <div className="flex flex-col gap-1">
        <p className="empty-state__title text-sm uppercase tracking-wide text-text">{title}</p>
        {description && <p className="empty-state__description text-xs text-text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

const SPINNER_PX = { xs: 10, sm: 13, md: 16, lg: 40 } as const;

/** The turning-circle indicator, in the four sizes the app actually uses. Fixed sizes rather than a free
 *  number, because every one of them is a deliberate fit for its surroundings — a tool pill, a button, a
 *  full-screen overlay — and a free prop is how four sizes quietly become eight.
 *
 *  Without `label` it is `aria-hidden`: a spinner next to its own visible text would be announced twice. */
export function Spinner({ size = 'sm', tone = 'text-text-muted', label }: { size?: keyof typeof SPINNER_PX; tone?: string; label?: string }) {
  return (
    <Loader2
      size={SPINNER_PX[size]}
      className={`shrink-0 animate-spin ${tone}`}
      {...(label ? { role: 'status' as const, 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}

/** Loading as a LINE OF TEXT, for the places a skeleton would be wrong: inside a dropdown, a monospace
 *  log tail, a single field. `inline` deliberately inherits the parent's typography — those sit among
 *  sibling rows and should match them rather than the rest of the app. */
export function LoadingLine({ label, layout = 'block', spinner = false }: { label?: string; layout?: 'inline' | 'block' | 'page'; spinner?: boolean }) {
  const { t } = useTranslation();
  const box = layout === 'page'
    ? 'flex h-screen items-center justify-center gap-2'
    : layout === 'block' ? 'flex items-center justify-center gap-2 py-8' : 'inline-flex items-center gap-1.5';
  return (
    <span className={box} role="status" aria-live="polite">
      {spinner ? <Spinner size={layout === 'inline' ? 'xs' : 'md'} /> : null}
      <span className={`text-text-muted ${spinner ? '' : 'animate-pulse'} ${layout === 'inline' ? '' : 'font-mono text-xs'}`}>{label ?? t.common.loading}</span>
    </span>
  );
}

type SkeletonVariant = 'list' | 'cards' | 'kanban' | 'block';

/** Skeleton placeholder shaped like the real content so the layout doesn't pop in. */
export function LoadingState({ variant = 'list', height = 'h-28' }: { variant?: SkeletonVariant; height?: string }) {
  const { t } = useTranslation();
  // One plain block, for a chart or panel whose shape says nothing useful while it is empty. Goes through
  // `.skeleton` like every other variant, so it obeys the reduced-effects setting for free.
  if (variant === 'block') return <div className={`skeleton w-full rounded-md ${height}`} aria-busy="true" aria-label={t.common.loading} />;

  if (variant === 'cards') {
    return (
      <div className="@container" aria-busy="true" aria-label={t.common.loading}>
      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @3xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-3" style={{ boxShadow: 'var(--shadow-card)' }}>
            <div className="flex items-center gap-2.5">
              <div className="skeleton h-9 w-9 rounded-lg" />
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="skeleton h-3.5 w-2/3 rounded" />
                <div className="skeleton h-3 w-1/3 rounded" />
              </div>
            </div>
            <div className="skeleton h-6 w-full rounded-md" />
          </div>
        ))}
      </div>
      </div>
    );
  }

  if (variant === 'kanban') {
    return (
      <div className="flex gap-3 overflow-hidden" aria-busy="true" aria-label={t.common.loading}>
        {[0, 1, 2, 3, 4].map((c) => (
          <div key={c} className="flex min-w-[14rem] flex-1 flex-col gap-2 rounded-lg border border-border bg-surface p-2">
            <div className="skeleton h-3 w-20 rounded" />
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-12 w-full rounded-md" />)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 py-2" aria-busy="true" aria-label={t.common.loading}>
      {[88, 72, 80, 64].map((w, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="skeleton h-4 w-4 rounded-md" />
          <div className="skeleton h-3.5 rounded" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <p className="text-sm text-accent">{message}</p>
      {onRetry && <Button onClick={onRetry}>{t.common.retry}</Button>}
    </div>
  );
}
