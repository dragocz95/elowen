import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Memory, MemoryCategory } from '../../../lib/types';

/** Filters are a view setting, so they must survive F5 — the mechanism is the existing
 *  `usePersistentState` (localStorage), the same one the tab/status/layout filters already use. */
const memories = vi.fn();
const categories = vi.fn();

vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMemories: (filters?: unknown) => memories(filters),
  useMemoryCategories: () => categories(),
}));

import { MemoryView } from '../../../modules/memory/MemoryView';

const mem = (over: Partial<Memory>): Memory => ({
  id: 1, user_id: 1, body: 'body', kind: 'fact', importance: 3, confidence: 1, source: 'user',
  status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  last_used_at: null, use_count: 0, category_id: null, vitality: 50, ...over,
});

const category = (over: Partial<MemoryCategory>): MemoryCategory => ({
  id: 1, user_id: 1, name: 'Work', description: '', color: '', icon: '', is_builtin: 0,
  projectId: null, created_at: '2026-01-01T00:00:00Z', ...over,
});

const rows = (list: Memory[]) => ({ data: list, isError: false, isLoading: false, refetch: vi.fn() });
const cats = (list: MemoryCategory[] = []) => ({ data: list, isError: false, isLoading: false, refetch: vi.fn() });

const set = [
  mem({ id: 1, body: 'alpha memory', importance: 1 }),
  mem({ id: 2, body: 'beta memory', importance: 5 }),
];

beforeEach(() => {
  localStorage.clear();
  memories.mockReset();
  categories.mockReset();
  memories.mockImplementation(() => rows(set));
  categories.mockReturnValue(cats());
});

const renderView = () => render(<ToastProvider><MemoryView /></ToastProvider>, { wrapper: createWrapper().wrapper });
const bodies = () => screen.getAllByTestId('memory-row').map((row) => row.textContent ?? '');

describe('memory filters survive a reload', () => {
  it('remembers the sort key and direction', async () => {
    const first = renderView();
    await waitFor(() => expect(screen.getByText('alpha memory')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Importance' }));
    await waitFor(() => expect(bodies()[0]).toContain('beta memory'));
    first.unmount();

    renderView();

    await waitFor(() => expect(bodies()[0]).toContain('beta memory'));
    expect(localStorage.getItem('elowen.memory.sortKey')).toBe('importance');
    expect(localStorage.getItem('elowen.memory.sortDirection')).toBe('desc');
  });

  it('does not remember the search box — a restored query would read as missing data', async () => {
    const first = renderView();
    await waitFor(() => expect(screen.getByText('alpha memory')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/search memories/i), { target: { value: 'alpha' } });
    await waitFor(() => expect(bodies()).toHaveLength(1));
    first.unmount();

    renderView();

    await waitFor(() => expect(bodies()).toHaveLength(2));
  });

  // A remembered category id outlives the category itself. Without the guard the table comes back empty
  // behind a filter that no longer names anything.
  it('drops a remembered category filter once that category is gone', async () => {
    localStorage.setItem('elowen.memory.category', '42');
    categories.mockReturnValue(cats([category({ id: 7, name: 'Work' })]));

    renderView();

    await waitFor(() => expect(bodies()).toHaveLength(2));
    expect(localStorage.getItem('elowen.memory.category')).toBe('all');
  });

  // The toolbar derives its count, its chips and its resets from ONE declared field list. The tally it
  // replaced was hand-written and counted three of the five controls, so a real filter could be on with
  // the trigger reading "Filters" and no chip naming it.
  it('states every active filter as a chip and clears the whole set at once', async () => {
    localStorage.setItem('elowen.memory.status', 'archived');
    localStorage.setItem('elowen.memory.kind', 'fact');

    renderView();
    await waitFor(() => expect(screen.getByText('alpha memory')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Filters, 2 active' })).toBeInTheDocument();
    const chips = screen.getByTestId('page-filter-chips');
    expect(chips).toHaveTextContent('Status: Archived');
    expect(chips).toHaveTextContent('Kind: fact');

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.queryByTestId('page-filter-chips')).toBeNull());
    expect(localStorage.getItem('elowen.memory.status')).toBe('active');
    expect(localStorage.getItem('elowen.memory.kind')).toBe('all');
  });

  it('brings a remembered filter back as an active chip after a reload', async () => {
    localStorage.setItem('elowen.memory.status', 'archived');

    renderView();

    await waitFor(() => expect(screen.getByTestId('page-filter-chips')).toHaveTextContent('Status: Archived'));
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeInTheDocument();
  });

  // Grouping and the categories panel are DISPLAY options: they rearrange or annotate the same rows and
  // remove none of them. They live in the condensed panel for page cleanliness, but counting them as
  // filters told the reader the register was narrowed when every row was still there — and "Clear
  // filters" then silently flattened a grouping nobody had asked it to touch.
  it('keeps the display options out of the filter count, the chips and Clear filters', async () => {
    localStorage.setItem('elowen.memory.status', 'archived');
    localStorage.setItem('elowen.memory.kind', 'fact');

    renderView();
    await waitFor(() => expect(screen.getByText('alpha memory')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('page-filters-trigger'));
    await screen.findByRole('dialog', { name: 'Filters' });
    // Both switches are still offered by the panel — they are view controls, not deleted controls.
    fireEvent.click(screen.getByRole('switch', { name: 'Group by category' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Categories' }));
    await waitFor(() => expect(localStorage.getItem('elowen.memory.layout')).toBe('grouped'));

    // Still the two narrowing filters and nothing else.
    expect(screen.getByRole('button', { name: 'Filters, 2 active' })).toBeInTheDocument();
    const chips = screen.getByTestId('page-filter-chips');
    expect(chips).not.toHaveTextContent('Group by category');
    expect(chips).not.toHaveTextContent('Categories');

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.queryByTestId('page-filter-chips')).toBeNull());
    expect(localStorage.getItem('elowen.memory.layout')).toBe('grouped');
  });

  it('never counts a display option on its own — the trigger stays unbadged', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('alpha memory')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('page-filters-trigger'));
    await screen.findByRole('dialog', { name: 'Filters' });
    fireEvent.click(screen.getByRole('switch', { name: 'Group by category' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Categories' }));
    await waitFor(() => expect(localStorage.getItem('elowen.memory.layout')).toBe('grouped'));

    expect(screen.queryByTestId('page-filter-chips')).toBeNull();
    // No count means no accessible name of its own: the trigger is plain "Filters".
    expect(screen.getByTestId('page-filters-trigger')).not.toHaveAttribute('aria-label');
  });

  it('keeps a remembered category filter that still resolves', async () => {
    localStorage.setItem('elowen.memory.category', '7');
    categories.mockReturnValue(cats([category({ id: 7, name: 'Work' })]));
    memories.mockImplementation(() => rows([
      mem({ id: 1, body: 'alpha memory', category_id: 7 }),
      mem({ id: 2, body: 'beta memory', category_id: null }),
    ]));

    renderView();

    await waitFor(() => expect(bodies()).toHaveLength(1));
    expect(bodies()[0]).toContain('alpha memory');
    expect(localStorage.getItem('elowen.memory.category')).toBe('7');
  });
});
