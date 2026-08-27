import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Memory, MemoryCategory } from '../../../lib/types';

/** The "Used" column answers "how long since this memory was last read", so it stays relative at every
 *  distance. `formatTaskTime` deliberately switches to an absolute date past a day, which is why this
 *  column formats with `compactElapsed` instead — the tests below pin that difference. */
const memories = vi.fn();
const categories = vi.fn();

vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMemories: (filters?: unknown) => memories(filters),
  useMemoryCategories: () => categories(),
}));

vi.mock('../../../lib/mutations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCreateMemory: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useMergeMemories: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteMemory: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useRestoreMemory: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  usePurgeMemories: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useEmptyTrash: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useSetMemoryCategory: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

import { MemoryView } from '../../../modules/memory/MemoryView';

const mem = (over: Partial<Memory>): Memory => ({
  id: 1, user_id: 1, body: 'body', kind: 'fact', importance: 3, confidence: 1, source: 'user',
  status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  last_used_at: null, use_count: 0, category_id: null, vitality: 50, ...over,
});

const rows = (list: Memory[]) => ({ data: list, isError: false, isLoading: false, refetch: vi.fn() });
const cats = (list: MemoryCategory[] = []) => ({ data: list, isError: false, isLoading: false, refetch: vi.fn() });

const agoIso = (ms: number): string => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Stamps are built from the current clock, so the rendered elapsed value is stable regardless of when
 *  the suite runs — a memory read "3 hours before now" always formats as "3h". */
const memorySet = (): Memory[] => [
  mem({ id: 1, body: 'read recently', last_used_at: agoIso(3 * HOUR), use_count: 5 }),
  mem({ id: 2, body: 'never read', last_used_at: null, use_count: 0 }),
  mem({ id: 3, body: 'long forgotten', last_used_at: agoIso(40 * DAY), use_count: 2 }),
];

beforeEach(() => {
  memories.mockReset();
  categories.mockReset();
  // Build the stamps ONCE, not per render: the rows now read a ticking clock, so regenerating
  // "3 hours ago" on every render would race it and land on 2h59m59s — floored to "2h".
  const set = memorySet();
  memories.mockImplementation(() => rows(set));
  categories.mockReturnValue(cats());
});

afterEach(() => { vi.useRealTimers(); });

const renderView = () => render(<ToastProvider><MemoryView /></ToastProvider>, { wrapper: createWrapper().wrapper });

const usedCellOf = (body: string): string => {
  const row = screen.getAllByTestId('memory-row').find((r) => (r.textContent ?? '').includes(body));
  if (!row) throw new Error(`no row for ${body}`);
  return within(row).getByTestId('memory-used-cell').textContent ?? '';
};

/** The grid declares its columns once as a track list, while the cells are written out one by one, so the
 *  two drift apart silently: a ninth cell against eight tracks does not raise anything, it just wraps onto
 *  a second row under the checkbox. Counting them against each other is the only cheap guard, since jsdom
 *  performs no grid layout and every rendering assertion stays green through that break. */
const trackCount = (list: string): number => list.replace(/\([^)]*\)/g, '').trim().split(/\s+/).length;

const firstRow = (): HTMLElement => {
  const [row] = screen.getAllByTestId('memory-row');
  if (!row) throw new Error('no rows rendered');
  return row;
};

/** The grid items of a row. A row that opens a record also carries the row-open button, which is an
 *  absolutely positioned overlay rather than a cell — it occupies no track and must not be counted
 *  against the template. */
const cellsOf = (row: Element): Element[] =>
  Array.from(row.children).filter((child) => child.getAttribute('role') === 'cell' || child.getAttribute('role') === 'columnheader');

describe('MemoryView column grid', () => {
  it('declares one track per cell, so no cell wraps onto a second row', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('read recently')).toBeInTheDocument());

    const table = screen.getByRole('table');
    const tracks = trackCount(table.style.getPropertyValue('--data-table-columns'));
    expect(tracks).toBe(cellsOf(firstRow()).length);

    const headerRow = screen.getByRole('button', { name: 'Used' }).closest('[role="row"]');
    if (!headerRow) throw new Error('used header is outside a row');
    expect(cellsOf(headerRow).length).toBe(tracks);
  });

  it('keeps the compact grid aligned with the cells that survive the narrow breakpoint', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('read recently')).toBeInTheDocument());

    const table = screen.getByRole('table');
    const cells = cellsOf(firstRow());
    const wide = cells.filter((cell) => cell.getAttribute('data-priority') === 'wide');
    expect(trackCount(table.style.getPropertyValue('--data-table-compact-columns')))
      .toBe(cells.length - wide.length);
  });
});

describe('MemoryView used column', () => {
  it('shows the elapsed time since the last recall, relative at every distance', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('read recently')).toBeInTheDocument());

    expect(usedCellOf('read recently')).toContain('3h');
    // Past a day `formatTaskTime` would render a calendar date ("12 Jun 10:00"); this column must not.
    expect(usedCellOf('long forgotten')).toContain('40d');
    expect(usedCellOf('long forgotten')).not.toMatch(/\d{2}:\d{2}/);
  });

  // The column is an elapsed time, and nothing on this page causes a re-render between refetches — so
  // without its own clock it would keep showing whatever it read when the row first mounted.
  it('keeps counting without a refetch', async () => {
    // The clock must be fake BEFORE the row mounts, otherwise its heartbeat is a real interval that
    // advancing a fake clock never reaches.
    vi.useFakeTimers();
    const set = [mem({ id: 1, body: 'read recently', last_used_at: agoIso(58_000), use_count: 1 })];
    memories.mockImplementation(() => rows(set));
    renderView();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(usedCellOf('read recently')).toContain('58s');

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });

    expect(usedCellOf('read recently')).toContain('1m');
  });

  it('marks a memory that was never recalled instead of showing an epoch', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('never read')).toBeInTheDocument());

    expect(usedCellOf('never read')).toContain('—');
  });

  it('sorts by recall recency, putting the never-read memory at the stale end', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('read recently')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Used' }));
    await waitFor(() => {
      const bodies = screen.getAllByTestId('memory-row').map((r) => r.textContent ?? '');
      expect(bodies[0]).toContain('read recently');
      expect(bodies[2]).toContain('never read');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Used' }));
    await waitFor(() => {
      const bodies = screen.getAllByTestId('memory-row').map((r) => r.textContent ?? '');
      expect(bodies[0]).toContain('never read');
      expect(bodies[2]).toContain('read recently');
    });
  });
});
