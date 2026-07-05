'use client';
import { Check, Loader2, TriangleAlert } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';

/** Subtle, unobtrusive auto-save indicator for a modal footer. Idle renders nothing; error offers a
 *  retry. Uses role="status" (aria-live polite) so a screen reader hears "Saving…/Saved" without
 *  stealing focus; the error is role="alert". */
export function AutoSaveStatus({ status, onRetry }: { status: SaveStatus; onRetry?: () => void }) {
  const { t } = useTranslation();
  if (status === 'idle') return <span className="text-xs text-text-muted" role="status" aria-live="polite" />;
  if (status === 'saving') return (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-muted" role="status" aria-live="polite">
      <Loader2 size={13} className="animate-spin" aria-hidden />{t.common.saving}
    </span>
  );
  if (status === 'saved') return (
    <span className="inline-flex items-center gap-1.5 text-xs text-approve" role="status" aria-live="polite">
      <Check size={13} aria-hidden />{t.common.saved}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-danger" role="alert">
      <TriangleAlert size={13} aria-hidden />{t.common.saveFailed}
      {onRetry ? <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:text-text">{t.common.retry}</button> : null}
    </span>
  );
}
