import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from './Button';
import { useTranslation } from '../../lib/i18n';

export function EmptyState({ title, description, icon: Icon, action }: { title: string; description?: string; icon?: LucideIcon; action?: ReactNode }) {
  return (
    <div className="flex animate-fade-up flex-col items-center justify-center gap-3 py-14 text-center">
      {Icon ? <Icon size={28} strokeWidth={1.25} className="text-text-muted/40" aria-hidden /> : null}
      <div className="flex flex-col gap-1">
        <p className="text-sm uppercase tracking-wide text-text">{title}</p>
        {description && <p className="text-xs text-text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

type SkeletonVariant = 'list' | 'cards' | 'kanban';

/** Skeleton placeholder shaped like the real content so the layout doesn't pop in. */
export function LoadingState({ label, variant = 'list' }: { label?: string; variant?: SkeletonVariant }) {
  const { t } = useTranslation();
  if (label) return <div className="flex items-center justify-center py-12 font-mono text-xs text-text-muted animate-pulse">{label}</div>;

  if (variant === 'cards') {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label={t.common.loading}>
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
