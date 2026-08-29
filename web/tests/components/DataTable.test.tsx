import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DataTable, DataTableCell, DataTableChevronCell, DataTableRow } from '../../components/ui/DataTable';

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

/** The two defects below are invisible to a DOM test — jsdom applies no stylesheet — and both shipped to
 *  production unnoticed for exactly that reason. The stylesheet itself is the artefact worth pinning. */
describe('register stylesheet', () => {
  it('gives the sticky header an opaque fill and a token stacking order', () => {
    const sheet = css('data-table.css');
    expect(sheet).toMatch(/\.data-table-header\s*\{[^}]*background:\s*var\(--color-surface-sticky\)/);
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
    // AgentsTable must retain its native table layout except on this same phone-only container threshold.
    expect(sheet).toMatch(/@container \(width < 40rem\)\s*\{[\s\S]*?\.agents-table-secondary\s*\{\s*display:\s*none/);
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
