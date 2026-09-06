import { describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { useState } from 'react';
import { LanguageProvider } from '../../lib/i18n';
import { DataTable, DataTableCell, DataTableChevronCell, DataTableRow, DataTableSelectCell, DataTableSortCell } from '../../components/ui/DataTable';

/** Cells of one row, in DOM order — the same thing a screen reader counts to decide what column it is
 *  announcing. `aria-hidden` cells are excluded on purpose: they are not in the accessibility tree
 *  either, which is exactly why a register can reserve a decorative track without naming a column. */
const columnsOf = (row: Element): Element[] =>
  [...row.querySelectorAll('[role="cell"], [role="columnheader"]')].filter((cell) => cell.getAttribute('aria-hidden') !== 'true');

const STYLES = join(resolve(process.cwd()), 'app', 'styles', 'components');
const css = (name: string): string => readFileSync(join(STYLES, name), 'utf-8');

function renderRow(props: Parameters<typeof DataTableRow>[0]) {
  return render(
    <DataTable ariaLabel="Register" columns="minmax(0,1fr)">
      <DataTableRow {...props} />
    </DataTable>,
  );
}

describe('DataTableRow activation', () => {
  it('exposes a real button with the short label the caller supplied, not the row body', () => {
    const body = 'A memory body that runs on and on and on and would be read out in full';
    renderRow({ onOpen: () => {}, openLabel: 'Open memory: Deployment', children: <DataTableCell>{body}</DataTableCell> });

    const open = screen.getByRole('button', { name: 'Open memory: Deployment' });
    // A native <button> is what gives Enter and Space activation, one tab stop and button semantics —
    // none of which a role="row" with an onClick has.
    expect(open.tagName).toBe('BUTTON');
    expect(open.getAttribute('aria-label')).not.toContain(body);
    expect(screen.getByRole('row')).not.toHaveAttribute('tabindex');
  });

  it('keeps that control inside a cell, where a screen reader can reach it', () => {
    // `role="row"` admits only cell-ish children, and content outside a cell is typically not exposed in
    // browse mode at all — so a button that was a SIBLING of the cells silenced the very label this
    // contract exists to supply, on top of being an aria-required-children violation.
    renderRow({ onOpen: () => {}, openLabel: 'Open memory: Deployment', children: <DataTableCell lines={1}>body</DataTableCell> });

    const open = screen.getByRole('button', { name: 'Open memory: Deployment' });
    const cell = open.closest('[role="cell"]');
    expect(cell, 'the row-open button must live inside a cell').not.toBeNull();
    expect(cell!.parentElement).toHaveAttribute('role', 'row');
    // Nothing between the two: a wrapper that was not a cell would put a non-cell child back in the row.
    expect(open.parentElement).toBe(cell);
  });

  it('agrees with its header on the column count, openable row or not', () => {
    // A cell body rows carry and the header does not makes a register announce a column that has no
    // name. The open control's cell is a real column, so the header has to name it — and a row that does
    // not open still has to carry it, or it reads one column short of its own siblings.
    const { container } = render(
      <DataTable ariaLabel="Register" columns="minmax(0,1fr) 1.25rem">
        <DataTableRow header>
          <DataTableCell header lines={1}>Name</DataTableCell>
          <DataTableCell header aria-hidden lines={1}>{null}</DataTableCell>
        </DataTableRow>
        <DataTableRow onOpen={() => {}} openLabel="Open user: filip">
          <DataTableCell lines={1}>filip</DataTableCell>
          <DataTableChevronCell />
        </DataTableRow>
        <DataTableRow>
          <DataTableCell lines={1}>built-in</DataTableCell>
          <DataTableCell aria-hidden lines="auto">{null}</DataTableCell>
        </DataTableRow>
      </DataTable>,
    );
    const [header, openable, plain] = [...container.querySelectorAll('[role="row"]')] as HTMLElement[];
    expect(columnsOf(openable!)).toHaveLength(columnsOf(header!).length);
    expect(columnsOf(plain!)).toHaveLength(columnsOf(header!).length);
    // The column the open control sits in is named, rather than being an anonymous extra one.
    expect(screen.getByRole('columnheader', { name: 'Open' })).toBeInTheDocument();
    // …and the decorative chevron track still names no column at all.
    expect(columnsOf(header!)).toHaveLength(2);
  });

  it('adds no column to a register whose rows do not open', () => {
    const { container } = render(
      <DataTable ariaLabel="Sessions" columns="minmax(0,1fr)">
        <DataTableRow header><DataTableCell header lines={1}>Title</DataTableCell></DataTableRow>
        <DataTableRow interactive><DataTableCell lines={1}>a</DataTableCell></DataTableRow>
      </DataTable>,
    );
    const [header, row] = [...container.querySelectorAll('[role="row"]')] as HTMLElement[];
    expect(columnsOf(header!)).toHaveLength(1);
    expect(columnsOf(row!)).toHaveLength(1);
  });

  it('still stretches the control over the whole row, not over one cell', () => {
    renderRow({ onOpen: () => {}, openLabel: 'Open project: elowen', children: <DataTableCell lines={1}>elowen</DataTableCell> });
    const open = screen.getByRole('button', { name: 'Open project: elowen' });
    // The stylesheet does the covering (jsdom applies none), so what is pinned here is the pair the
    // geometry depends on: the class, and a positioned host that is the ROW rather than a data cell.
    expect(open).toHaveClass('data-table-row-open');
    expect(open.parentElement).toHaveClass('data-table-open-cell');
    expect(open.parentElement).not.toHaveClass('data-table-cell');
  });

  it('fires the handler once and never doubles up with the row', () => {
    const onOpen = vi.fn();
    const onClick = vi.fn();
    renderRow({ onOpen, openLabel: 'Open project: elowen', onClick, children: <DataTableCell>elowen</DataTableCell> });

    fireEvent.click(screen.getByRole('button', { name: 'Open project: elowen' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The overlay lives inside the row, so without the deliberate stopPropagation the row's own
    // handler would run a second time off the same click.
    expect(onClick).not.toHaveBeenCalled();
  });

  it('leaves a nested action button to fire on its own', () => {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    renderRow({
      onOpen,
      openLabel: 'Open user: filip',
      children: (
        <DataTableCell reveal>
          <button type="button" onClick={onDelete}>Delete</button>
        </DataTableCell>
      ),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('marks the row rhythm and only opts out of it explicitly', () => {
    const { container } = render(
      <DataTable ariaLabel="Register" columns="minmax(0,1fr)">
        <DataTableRow header><DataTableCell header>Name</DataTableCell></DataTableRow>
        <DataTableRow interactive><DataTableCell>a</DataTableCell></DataTableRow>
        <DataTableRow height="tall"><DataTableCell lines="auto">b</DataTableCell></DataTableRow>
      </DataTable>,
    );
    const rows = [...container.querySelectorAll('[role="row"]')];
    expect(rows[0]).toHaveClass('data-table-header');
    expect(rows[0]).not.toHaveAttribute('data-row-height');
    expect(rows[1]).toHaveAttribute('data-row-height', 'standard');
    expect(rows[1]).toHaveClass('interactive-row');
    expect(rows[2]).toHaveAttribute('data-row-height', 'tall');
  });
});

describe('DataTableCell', () => {
  it('truncates to one line and keeps the full text reachable on title', () => {
    render(
      <DataTable ariaLabel="Register" columns="minmax(0,1fr) minmax(0,1fr)">
        <DataTableRow>
          <DataTableCell lines={1}>/var/www/elowen</DataTableCell>
          <DataTableCell lines="auto" data-testid="composed"><span>x</span></DataTableCell>
        </DataTableRow>
      </DataTable>,
    );
    const [text, composed] = screen.getAllByRole('cell');
    expect(text).toHaveAttribute('data-lines', '1');
    expect(text).toHaveAttribute('title', '/var/www/elowen');
    // A composed cell has no single value to put on `title`; it stays the caller's business.
    expect(composed).toHaveAttribute('data-lines', 'auto');
    expect(composed).not.toHaveAttribute('title');
  });

  it('defaults to the permissive value, so an unmigrated bundle is never clipped', () => {
    // `1` is the register rhythm, but it cannot be the default. The `data-lines="1"` rule lives in an
    // unlayered stylesheet, so it beats any wrapping utility a bundle passes, and the API version is a
    // compatibility CEILING — it can announce an addition and cannot express this kind of change at all,
    // so a bundle built against version 7 would simply find its cells truncated. The rhythm is held by
    // `tests/contract/dataTableLines.test.ts` instead, which requires every in-tree caller to say so.
    render(
      <DataTable ariaLabel="Register" columns="minmax(0,1fr)">
        <DataTableRow><DataTableCell>a bundle that never heard of this prop</DataTableCell></DataTableRow>
      </DataTable>,
    );
    const cell = screen.getByRole('cell');
    expect(cell).toHaveAttribute('data-lines', 'auto');
    // …and with no clipping there is nothing to recover, so no title is invented either.
    expect(cell).not.toHaveAttribute('title');
  });

  it('keeps an explicit title over the derived one', () => {
    render(
      <DataTable ariaLabel="Register" columns="minmax(0,1fr)">
        <DataTableRow><DataTableCell lines={1} title="Full value">Short</DataTableCell></DataTableRow>
      </DataTable>,
    );
    expect(screen.getByRole('cell')).toHaveAttribute('title', 'Full value');
  });

  it('hides the label of an icon column from the eye but not from assistive technology', () => {
    render(
      <DataTable ariaLabel="Register" columns="2rem">
        <DataTableRow header><DataTableCell header labelHidden lines={1}>Status</DataTableCell></DataTableRow>
      </DataTable>,
    );
    const header = screen.getByRole('columnheader', { name: 'Status' });
    expect(header.querySelector('.sr-only')?.textContent).toBe('Status');
  });
});

describe('DataTableSortCell', () => {
  function renderHeader(active: boolean) {
    return render(
      <DataTable ariaLabel="Sessions" columns="minmax(0,1fr)">
        <DataTableRow header>
          <DataTableSortCell active={active} direction="asc" onSort={() => {}}>Updated</DataTableSortCell>
        </DataTableRow>
      </DataTable>,
    );
  }

  it('shows the sort affordance without a pointer ever entering the header', () => {
    // The neutral arrow was `opacity-0` until `group-hover/sort` revealed it, so on a touch device —
    // where there is no hover at all — nothing distinguished a sortable column from a fixed one and the
    // feature was undiscoverable. It is the icon a sighted user has to SEE, so opacity is the assertion.
    const { container } = renderHeader(false);
    const arrow = container.querySelector('button svg');
    expect(arrow, 'the inactive column must still draw its arrow').not.toBeNull();
    expect(arrow!.getAttribute('class')).not.toContain('opacity-0');
    expect(container.querySelector('button')?.className).not.toContain('group-hover/sort');
  });

  it('still says which column imposes the current order, and which way', () => {
    // Visible always does not mean indistinguishable: the active column keeps the accent and a directional
    // glyph, the inactive one the neutral up/down pair in muted ink.
    const { container: idle } = renderHeader(false);
    const { container: sorted } = renderHeader(true);

    expect(idle.querySelector('[role="columnheader"]')).toHaveAttribute('aria-sort', 'none');
    expect(sorted.querySelector('[role="columnheader"]')).toHaveAttribute('aria-sort', 'ascending');
    expect(idle.querySelector('button svg')!.getAttribute('class')).toContain('lucide-chevrons-up-down');
    expect(sorted.querySelector('button svg')!.getAttribute('class')).toContain('lucide-chevron-up');
    expect(sorted.querySelector('button svg')!.getAttribute('class')).toContain('text-primary');
    expect(idle.querySelector('button svg')!.getAttribute('class')).not.toContain('text-primary');
  });

  it('sorts when the header is activated', () => {
    const onSort = vi.fn();
    render(
      <DataTable ariaLabel="Sessions" columns="minmax(0,1fr)">
        <DataTableRow header>
          <DataTableSortCell active={false} direction="asc" onSort={onSort}>Updated</DataTableSortCell>
        </DataTableRow>
      </DataTable>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Updated' }));
    expect(onSort).toHaveBeenCalledTimes(1);
  });
});

describe('DataTable row selection', () => {
  /** A register that has opted in: three rows, the header, and a caller holding the set. */
  function Register({ initial = [], ids = ['a', 'b', 'c'], onChange }: {
    initial?: string[];
    ids?: string[];
    onChange?: (next: Set<string>) => void;
  }) {
    const [selected, setSelected] = useState<Set<string>>(new Set(initial));
    return (
      <LanguageProvider>
        <DataTable
          ariaLabel="Members"
          columns="2rem minmax(0,1fr)"
          selection={{
            ids,
            selected,
            onSelectionChange: (next) => { setSelected(next); onChange?.(next); },
          }}
        >
          <DataTableRow header>
            <DataTableSelectCell header />
            <DataTableCell header lines={1}>Name</DataTableCell>
          </DataTableRow>
          {ids.map((id) => (
            <DataTableRow key={id}>
              <DataTableSelectCell rowId={id} label={`Select member: ${id}`} />
              <DataTableCell lines={1}>{id}</DataTableCell>
            </DataTableRow>
          ))}
        </DataTable>
      </LanguageProvider>
    );
  }

  it('renders nothing at all for a register that did not opt in', () => {
    // The whole point of the opt-in: an existing consumer that never heard of selection must render
    // exactly what it did before, cells included, or every column template in the app moves.
    render(
      <LanguageProvider>
        <DataTable ariaLabel="Sessions" columns="minmax(0,1fr)">
          <DataTableRow header>
            <DataTableSelectCell header />
            <DataTableCell header lines={1}>Name</DataTableCell>
          </DataTableRow>
        </DataTable>
      </LanguageProvider>,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getAllByRole('columnheader')).toHaveLength(1);
  });

  it('names the column and each row control, so neither is announced as a bare checkbox', () => {
    render(<Register />);
    expect(screen.getByRole('columnheader', { name: 'Select' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select member: b' })).toBeInTheDocument();
  });

  it('reports a new Set, never the caller\u2019s own one mutated in place', () => {
    const onChange = vi.fn();
    // The set the TABLE was handed, held here so the identity of what comes back can be compared to it.
    const held = new Set<string>(['a']);
    render(
      <LanguageProvider>
        <DataTable ariaLabel="Members" columns="2rem minmax(0,1fr)" selection={{ ids: ['a', 'b'], selected: held, onSelectionChange: onChange }}>
          <DataTableRow>
            <DataTableSelectCell rowId="b" label="Select member: b" />
            <DataTableCell lines={1}>b</DataTableCell>
          </DataTableRow>
        </DataTable>
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select member: b' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as Set<string>;
    expect([...next].sort()).toEqual(['a', 'b']);
    // A set mutated and re-sent leaves a `useState` holding the same reference, and React drops the
    // render — the row would tick in the DOM and never again reflect the state it came from.
    expect(next).not.toBe(held);
    expect([...held]).toEqual(['a']);
  });

  it('shows the header as indeterminate for a partial selection, and as checked for a full one', () => {
    const partial = render(<Register initial={['b']} />);
    const all = screen.getByRole('checkbox', { name: 'Select all rows' });
    // The dash and the tick share a filled box, so `mixed` is the ONLY thing telling the two apart.
    expect(all).toHaveAttribute('data-state', 'indeterminate');
    expect(all).toHaveAttribute('aria-checked', 'mixed');
    partial.unmount();

    // A fresh mount rather than a rerender: `initial` seeds the caller's state once, so re-rendering the
    // same component with another one would assert against the selection the first mount still holds.
    render(<Register initial={['a', 'b', 'c']} />);
    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toHaveAttribute('data-state', 'checked');

    // Nothing selected is the third state, and it must not be confused with either of the other two.
    cleanup();
    render(<Register />);
    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toHaveAttribute('data-state', 'unchecked');
  });

  it('select-all from empty and from partial selects the page; only a full page clears it', () => {
    const { unmount } = render(<Register />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    for (const id of ['a', 'b', 'c']) {
      expect(screen.getByRole('checkbox', { name: `Select member: ${id}` })).toBeChecked();
    }
    // A full page clears.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(screen.getByRole('checkbox', { name: 'Select member: a' })).not.toBeChecked();
    unmount();

    // …and a PARTIAL one resolves toward selecting the rest, which is what a reader who has ticked one
    // of three and then reaches for the header means.
    render(<Register initial={['b']} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(screen.getByRole('checkbox', { name: 'Select member: a' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select member: c' })).toBeChecked();
  });

  it('select-all touches only the rows on screen, and leaves a selection from elsewhere alone', () => {
    const onChange = vi.fn();
    // 'z' is selected but not rendered — a row from another page of the same register.
    render(<Register initial={['z']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect([...(onChange.mock.calls[0]![0] as Set<string>)].sort()).toEqual(['a', 'b', 'c', 'z']);
  });

  it('ticking a row neither opens it nor fires the row\u2019s own handlers, by pointer OR keyboard', () => {
    const onOpen = vi.fn();
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    const selected = new Set<string>();
    render(
      <LanguageProvider>
        <DataTable
          ariaLabel="Members"
          columns="2rem minmax(0,1fr)"
          selection={{ ids: ['a'], selected, onSelectionChange: () => {} }}
        >
          <DataTableRow onOpen={onOpen} openLabel="Open member: a" onClick={onClick} onKeyDown={onKeyDown}>
            <DataTableSelectCell rowId="a" label="Select member: a" />
            <DataTableCell lines={1}>a</DataTableCell>
          </DataTableRow>
        </DataTable>
      </LanguageProvider>,
    );
    const box = screen.getByRole('checkbox', { name: 'Select member: a' });
    fireEvent.click(box);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();

    // A checkbox is reached with the keyboard as often as with a pointer. Stopping only the click left
    // Space firing the row's own navigation from inside the control that exists to avoid it.
    fireEvent.keyDown(box, { key: ' ', code: 'Space' });
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});

/** The register's density, measured off the reference dashboard. These are PINS: a number here changing
 *  is a design decision, and the test is what makes it one instead of a side effect of a refactor. */
describe('register density', () => {
  it('sets a 40px single-line row, a 48px two-line one and a 41px header', () => {
    const sheet = css('data-table.css');
    expect(sheet).toMatch(/--data-table-row:\s*2\.5rem/);
    // The two-line variant SURVIVES the tightening: a register that carries an avatar and a second line
    // still has a rhythm of its own, it is just 48px rather than 68px.
    expect(sheet).toMatch(/--data-table-row-tall:\s*3rem/);
    expect(sheet).toMatch(/--data-table-row-header:\s*2\.5625rem/);
    // Height comes from min-height alone, so a cell taller than the rhythm grows the row instead of
    // being clipped by it.
    expect(sheet).toMatch(/\.data-table-grid\s*\{[^}]*min-height:\s*var\(--data-table-row\)/);
    expect(sheet).toMatch(/\[data-row-height='tall'\][^{]*\{\s*min-height:\s*var\(--data-table-row-tall\)/);
  });

  it('sets column names in sentence case at the body step, not as 10px uppercase labels', () => {
    render(
      <DataTable ariaLabel="Members" columns="minmax(0,1fr) 8rem">
        <DataTableRow header>
          <DataTableCell header lines={1}>Name</DataTableCell>
          <DataTableSortCell active direction="asc" onSort={() => {}}>Updated</DataTableSortCell>
        </DataTableRow>
      </DataTable>,
    );
    const plain = screen.getByRole('columnheader', { name: 'Name' });
    const sortable = screen.getByRole('button', { name: 'Updated' });
    for (const element of [plain, sortable]) {
      expect(element.className).toContain('text-sm');
      expect(element.className).toContain('font-semibold');
      // Uppercase erases the ascender/descender silhouette a word is recognised by; at 10px that is most
      // of what a column name has left to be read with.
      expect(element.className).not.toContain('uppercase');
      expect(element.className).not.toContain('tracking-wider');
      expect(element.className).not.toContain('text-[10px]');
    }
  });

  it('draws the row hairline at the skin token\u2019s full strength', () => {
    // Each skin already resolves --color-border to its own measured hairline. Diluting it to 70% made
    // the only thing separating two rows in a zebra-less register too faint to see.
    const { container } = render(
      <DataTable ariaLabel="Members" columns="minmax(0,1fr)">
        <DataTableRow><DataTableCell lines={1}>a</DataTableCell></DataTableRow>
      </DataTable>,
    );
    expect(container.querySelector('[role="row"]')!.className).toContain('border-border');
    expect(container.querySelector('[role="row"]')!.className).not.toContain('border-border/70');
    expect(container.querySelector('[role="table"]')!.className).not.toContain('border-border/80');
  });
});

/** The two defects below are invisible to a DOM test — jsdom applies no stylesheet — and both shipped to
 *  production unnoticed for exactly that reason. The stylesheet itself is the artefact worth pinning. */
describe('register stylesheet', () => {
  it('gives the sticky header an opaque fill and a token stacking order', () => {
    const sheet = css('data-table.css');
    expect(sheet).toMatch(/\.data-table-header\s*\{[^}]*background:\s*var\(--color-sticky\)/);
    expect(sheet).toMatch(/\.data-table-header\s*\{[^}]*z-index:\s*var\(--z-sticky\)/);
    // A translucent header lets the rows scrolling under it read straight through the column names.
    expect(sheet).not.toMatch(/rgb\(255 255 255/);
  });

  it('reveals row actions by pointer capability, never by viewport width', () => {
    const sheet = css('data-table.css');
    expect(sheet).toContain('@media (hover: hover) and (pointer: fine)');
    expect(sheet).toContain('@media (pointer: coarse)');
    expect(sheet).not.toMatch(/@media[^{]*(min-width|max-width)/);
  });

  it('still collapses wide-only cells on a narrow container', () => {
    const sheet = css('data-table.css');
    expect(sheet).toMatch(/\.data-table-wide\s*,\s*\.data-table-mobile\s*\{\s*display:\s*none/);
    expect(sheet).toContain('@container (min-width: 56rem)');
  });

  it('uses a phone-only template for the one mobile-priority decision column', () => {
    const { container } = render(
      <DataTable
        ariaLabel="Agents"
        columns="minmax(0,1fr) 8rem 5rem"
        compactColumns="minmax(0,1fr)"
        mobileColumns="minmax(0,1fr) minmax(0,8rem)"
      >
        <DataTableRow>
          <DataTableCell lines={1}>Task</DataTableCell>
          <DataTableCell priority="mobile" lines={1}>Model</DataTableCell>
          <DataTableCell priority="wide" lines={1}>Tokens</DataTableCell>
        </DataTableRow>
      </DataTable>,
    );
    const table = container.querySelector<HTMLElement>('[role="table"]')!;
    const [task, model, tokens] = screen.getAllByRole('cell');
    expect(table.style.getPropertyValue('--data-table-mobile-columns')).toBe('minmax(0,1fr) minmax(0,8rem)');
    expect(task).not.toHaveClass('data-table-mobile', 'data-table-wide');
    expect(model).toHaveClass('data-table-mobile');
    expect(tokens).toHaveClass('data-table-wide');

    // jsdom cannot resolve container queries, so pin the CSS contract for a constrained (<40rem) table:
    // task + model fill the phone template and the wide metric remains hidden.
    const sheet = css('data-table.css');
    expect(sheet).toMatch(/@container \(width < 40rem\)\s*\{[\s\S]*?grid-template-columns:\s*var\(--data-table-mobile-columns/);
    expect(sheet).toMatch(/@container \(width < 40rem\)\s*\{[\s\S]*?\.data-table-mobile\s*\{\s*display:\s*block/);
    expect(sheet).not.toContain('agents-table-secondary');
  });

  it('keeps the row-open cell out of the grid and out of the way of pointers', () => {
    const sheet = css('data-table.css');
    // Absolutely positioned, so it is not a grid item: it claims no track and no column template moves.
    expect(sheet).toMatch(/\.data-table-open-cell\s*\{[^}]*position:\s*absolute/);
    // It covers the whole row, and an openable register gives it to its non-openable rows too — so
    // without this pair an empty overlay would swallow every click those rows depend on.
    expect(sheet).toMatch(/\.data-table-open-cell\s*\{[^}]*pointer-events:\s*none/);
    expect(sheet).toMatch(/\.data-table-row-open\s*\{[^}]*pointer-events:\s*auto/);
    expect(sheet).toMatch(/\.data-table-open-header\s*\{[^}]*position:\s*absolute/);
  });

  it('wraps the toolbar instead of clipping its last control', () => {
    expect(css('control-surface.css')).toMatch(/\.control-surface-toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});
