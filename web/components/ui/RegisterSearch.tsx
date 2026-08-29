'use client';
import { Search, X } from 'lucide-react';
import { Input } from './Input';

export interface RegisterSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name of the field. Falls back to the placeholder — a search box with neither is unnamed. */
  label?: string;
  /** Clears the field. The clear affordance appears only when this AND `clearLabel` are given, because a
   *  button whose only content is an icon must carry a translated name. */
  onClear?: () => void;
  clearLabel?: string;
  /** Number of rows the current query matches, shown as a quiet trailing count. */
  count?: number;
  /** Accessible name for `count` (e.g. "12 results"); the bare number alone means nothing spoken. */
  countLabel?: string;
  className?: string;
}

/**
 * The search field of a register toolbar: leading icon, optional clear button, optional match count.
 *
 * It grows to fill the toolbar (`flex-1`) but is allowed to SHRINK to nothing (`min-w-0` and a basis
 * rather than a minimum width). The copy-pasted original hard-coded `min-w-[15rem]`, so at a 320px
 * viewport the field alone claimed 240px and pushed every sibling control out of the toolbar.
 */
export function RegisterSearch({
  value, onChange, placeholder, label, onClear, clearLabel, count, countLabel, className = '',
}: RegisterSearchProps) {
  const clearable = !!onClear && !!clearLabel && value !== '';
  const showCount = typeof count === 'number';
  // Room for whichever affordances overlay the right edge of the field. Literal classes, because
  // Tailwind cannot see a computed one.
  const trailingPad = clearable && showCount ? 'pr-16' : clearable ? 'pr-9' : showCount ? 'pr-12' : '';

  return (
    <div className={`register-search relative flex min-w-0 flex-1 basis-40 items-center${className ? ` ${className}` : ''}`}>
      <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className={`pl-9 pointer-coarse:h-[var(--touch-target)] [&::-webkit-search-cancel-button]:hidden${trailingPad ? ` ${trailingPad}` : ''}`}
      />
      <div className="pointer-events-none absolute right-2 flex items-center gap-1">
        {showCount ? (
          <span role="status" className="font-mono text-tiny text-muted-foreground">
            <span aria-hidden>{count}</span>
            {countLabel ? <span className="sr-only">{countLabel}</span> : null}
          </span>
        ) : null}
        {clearable ? (
          <button
            type="button"
            aria-label={clearLabel}
            onClick={onClear}
            className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 pointer-coarse:h-[var(--touch-target)] pointer-coarse:w-[var(--touch-target)]"
          >
            <X size={14} aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}
