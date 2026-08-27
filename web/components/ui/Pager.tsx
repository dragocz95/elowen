'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { interpolate, useTranslation } from '../../lib/i18n';
import { Button } from './Button';

export interface PagerProps {
  /** Zero-based index of the visible page — the shape every existing caller already holds. */
  page: number;
  /** Rows per page. `pageCount`, `from` and `to` are derived from it so no caller can drift. */
  pageSize: number;
  /** Total number of rows AFTER filtering — what the range text counts. */
  total: number;
  /** Called with the next zero-based page index. Never called outside `0 … pageCount - 1`. */
  onPageChange: (page: number) => void;
  /** Accessible name of the navigation landmark, e.g. the table it paginates. */
  ariaLabel?: string;
  className?: string;
}

/**
 * The one pager of the app: range on the left, previous / page / next on the right.
 *
 * Divider: a top hairline, never a bottom one. The pager is the FOOTER of the register above it, so the
 * line has to close that block; a bottom border drew a line under the pager and left it floating away
 * from the rows it belongs to.
 *
 * Narrowness is a container query, not a viewport one: the pager also sits inside detail rails and
 * drawers that are narrow on a wide screen. Below the threshold the button labels drop and the controls
 * become icon-only (their accessible names stay), and the whole row wraps rather than overflowing — the
 * previous layout put a fixed-width control row in a non-wrapping flex line, which pushed the "next"
 * button past the right edge of a 320px viewport into `overflow-x-hidden`, making page 2 unreachable
 * with any locale whose label was long enough.
 */
export function Pager({ page, pageSize, total, onPageChange, ariaLabel, className = '' }: PagerProps) {
  const { t } = useTranslation();
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const current = Math.min(Math.max(page, 0), pageCount - 1);
  const from = total === 0 ? 0 : current * pageSize + 1;
  const to = Math.min(total, (current + 1) * pageSize);

  const controlClass = 'pointer-coarse:min-h-[var(--touch-target)] pointer-coarse:min-w-[var(--touch-target)]';
  const labelClass = '@max-[24rem]:hidden';

  return (
    <nav
      aria-label={ariaLabel ?? t.pagination.label}
      className={`@container flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border/80 pt-3${className ? ` ${className}` : ''}`}
    >
      <span className="min-w-0 font-mono text-xs text-text-muted">
        {interpolate(t.pagination.range, { from, to, total })}
      </span>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
        <Button
          variant="ghost"
          icon={ChevronLeft}
          className={controlClass}
          aria-label={t.pagination.previousPage}
          disabled={current === 0}
          onClick={() => onPageChange(current - 1)}
        >
          <span className={labelClass}>{t.pagination.previous}</span>
        </Button>
        <span aria-live="polite" className="min-w-0 px-1 text-center font-mono text-xs text-text-muted">
          {interpolate(t.pagination.pageLabel, { page: current + 1, pages: pageCount })}
        </span>
        <Button
          variant="ghost"
          className={controlClass}
          aria-label={t.pagination.nextPage}
          disabled={current >= pageCount - 1}
          onClick={() => onPageChange(current + 1)}
        >
          <span className={labelClass}>{t.pagination.next}</span>
          <ChevronRight size={14} aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
