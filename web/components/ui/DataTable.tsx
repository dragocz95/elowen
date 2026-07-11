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
  return <div role="table" aria-label={ariaLabel} style={style} className={`@container overflow-x-clip border-y border-border/80 ${className}`} {...rest}>{children}</div>;
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
      className={`data-table-grid items-center gap-x-3 border-b border-border/70 last:border-b-0 ${header ? 'data-table-header sticky top-0 z-10 py-2.5' : `py-3.5 ${interactive ? 'interactive-row' : ''}`} ${selected ? 'bg-accent/[0.055]' : ''} ${className}`}
      {...rest}
    >
      {children}
    </div>
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
