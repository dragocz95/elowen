import { Button } from './Button';
import { useTranslation } from '../../lib/i18n';

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
      <p className="uppercase tracking-wide text-sm text-text">{title}</p>
      {description && <p className="text-xs text-text-muted">{description}</p>}
    </div>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation();
  if (label) return <div className="flex items-center justify-center py-12 font-mono text-xs text-text-muted animate-pulse">{label}</div>;
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
