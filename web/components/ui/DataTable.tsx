import { ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { useLocaleSafe } from '../../lib/i18n/context';
import { dictionaries } from '../../lib/i18n/dictionaries';

type TableStyle = CSSProperties & {
  '--data-table-columns'?: string;
  '--data-table-compact-columns'?: string;
};

/** Every icon inside a register is this size. One number, so a table never mixes 11px and 15px glyphs. */
const DATA_TABLE_ICON_SIZE = 12;

/** How a row tells its table that it carries an open control, and how the header row learns it has to
 *  name the column that control sits in.
 *
 *  The two halves cannot be separated. ARIA permits only `cell`/`gridcell`/`columnheader`/`rowheader`
 *  under `role="row"`, and a screen reader's browse mode does not expose content outside a cell at all —
 *  so the row-open button HAS to sit inside one, or the short `openLabel` this whole contract exists to
 *  supply is never announced. But a cell that body rows have and the header row does not would make the
 *  register announce a column that has no name, so the header must grow the matching column at the same
 *  time. Neither the table nor the header row can see whether a row is openable (a register renders its
 *  rows through its own component, so the prop is not on the child element), which is why the rows
 *  report it here while they are mounted instead of it being derived from the element tree. */
type RowOpenRegistry = {
  /** Called by an openable row for as long as it is mounted; returns its own unregister. */
  register: () => () => void;
  hasOpenRow: boolean;
};

const RowOpenContext = createContext<RowOpenRegistry | null>(null);

/** Responsive register table. Wide-only cells disappear as a unit and the compact grid closes ranks. */
export function DataTable({ ariaLabel, columns, compactColumns = 'minmax(0,1fr)', children, className = '', ...rest }: {
  ariaLabel: string;
  columns: string;
  compactColumns?: string;
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  const style: TableStyle = { '--data-table-columns': columns, '--data-table-compact-columns': compactColumns };
  const openRows = useRef(0);
  const [hasOpenRow, setHasOpenRow] = useState(false);
  // Stable by construction: a `register` that changed identity would re-run every row's effect, and the
  // unregister/register pair would drive the count through zero and flip the header column off and on.
  const register = useCallback(() => {
    openRows.current += 1;
    setHasOpenRow(true);
    return () => {
      openRows.current -= 1;
      if (openRows.current === 0) setHasOpenRow(false);
    };
  }, []);
  const registry = useMemo<RowOpenRegistry>(() => ({ register, hasOpenRow }), [register, hasOpenRow]);
  return (
    <div role="table" aria-label={ariaLabel} style={style} className={`@container overflow-x-clip rounded-lg border border-border/80 ${className}`} {...rest}>
      <RowOpenContext.Provider value={registry}>{children}</RowOpenContext.Provider>
    </div>
  );
}

type DataTableRowBase = {
  children: ReactNode;
  header?: boolean;
  selected?: boolean;
  /** Row-level hover feedback for a row whose activation the consumer drives itself. A row that opens
   *  something should pass `onOpen` instead — that is the contract, this is only the paint. */
  interactive?: boolean;
  /** `tall` is the deliberate two-line register. Everything else keeps the one canonical row rhythm,
   *  which is what makes a register scannable — rows that measure 27px, 41px and 59px do not. */
  height?: 'standard' | 'tall';
} & HTMLAttributes<HTMLDivElement>;

/** Opening a row is ONE contract, and the label is part of it. The label becomes the accessible name of
 *  the row's control; without it the name falls back to the row's own text, which on /memory was the
 *  entire memory body — thousands of characters read out before the user learns what the control does.
 *  Keep it short and specific: `Open memory: <title>`. */
type DataTableRowOpen =
  | { onOpen: () => void; openLabel: string }
  | { onOpen?: undefined; openLabel?: undefined };

export type DataTableRowProps = DataTableRowBase & DataTableRowOpen;

export function DataTableRow({ children, header = false, selected = false, interactive = false, height = 'standard', onOpen, openLabel, className = '', ...rest }: DataTableRowProps) {
  const registry = useContext(RowOpenContext);
  const register = registry?.register;
  const openable = Boolean(onOpen);
  const locale = useLocaleSafe();
  useEffect(() => {
    if (!openable || !register) return undefined;
    return register();
  }, [openable, register]);
  // The dictionary is read directly rather than through `useTranslation`, which throws without a
  // LanguageProvider: this is the app's lowest-level register primitive and it is also handed to plugin
  // bundles, so it must render in a bare mount too.
  const openColumnLabel = dictionaries[locale].common.openColumn;
  // Every row of an openable register carries the column, openable or not — a body row one cell short of
  // its siblings is the same mis-announcement as one cell long.
  const carriesOpenColumn = registry?.hasOpenRow ?? openable;
  return (
    <div
      role="row"
      data-state={selected ? 'selected' : 'idle'}
      data-row-height={header ? undefined : height}
      // `.data-table-header` carries the sticky positioning itself; a `sticky` utility here would be
      // overridden by `.data-table-grid`'s own `position: relative` (see data-table.css).
      className={`data-table-grid items-center gap-x-3 border-b border-border/70 px-4 last:border-b-0 ${header ? 'data-table-header' : `${interactive || onOpen ? 'interactive-row' : ''}`} ${selected ? 'bg-accent/[0.055]' : ''} ${className}`}
      {...rest}
    >
      {children}
      {carriesOpenColumn ? (
        header ? (
          // The name of the column the open control lives in. Out of the grid's flow (see
          // `.data-table-open-header`), so it claims no track and no consumer's column template moves.
          <div role="columnheader" className="data-table-open-header">{openColumnLabel}</div>
        ) : (
          // A real button stretched over the row (see .data-table-row-open): a short accessible name, a
          // single tab stop, and Enter/Space activation the platform gives us rather than a keydown
          // handler that has to re-implement it. Action buttons live in cells that paint ABOVE it, so
          // they are hit on their own — they are never inside this cell.
          <div role="cell" className="data-table-open-cell">
            {onOpen ? (
              <button
                type="button"
                className="data-table-row-open"
                aria-label={openLabel}
                onClick={(event) => {
                  // The overlay sits inside the row, so its click bubbles to whatever onClick the consumer
                  // put on the row itself (selection, context handling) and would run that a second time.
                  // Activation is this button's job alone.
                  event.stopPropagation();
                  onOpen();
                }}
              />
            ) : null}
          </div>
        )
      ) : null}
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
      lines="auto"
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
        <Arrow size={DATA_TABLE_ICON_SIZE} aria-hidden className={`shrink-0 ${active ? 'text-accent' : 'opacity-0 transition-opacity group-hover/sort:opacity-60'}`} />
      </button>
    </DataTableCell>
  );
}

export function DataTableCell({ children, header = false, priority = 'always', lines = 'auto', labelHidden = false, reveal = false, title, className = '', ...rest }: {
  children: ReactNode;
  header?: boolean;
  priority?: 'always' | 'wide';
  /** `1` is the register rhythm: one line, ellipsised at the column edge, with the full value on `title`.
   *  It is what keeps every row the same height, and it is what a text cell wants. `auto` is for a cell
   *  that hosts a control, or that carries a second line on a row marked `height="tall"`.
   *
   *  The DEFAULT is the permissive `auto` on purpose, and it is not the recommendation. `1` clips, and
   *  the register stylesheet is imported unlayered, so it also beats any wrapping utility a caller passes
   *  — defaulting to it silently truncated cells in every bundle built against an older API version, and
   *  the compatibility ceiling (`requiresApiVersion <= host`) cannot announce that kind of change at all.
   *  Every in-tree call site therefore states `lines` explicitly, and
   *  `tests/contract/dataTableLines.test.ts` fails the build if one stops. */
  lines?: 1 | 'auto';
  /** Header-only: the column's body is an icon or a dot, so its name is for assistive technology alone.
   *  Use it instead of shipping a second visible header with the same word — /p/mcp renders a status dot
   *  and a status text and labelled BOTH columns "Stav". */
  labelHidden?: boolean;
  /** A ghost row action (delete, retry): revealed with the row on a fine pointer, always present and at
   *  least a finger wide on a coarse one, where there is no hover to reveal it with. */
  reveal?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role={header ? 'columnheader' : 'cell'}
      data-priority={priority}
      data-lines={lines}
      data-reveal={reveal ? 'hover' : undefined}
      // A truncated cell hides part of its own content, so the full value has to stay reachable. It can
      // only be recovered when the cell IS the text; a composed cell passes its own `title`.
      title={title ?? (lines === 1 && typeof children === 'string' ? children : undefined)}
      className={`data-table-cell ${priority === 'wide' ? 'data-table-wide' : ''} min-w-0 ${header ? 'text-[10px] font-semibold uppercase tracking-wider text-text-muted' : ''} ${className}`}
      {...rest}
    >
      {labelHidden ? <span className="sr-only">{children}</span> : children}
    </div>
  );
}

/** The trailing open affordance of an interactive register. Reserve a `1.25rem` track for it as the last
 *  column of both templates, so the chevron survives the compact layout.
 *
 *  Decoration only: it paints the chevron and stays out of the accessibility tree, because the control it
 *  advertises is the row's own open button, which `DataTableRow` renders in a cell of its own.
 *
 *  @public No caller yet: it ships with the row contract above (`onOpen` + `openLabel`) and the registers
 *  that render it are migrated in phase C of the redesign. `.data-table-chevron` in
 *  app/styles/components/data-table.css is its half of the same pair. */
export function DataTableChevronCell({ className = '' }: { className?: string }) {
  return (
    <DataTableCell aria-hidden lines="auto" className={`data-table-chevron flex items-center justify-end ${className}`}>
      <ChevronRight size={DATA_TABLE_ICON_SIZE} />
    </DataTableCell>
  );
}
