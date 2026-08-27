import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DataTable, DataTableCell, DataTableRow } from '../../components/ui/DataTable';

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
          <DataTableCell>/var/www/elowen</DataTableCell>
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

  it('keeps an explicit title over the derived one', () => {
    render(
      <DataTable ariaLabel="Register" columns="minmax(0,1fr)">
        <DataTableRow><DataTableCell title="Full value">Short</DataTableCell></DataTableRow>
      </DataTable>,
    );
    expect(screen.getByRole('cell')).toHaveAttribute('title', 'Full value');
  });

  it('hides the label of an icon column from the eye but not from assistive technology', () => {
    render(
      <DataTable ariaLabel="Register" columns="2rem">
        <DataTableRow header><DataTableCell header labelHidden>Status</DataTableCell></DataTableRow>
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
    expect(sheet).toMatch(/\.data-table-wide\s*\{\s*display:\s*none/);
    expect(sheet).toContain('@container (min-width: 56rem)');
  });

  it('wraps the toolbar instead of clipping its last control', () => {
    expect(css('control-surface.css')).toMatch(/\.control-surface-toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});
