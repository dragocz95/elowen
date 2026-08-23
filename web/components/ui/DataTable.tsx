import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

type TableStyle = CSSProperties & {
  '--data-table-columns'?: string;
  '--data-table-compact-columns'?: string;
};

/** Responsive register table. Wide-only cells disappear as a unit and the compact grid closes ranks. */
export function DataTable({ ariaLabel, columns, compactColumns = 'minmax(0,1fr)', children, className = '', ...rest }: {
  ariaLabel: string;
  columns: string;
  compactColumns?: string;
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  const style: TableStyle = { '--data-table-columns': columns, '--data-table-compact-columns': compactColumns };
  return <div role="table" aria-label={ariaLabel} style={style} className={`@container overflow-x-clip rounded-lg border border-border/80 ${className}`} {...rest}>{children}</div>;
}

export function DataTableRow({ children, header = false, selected = false, interactive = false, className = '', ...rest }: {
  children: ReactNode;
  header?: boolean;
  selected?: boolean;
  interactive?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="row"
      data-state={selected ? 'selected' : 'idle'}
      className={`data-table-grid items-center gap-x-3 border-b border-border/70 px-4 last:border-b-0 ${header ? 'data-table-header sticky top-0 z-10 py-2.5' : `py-3.5 ${interactive ? 'interactive-row' : ''}`} ${selected ? 'bg-accent/[0.055]' : ''} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export type SortDirection = 'asc' | 'desc';

/** A column header that sorts the register when clicked, so a table needs no separate sort control.
 *  `direction` describes the current order and is only meaningful while `active` — an inactive column
 *  shows a neutral affordance rather than claiming an order it does not currently impose. */
export function DataTableSortCell({ children, active, direction, onSort, priority = 'always', align = 'start', className = '', ...rest }: {
  children: ReactNode;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
  priority?: 'always' | 'wide';
  align?: 'start' | 'end';
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onClick'>) {
  const Arrow = !active ? ChevronsUpDown : direction === 'asc' ? ChevronUp : ChevronDown;
  return (
    <DataTableCell
      header
      priority={priority}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={className}
      {...rest}
    >
      <button
        type="button"
        onClick={onSort}
        className={`group/sort -mx-1 flex w-full items-center gap-1 rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 ${align === 'end' ? 'justify-end' : ''} ${active ? 'text-text' : 'text-text-muted hover:text-text'}`}
      >
        <span className="truncate">{children}</span>
        {/* The neutral arrow stays laid out but invisible, so a header does not shift when hovered. */}
        <Arrow size={12} aria-hidden className={`shrink-0 ${active ? 'text-accent' : 'opacity-0 transition-opacity group-hover/sort:opacity-60'}`} />
      </button>
    </DataTableCell>
  );
}

export function DataTableCell({ children, header = false, priority = 'always', className = '', ...rest }: {
  children: ReactNode;
  header?: boolean;
  priority?: 'always' | 'wide';
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role={header ? 'columnheader' : 'cell'}
      data-priority={priority}
      className={`${priority === 'wide' ? 'data-table-wide' : ''} min-w-0 ${header ? 'text-[10px] font-semibold uppercase tracking-wider text-text-muted' : ''} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
