import { ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { useLocaleSafe } from '../../lib/i18n/context';
import { dictionaries } from '../../lib/i18n/dictionaries';
import { Checkbox } from './shadcn/checkbox';

type TableStyle = CSSProperties & {
  '--data-table-columns'?: string;
  '--data-table-compact-columns'?: string;
  '--data-table-mobile-columns'?: string;
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

/** Row selection, when a register wants it. Opting in is the whole contract: a table that passes no
 *  `selection` renders exactly what it did before, and no existing consumer changes.
 *
 *  The table is handed the SELECTION, not the rows. A register renders its own rows through its own
 *  component, so the table can neither know which ids are on screen nor which of them are selected — it
 *  has to be told both. `ids` is what select-all selects, which makes it the ids of the CURRENT PAGE
 *  rather than of the whole register: a header checkbox that silently selected four thousand rows the
 *  reader cannot see is the one behaviour a bulk action must never have.
 *
 *  `onSelectionChange` receives a NEW set. Mutating and re-sending the caller's own set would leave a
 *  `useState` holding the same reference and drop the render. */
export type DataTableSelection = {
  /** Every selectable row currently rendered, in render order. Select-all is exactly this set. */
  ids: readonly string[];
  selected: ReadonlySet<string>;
  onSelectionChange: (next: Set<string>) => void;
  /** Overrides the accessible name of the header's select-all control. */
  selectAllLabel?: string;
};

const SelectionContext = createContext<DataTableSelection | null>(null);

/** Responsive register table. Wide-only cells disappear as a unit and the compact grid closes ranks. */
export function DataTable({ ariaLabel, columns, compactColumns = 'minmax(0,1fr)', mobileColumns, selection, children, className = '', ...rest }: {
  ariaLabel: string;
  columns: string;
  compactColumns?: string;
  /** The phone-only template. At <40rem, cells with priority="mobile" join the always-visible cells. */
  mobileColumns?: string;
  /** Opt in to row selection. The register also has to render a `DataTableSelectCell` in its header row
   *  and in each selectable row, and reserve a `2rem` leading track in every column template it passes —
   *  the checkbox is a real column, not an overlay. */
  selection?: DataTableSelection;
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>) {
  const style: TableStyle = {
    '--data-table-columns': columns,
    '--data-table-compact-columns': compactColumns,
    '--data-table-mobile-columns': mobileColumns,
  };
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
    <div role="table" aria-label={ariaLabel} style={style} className={`@container overflow-x-clip rounded-lg border border-border ${className}`} {...rest}>
      <SelectionContext.Provider value={selection ?? null}>
        <RowOpenContext.Provider value={registry}>{children}</RowOpenContext.Provider>
      </SelectionContext.Provider>
    </div>
  );
}

/** The selection column: a select-all in the header row, a row checkbox in every other.
 *
 *  It renders NOTHING at all when the table was given no `selection`, so a register can carry the cell
 *  and turn selection on and off without its column template moving underneath it.
 *
 *  The header's three states are the whole reason this is a shared component. `indeterminate` is not
 *  "half-checked" decoration: a filled box that means "some" and a filled box that means "all" are the
 *  same picture, and the dash is what distinguishes them — see `shadcn/checkbox.tsx`, which paints it. */
export type DataTableSelectCellProps = { className?: string } & (
  /** The header's select-all. It needs no id and no label: it acts on every id the table was given, and
   *  its name is the register's, not a row's. */
  | { header: true; rowId?: never; label?: never }
  /** A row's own checkbox. `rowId` and `label` are BOTH required, and the union is what enforces it: an
   *  optional `rowId` renders a focusable control that is permanently unchecked and does nothing when
   *  activated, and an optional `label` leaves it announced as a bare "checkbox". This is the same
   *  discriminated-union device `DataTableRowOpen` below uses, for the same reason. */
  | { header?: false; rowId: string; label: string }
);
export function DataTableSelectCell({ className = '', ...props }: DataTableSelectCellProps) {
  const selection = useContext(SelectionContext);
  const locale = useLocaleSafe();
  const common = dictionaries[locale].common;
  if (!selection) return null;
  const { ids, selected, onSelectionChange } = selection;

  if (props.header) {
    // "Some" is measured against the rows ON SCREEN, not against the selection as a whole: a page whose
    // every row is selected reads as all, even when another page holds more.
    const onPage = ids.filter((id) => selected.has(id)).length;
    const state = onPage === 0 ? false : onPage === ids.length ? true : 'indeterminate';
    return (
      // The column's name is an `aria-label` rather than `labelHidden` text: `labelHidden` wraps the
      // cell's WHOLE content in `sr-only`, which would take the checkbox off the screen with it.
      <DataTableCell header lines="auto" aria-label={common.selectColumn} className={`flex items-center ${className}`}>
        <Checkbox
          checked={state}
          aria-label={selection.selectAllLabel ?? common.selectAllRows}
          // Indeterminate resolves toward selecting the rest, which is what a reader who has ticked three
          // of twenty and reaches for the header means. Only a fully selected page clears.
          onCheckedChange={() => {
            const next = new Set(selected);
            if (state === true) for (const id of ids) next.delete(id);
            else for (const id of ids) next.add(id);
            onSelectionChange(next);
          }}
        />
      </DataTableCell>
    );
  }

  const { rowId, label } = props;
  return (
    <DataTableCell
      lines="auto"
      className={`flex items-center ${className}`}
      // The row-open overlay is a button stretched over the whole row, and a register may also carry its
      // own row handlers. Ticking a checkbox is not opening the row, so the activation stops here.
      //
      // BOTH events, not just the click: a checkbox is reached with the keyboard as often as with a
      // pointer, and Space on it bubbles a keydown to whatever `onKeyDown` the register put on the row.
      // Stopping only the click left the keyboard path firing the row's navigation from inside the
      // control that exists to avoid it.
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Checkbox
        checked={selected.has(rowId)}
        aria-label={label}
        onCheckedChange={(next) => {
          const updated = new Set(selected);
          if (next === true) updated.add(rowId);
          else updated.delete(rowId);
          onSelectionChange(updated);
        }}
      />
    </DataTableCell>
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
      // The row hairline is the skin's `--color-border` at FULL strength, not a fraction of it. Each skin
      // already resolves that token to its own measured hairline (studio-light #e4e4e7 ≈ oklch(0.922),
      // studio-oled the equivalent dark step), so diluting it to 70% only made the rule too faint to
      // separate two adjacent rows — the one job it has in a register with no zebra.
      className={`data-table-grid items-center gap-x-3 border-b border-border px-4 last:border-b-0 ${header ? 'data-table-header' : `${interactive || onOpen ? 'interactive-row' : ''}`} ${selected ? 'bg-primary/[0.055]' : ''} ${className}`}
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
  priority?: 'always' | 'mobile' | 'wide';
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
        className={`-mx-1 flex w-full items-center gap-1 rounded px-1 py-0.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${align === 'end' ? 'justify-end' : ''} ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
      >
        <span className="truncate">{children}</span>
        {/* The neutral arrow is VISIBLE, not revealed on hover. It was `opacity-0` until the pointer
            entered the header, which meant that on a touch device — where there is no hover at all — a
            sortable column was indistinguishable from a fixed one and the whole sorting feature was
            undiscoverable (WCAG 1.4.1: the affordance may not depend on a pointer capability). It was
            already laid out, so showing it shifts nothing. It inherits the button's muted ink and
            brightens with the label on hover, which is what keeps it quieter than the active arrow. */}
        <Arrow size={DATA_TABLE_ICON_SIZE} aria-hidden className={`shrink-0 ${active ? 'text-primary' : ''}`} />
      </button>
    </DataTableCell>
  );
}

export function DataTableCell({ children, header = false, priority = 'always', lines = 'auto', labelHidden = false, reveal = false, title, className = '', ...rest }: {
  children: ReactNode;
  header?: boolean;
  priority?: 'always' | 'mobile' | 'wide';
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
      // A column name is read, not decoded: 14px/600 in the writing system's own case. The 10px
      // uppercase + tracking it replaces is the shape of a LABEL, and at that size it costs a reader
      // roughly a third of the glyph information — capitals erase the ascender/descender silhouette a
      // word is recognised by, which is why the reference dashboard sets its headers in sentence case.
      className={`data-table-cell ${priority === 'wide' ? 'data-table-wide' : priority === 'mobile' ? 'data-table-mobile' : ''} min-w-0 ${header ? 'text-sm font-semibold text-muted-foreground' : ''} ${className}`}
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
