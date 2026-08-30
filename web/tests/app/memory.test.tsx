import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  http.get('*/api/projects', () => HttpResponse.json([{ id: 9, slug: 'kolin', path: '/work/kolin', notes: '', icon: '' }])),
  http.get('*/api/memory/1', () => HttpResponse.json(MEMORY)),
  http.get('*/api/memory/events', () => HttpResponse.json([])),
  http.get('*/api/memory/1/events', () => HttpResponse.json([])),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true, allowed_execs: [], name: 'Admin', email: '', avatar: '', default_exec: '', advisor_exec: '', advisor_autostart: false, created_at: '' } })),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); localStorage.clear(); });
afterAll(() => server.close());

describe('MemoryPage', () => {
  it('uses the canonical workspace hero, its metric rail, the section nav and one bordered register', async () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);

    await screen.findByTestId('memory-row');
    expect(screen.getByTestId('spatial-workspace-layout')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-hero-metrics')).toBeInTheDocument();
    const tabs = screen.getByRole('radiogroup', { name: 'Memory' });
    expect(tabs).toHaveAttribute('data-variant', 'line');
    expect(tabs).toHaveAttribute('data-nowrap', 'true');
    expect(container.querySelector('.workspace-shell')).toHaveAttribute('data-section-layout', 'tabs');
    expect(container.querySelector('.workspace-shell__section-navigation')).toHaveAttribute('data-layout', 'tabs');
    expect(screen.queryByRole('combobox', { name: 'Memory' })).toBeNull();
    expect(container.querySelectorAll('[data-control-surface]')).toHaveLength(1);
  });

  it('creates a memory category directly from the workspace hero', async () => {
    let created: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/memory/categories', async ({ request }) => {
        created = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ id: 7, user_id: 1, ...created, is_builtin: 0, created_at: '' }, { status: 201 });
      }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);

    await screen.findByTestId('memory-row');
    fireEvent.click(screen.getByRole('button', { name: 'New category' }));
    // "Required" belongs to the accessible name: the field states its required state for a screen
    // reader with an sr-only word beside the visual asterisk.
    fireEvent.change(screen.getByRole('textbox', { name: 'Name Required' }), { target: { value: 'Planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(created).toMatchObject({ name: 'Planning', icon: 'Folder' }));
  });

  it('lists memories and opens a detail on select', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getAllByText('Filip prefers pnpm over npm').length).toBeGreaterThan(0));
    // Opening the row opens the detail pane, which shows the memory id (#1). The row's open control is a
    // single button whose accessible name is an EXCERPT of the body, never the whole record.
    fireEvent.click(screen.getByRole('button', { name: 'Open memory: Filip prefers pnpm over npm' }));
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Memory detail' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Memory' })).toBeNull();
  });

  it('supports keyboard row navigation and sortable columns', async () => {
    const memories = [
      { ...MEMORY, id: 1, body: 'Lower importance', importance: 1, updated_at: '2026-01-01 00:00:02' },
      { ...MEMORY, id: 2, body: 'Higher importance', importance: 5, updated_at: '2026-01-01 00:00:01' },
    ];
    server.use(
      http.get('*/api/memory', () => HttpResponse.json(memories)),
      http.get('*/api/memory/:id', ({ params }) => {
        const id = Number(params.id);
        return HttpResponse.json(Number.isFinite(id) ? (memories.find((memory) => memory.id === id) ?? memories[0]) : []);
      }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);
    const first = (await screen.findAllByTestId('memory-row'))[0]!;
    expect(within(first).getByText('Lower importance')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Importance' }));
    await waitFor(() => expect(within(screen.getAllByTestId('memory-row')[0]!).getByText('Higher importance')).toBeInTheDocument());

    const higher = screen.getByRole('button', { name: 'Open memory: Higher importance' });
    higher.focus();
    fireEvent.keyDown(higher, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open memory: Lower importance' })).toHaveFocus());
  });

  it('renders the shared compact register, keeps advanced filters collapsed, and always shows the pager', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);
    const row = await screen.findByTestId('memory-row');
    const table = screen.getByRole('table', { name: 'Memory' });
    expect(table.style.getPropertyValue('--data-table-compact-columns')).toBe('2rem minmax(0,1fr) 1.25rem');
    expect(row).toHaveClass('data-table-grid');
    expect(row).toHaveClass('interactive-row');
    expect(row).toHaveClass('px-4');
    expect(row).not.toHaveClass('px-1');
    expect(row).not.toHaveClass('rounded-lg');
    expect(row).not.toHaveClass('bg-card');
    expect(row.closest('.control-surface-register')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
    // Search is the row's PERMANENT control; everything that narrows the register — status included,
    // which used to sit in the open beside it — is behind the one Filters trigger.
    expect(screen.getByPlaceholderText('Search memories…').closest('.page-toolbar')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Kind' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Status' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const kind = await screen.findByRole('combobox', { name: 'Kind' });
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    expect(kind).toBeInTheDocument();
    fireEvent.click(kind);
    const menu = screen.getByRole('listbox', { name: 'Kind' });
    expect(menu).toHaveClass('bg-popover');
    expect(screen.getByRole('option', { name: 'preference' }).querySelector('svg')).toBeTruthy();
  });

  it('uses the same padded heading and body contract for retrieval search', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);
    fireEvent.click(screen.getByRole('radio', { name: 'Retrieval' }));

    const heading = screen.getByRole('heading', { name: 'Retrieval debug' });
    expect(heading.closest('.control-surface-toolbar')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Try a query the assistant might face…').closest('.control-surface-register')).toBeInTheDocument();
  });

  it('prunes the merge selection when a filter hides the selected row', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getAllByText('Filip prefers pnpm over npm').length).toBeGreaterThan(0));
    // Select the row via its checkbox → the merge toolbar shows the selected count.
    fireEvent.click(screen.getAllByLabelText('Merge')[0]);
    await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument());
    expect(screen.getByTestId('memory-row')).toHaveAttribute('aria-selected', 'true');
    // A search that matches nothing hides the row; the stale selection must be dropped.
    const search = screen.getByPlaceholderText('Search memories…');
    fireEvent.change(search, { target: { value: 'zzz-no-match' } });
    expect(search).toHaveValue('zzz-no-match');
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

  // The row used to BE a button wrapped around the body, so its accessible name was the whole record —
  // over 3000 characters read out before the user learned that the control opens a memory.
  it('names a row open control with a short excerpt, never the whole memory body', async () => {
    const body = 'A'.repeat(3000);
    server.use(http.get('*/api/memory', () => HttpResponse.json([{ ...MEMORY, body }])));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);

    const open = await screen.findByRole('button', { name: /^Open memory: / });
    expect(open.getAttribute('aria-label')!.length).toBeLessThan(100);
    // The full body stays reachable on the cell that renders it.
    expect(within(screen.getByTestId('memory-row')).getByText(body)).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('switch', { name: 'Group by category' }));
    // Each group renders a heading: the category name and the uncategorized bucket.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Preferences' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Uncategorized' })).toBeInTheDocument();
  });
});
