'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { interpolate, useTranslation } from '../../lib/i18n';
import { Button } from './Button';
import { SelectMenu } from './SelectMenu';

/** The rows-per-page steps every register offers unless it says otherwise. Three of them, an order of
 *  magnitude apart end to end: a reader either scans a screenful or wants the whole register at once,
 *  and a longer list is a menu to read rather than a control to use. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export interface PagerProps {
  /** Zero-based index of the visible page — the shape every existing caller already holds. */
  page: number;
  /** Rows per page. `pageCount`, `from` and `to` are derived from it so no caller can drift. */
  pageSize: number;
  /** Total number of rows AFTER filtering — what the range text counts. */
  total: number;
  /** Called with the next zero-based page index. Never called outside `0 … pageCount - 1`. */
  onPageChange: (page: number) => void;
  /** Called with the chosen rows-per-page. Supplying it is what MAKES the select appear: a register whose
   *  page size is not the caller's to choose — one that derives it from the height available, as the brain
   *  session panel does — would otherwise show a control that silently does nothing. The pager cannot own
   *  the value itself for the same reason: the caller is what slices the rows. */
  onPageSizeChange?: (pageSize: number) => void;
  /** Override the offered steps. The current `pageSize` is folded in when it is not one of them, so a
   *  register that starts at 20 still shows what it is actually on. */
  pageSizeOptions?: readonly number[];
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
export function Pager({ page, pageSize, total, onPageChange, onPageSizeChange, pageSizeOptions = PAGE_SIZE_OPTIONS, ariaLabel, className = '' }: PagerProps) {
  const { t } = useTranslation();
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const current = Math.min(Math.max(page, 0), pageCount - 1);
  const from = total === 0 ? 0 : current * pageSize + 1;
  const to = Math.min(total, (current + 1) * pageSize);

  const controlClass = 'pointer-coarse:min-h-[var(--touch-target)] pointer-coarse:min-w-[var(--touch-target)]';
  const labelClass = '@max-[24rem]:hidden';

  // A register already on a size that is not one of the offered steps must still show the size it is on
  // — otherwise the select reads as 25 while the table shows 20 rows. Sorted, so the folded-in value
  // lands in its place rather than at the end.
  const sizes = [...new Set([...pageSizeOptions, pageSize])].sort((a, b) => a - b);

  return (
    <nav
      aria-label={ariaLabel ?? t.pagination.label}
      className={`@container flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border/80 pt-3${className ? ` ${className}` : ''}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 font-mono text-xs text-muted-foreground">
          {interpolate(t.pagination.range, { from, to, total })}
        </span>
        {onPageSizeChange ? (
          // Beside the range, because the two answer one question together: how much of the register you
          // are looking at, and how much of it you asked for. `SelectMenu` is the app's one select, so
          // this inherits the Radix keyboard contract and the app's non-portaled panel policy.
          // A <label> around the trigger would be a label wrapping a BUTTON: the click it forwards
          // arrives on a control that already handled the same press, which is how a select opens and
          // closes again in one gesture. The visible word is decoration here and the accessible name is
          // the identical string on the trigger itself.
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span aria-hidden className={labelClass}>{t.pagination.perPage}</span>
            <SelectMenu
              value={String(pageSize)}
              onChange={(next) => onPageSizeChange(Number(next))}
              label={t.pagination.perPage}
              options={sizes.map((size) => ({ value: String(size), label: String(size) }))}
              className="w-[5.5rem]"
            />
          </div>
        ) : null}
      </div>
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
        <span aria-live="polite" className="min-w-0 px-1 text-center font-mono text-xs text-muted-foreground">
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
