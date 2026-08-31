import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Memory, MemoryCategory } from '../../../lib/types';

/** The Memory module's list fetches through React Query hooks — stub them to the same shapes the daemon
 *  serves (rows carrying the server-computed `vitality`), so the test exercises the real render/sort. */
const memories = vi.fn();
const categories = vi.fn();

vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMemories: (filters?: unknown) => memories(filters),
  useMemory: (id: number) => ({ data: MEMORY_SET.find((memory) => memory.id === id), isError: false, isLoading: false }),
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

beforeEach(() => {
  memories.mockReset();
  categories.mockReset();
  // Both fetches resolve to the same active set (the all-status variant is only summed into metrics).
  memories.mockImplementation(() => rows(MEMORY_SET));
  categories.mockReturnValue(cats());
});

const MEMORY_SET: Memory[] = [
  mem({ id: 1, body: 'frequently used', importance: 2, use_count: 20, vitality: 87 }),
  mem({ id: 2, body: 'stale low value', importance: 1, use_count: 0, vitality: 12 }),
  mem({ id: 3, body: 'middle ground', importance: 3, use_count: 1, vitality: 54 }),
];

const renderView = () => render(<ToastProvider><MemoryView /></ToastProvider>, { wrapper: createWrapper().wrapper });

describe('MemoryView vitality column', () => {
  it('renders a vitality figure per row', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('frequently used')).toBeInTheDocument());
    expect(screen.getByText('87')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('54')).toBeInTheDocument();
  });

  it('sorts by vitality descending on the header click, then ascending on a second click', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('frequently used')).toBeInTheDocument());

    // Default sort is recency; the vitality header puts the highest-vitality row first.
    fireEvent.click(screen.getByRole('button', { name: 'Vitality' }));
    await waitFor(() => {
      const bodies = screen.getAllByTestId('memory-row').map((r) => r.textContent ?? '');
      expect(bodies[0]).toContain('frequently used');
      expect(bodies[2]).toContain('stale low value');
    });

    // Second click flips to ascending — the stale row leads.
    fireEvent.click(screen.getByRole('button', { name: 'Vitality' }));
    await waitFor(() => {
      const bodies = screen.getAllByTestId('memory-row').map((r) => r.textContent ?? '');
      expect(bodies[0]).toContain('stale low value');
      expect(bodies[2]).toContain('frequently used');
    });
  });

  it('keeps the brain visible behind a selected memory and uses the softer inspection scrim', async () => {
    const view = renderView();
    fireEvent.click(await screen.findByRole('radio', { name: 'Brain' }));
    const [node] = await screen.findAllByTestId('memory-leaf-node');
    fireEvent.click(node!);

    const detail = await screen.findByRole('dialog');
    expect(view.container.querySelector('.brain-map')).not.toBeNull();
    expect(screen.queryByTestId('memory-row')).toBeNull();
    expect(detail.parentElement).toHaveAttribute('data-scrim', 'soft');
    expect(detail.parentElement).toHaveClass('bg-[var(--color-scrim-soft)]');
  });
});
