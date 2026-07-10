import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import MemoryPage from '../../app/memory/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

const MEMORY = {
  id: 1, user_id: 1, body: 'Filip prefers pnpm over npm', kind: 'preference', importance: 0.8,
  confidence: 0.9, source: 'user', status: 'active', created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00', last_used_at: null, use_count: 3,
};

const server = setupServer(
  http.get('*/api/memory', () => HttpResponse.json([MEMORY])),
  http.get('*/api/memory/categories', () => HttpResponse.json([])),
  http.get('*/api/memory/1', () => HttpResponse.json(MEMORY)),
  http.get('*/api/memory/events', () => HttpResponse.json([])),
  http.get('*/api/memory/1/events', () => HttpResponse.json([])),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true, allowed_execs: [], name: 'Admin', email: '', avatar: '', default_exec: '', advisor_exec: '', advisor_autostart: false, created_at: '' } })),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); localStorage.clear(); });
afterAll(() => server.close());

describe('MemoryPage', () => {
  it('lists memories and opens a detail on select', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getAllByText('Filip prefers pnpm over npm').length).toBeGreaterThan(0));
    // Selecting the row opens the detail pane, which shows the memory id (#1).
    fireEvent.click(screen.getAllByText('Filip prefers pnpm over npm')[0]);
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
  });

  it('renders a flat full-width row, keeps advanced filters collapsed, and always shows the pager', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);
    const row = await screen.findByTestId('memory-row');
    expect(screen.getByTestId('page-mascot').querySelector('img')).toHaveAttribute('src', '/icon.png');
    expect(row).not.toHaveClass('rounded-lg');
    expect(row).not.toHaveClass('bg-surface');
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Kind' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('combobox', { name: 'Kind' })).toBeInTheDocument();
  });

  it('prunes the merge selection when a filter hides the selected row', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getAllByText('Filip prefers pnpm over npm').length).toBeGreaterThan(0));
    // Select the row via its checkbox → the merge toolbar shows the selected count.
    fireEvent.click(screen.getAllByLabelText('Merge')[0]);
    await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument());
    // A search that matches nothing hides the row; the stale selection must be dropped.
    fireEvent.change(screen.getByPlaceholderText('Search memories…'), { target: { value: 'zzz-no-match' } });
    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
  });

  it('paginates a long list and pages through it', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...MEMORY, id: i + 1, body: `Memory ${String(i + 1).padStart(2, '0')}`,
      updated_at: `2026-01-01 00:00:${String(i + 1).padStart(2, '0')}`,
    }));
    server.use(http.get('*/api/memory', () => HttpResponse.json(many)));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);
    // Page 1 shows a 20-row window with a pager; the newest row is here, the oldest is not.
    await waitFor(() => expect(screen.getByText('1–20 of 25')).toBeInTheDocument());
    expect(screen.getByText('Memory 25')).toBeInTheDocument();
    expect(screen.queryByText('Memory 01')).not.toBeInTheDocument();
    // Next → the last 5 rows, incl. the oldest.
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('21–25 of 25')).toBeInTheDocument());
    expect(screen.getByText('Memory 01')).toBeInTheDocument();
  });

  it('groups the list into category sections when toggled', async () => {
    const cats = [{ id: 7, user_id: 1, name: 'Preferences', description: '', color: '#22c55e', icon: '', is_builtin: 0, created_at: '' }];
    const mems = [
      { ...MEMORY, id: 1, body: 'Likes pnpm', category_id: 7 },
      { ...MEMORY, id: 2, body: 'Loose note', category_id: null },
    ];
    server.use(
      http.get('*/api/memory', () => HttpResponse.json(mems)),
      http.get('*/api/memory/categories', () => HttpResponse.json(cats)),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('Likes pnpm')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByText('Group by category'));
    // Each group renders a heading: the category name and the uncategorized bucket.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Preferences' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Uncategorized' })).toBeInTheDocument();
  });
});
