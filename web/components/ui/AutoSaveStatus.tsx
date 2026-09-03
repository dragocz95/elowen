'use client';
import { TriangleAlert } from 'lucide-react';
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

/** Subtle auto-save indicator. Idle and success are silent; saving, delayed activation and errors stay
 * visible. Selection controls save as the user chooses, so a green "Saved" after every model, project or
 * setting change is noise — failure is the state that needs a durable action. */
export function AutoSaveStatus({ status, onRetry, errorKind, onReload, onMerge }: AutoSaveStatusProps) {
  const { t } = useTranslation();
  if (status === 'idle' || status === 'saved') return <span className="text-xs text-muted-foreground" role="status" aria-live="polite" />;
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
