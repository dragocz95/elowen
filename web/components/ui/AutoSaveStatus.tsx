'use client';
import { Check, TriangleAlert } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { Spinner } from '../ui/states';

export interface AutoSaveStatusProps {
  status: SaveStatus;
  onRetry?: () => void | Promise<void>;
  errorKind?: 'validation' | 'conflict' | 'transport';
  onReload?: () => void;
  onMerge?: () => void;
}

/** Subtle, unobtrusive auto-save indicator for a modal footer. Idle renders nothing; error offers a
 * retry. A successful write whose live activation is delayed remains visibly pending instead of being
 * presented as fully active. */
export function AutoSaveStatus({ status, onRetry, errorKind, onReload, onMerge }: AutoSaveStatusProps) {
  const { t } = useTranslation();
  if (status === 'idle') return <span className="text-xs text-muted-foreground" role="status" aria-live="polite" />;
  if (status === 'saving') return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
      <Spinner size="sm" tone="" />{t.common.saving}
    </span>
  );
  if (status === 'pending') return (
    <span className="inline-flex items-center gap-1.5 text-xs text-warning" role="status" aria-live="polite">
      <Spinner size="sm" tone="" />{t.common.activationPending}
    </span>
  );
  if (status === 'saved') return (
    <span className="inline-flex items-center gap-1.5 text-xs text-success" role="status" aria-live="polite">
      <Check size={13} aria-hidden />{t.common.saved}
    </span>
  );
  if (errorKind === 'conflict') return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-warning" role="alert">
      <TriangleAlert size={13} aria-hidden />{t.common.saveConflict}
      {onReload ? <button type="button" onClick={onReload} className="underline underline-offset-2 hover:text-foreground">{t.common.reloadChanges}</button> : null}
      {onMerge ? <button type="button" onClick={onMerge} className="underline underline-offset-2 hover:text-foreground">{t.common.keepMyChanges}</button> : null}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-destructive" role="alert">
      <TriangleAlert size={13} aria-hidden />{errorKind === 'validation' ? t.common.saveValidationFailed : t.common.saveFailed}
      {errorKind !== 'validation' && onRetry ? <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:text-foreground">{t.common.retry}</button> : null}
    </span>
  );
}
