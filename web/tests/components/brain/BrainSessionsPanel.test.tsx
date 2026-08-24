import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { BrainSessionsPanel } from '../../../components/brain/BrainSessionsPanel';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

// Moved from tests/pluginUi/agentsSessions.test.tsx when the register left the agents plugin's
// Sessions page: the panel is core data and now renders from the Chat page's register modal.
let admin = false;
const conversations = Array.from({ length: 13 }, (_, index) => ({
  id: `brain-${index + 1}`,
  title: `Conversation ${index + 1}`,
  model: 'gpt-5.5',
  // Newest first, matching what the daemon returns (ORDER BY updated_at DESC) and what the register's
  // default sort shows -- so "Conversation 1" is the most recent and lands on page one.
  updated_at: `2026-07-${String(13 - index).padStart(2, '0')}T10:00:00.000Z`,
  running: index === 0,
  active: index === 0,
}));
/** Set by a test that needs specific register rows (platform/ownership shapes) instead of the plain
 *  thirteen conversations the pagination and sorting tests rely on. */
let managedOverride: Record<string, unknown>[] | null = null;
const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'user', is_admin: admin } })),
  http.get('*/api/brain/sessions', () => HttpResponse.json(conversations)),
  http.get('*/api/brain/managed-sessions', () => HttpResponse.json(
    managedOverride ?? conversations.map((session) => ({ ...session, kind: 'conversation', tokens: 1200 })),
  )),
);
beforeEach(() => { admin = false; managedOverride = null; localStorage.clear(); });
beforeAll(() => server.listen()); afterAll(() => server.close());

function renderPanel() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainSessionsPanel /></ToastProvider></Wrapper>);
}

describe('BrainSessionsPanel (conversation register)', () => {
  it('renders conversations as full-width rows with pagination', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());
    expect(screen.getByTestId('brain-sessions-list')).toHaveAttribute('role', 'table');
    expect(screen.getByRole('button', { name: 'Conversation 1: Actions' })).toBeInTheDocument();
    // One header row plus a page of conversations.
    expect(screen.getByTestId('brain-sessions-list').children).toHaveLength(13);
    expect(screen.queryByText('Conversation 13')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Conversation 13')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Conversation 1')).not.toBeInTheDocument());
  });

  // The register spans every account, so a row has to say WHERE it happened and whether the owner column
  // names the person talking or merely the account a shared room is filed under. Without the second one a
  // colleague's Teams room reads exactly like the operator's own conversation.
  it('marks where a conversation happened, and a shared room as hosted rather than authored', async () => {
    admin = true;
    managedOverride = [
      { ...conversations[0], id: 'brain-ch-msteams-19:room@thread.tacv2', title: 'Shared room', kind: 'channel', tokens: 10, platform: 'msteams', direct: false, ownerId: 2, ownerLabel: 'Filip' },
      { ...conversations[1], id: 'brain-ch-msteams-a:person', title: 'Private chat', kind: 'channel', tokens: 10, platform: 'msteams', direct: true, ownerId: 2, ownerLabel: 'Michal' },
      { ...conversations[2], id: 'brain-2-web', title: 'Web chat', kind: 'conversation', tokens: 10, platform: null, direct: false, ownerId: 2, ownerLabel: 'Filip' },
    ];
    renderPanel();
    await screen.findByText('Shared room');

    const row = (title: string) => screen.getByText(title).closest('[role="row"]') as HTMLElement;
    // Both Teams rows say Teams; the web conversation carries no badge, because that is the norm here.
    expect(within(row('Shared room')).getByText('Teams')).toBeInTheDocument();
    expect(within(row('Private chat')).getByText('Teams')).toBeInTheDocument();
    expect(within(row('Web chat')).queryByText('Teams')).not.toBeInTheDocument();
    // Only the shared room's owner is qualified as a host.
    expect(within(row('Shared room')).getByText('host')).toBeInTheDocument();
    expect(within(row('Private chat')).queryByText('host')).not.toBeInTheDocument();
    expect(within(row('Web chat')).queryByText('host')).not.toBeInTheDocument();
  });

  it('offers the conversation row actions from right click', async () => {
    renderPanel();
    await screen.findByText('Conversation 1');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open in web chat: Conversation 1' }));

    expect(screen.getByRole('menuitem', { name: 'Download as HTML' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Download as JSONL' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('uses the shared table heading and keeps its actions in the toolbar zone', async () => {
    admin = true;
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());

    const toolbar = screen.getByTestId('brain-sessions-toolbar');
    expect(toolbar).toHaveClass('control-surface-toolbar');
    expect(screen.getByTestId('brain-sessions-list').closest('.control-surface-register')).toBeInTheDocument();
    expect(within(toolbar).getByRole('heading', { name: 'Conversations' })).toHaveClass('text-base');
    expect(within(toolbar).getByRole('radio', { name: 'Just mine' })).toBeInTheDocument();
  });

  // "Delete all" hits an endpoint that deletes only the CALLER's conversations. Over the cross-account
  // view it would read as wiping the team's history and then quietly delete just the admin's own rows.
  /** The button now stands over BOTH views, because it is told which rows to delete. It used to be
   *  hidden over the register: back then the endpoint could only reach the caller's own conversations,
   *  so above a cross-account list it would have deleted six of forty without saying so. */
  it('offers Delete all in both admin views, and says so when it would wipe every account', async () => {
    admin = true;
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());

    fireEvent.click(await screen.findByRole('button', { name: 'Delete all' }));
    const wide = await screen.findByRole('dialog');
    expect(within(wide).getByText(/every account/i)).toBeInTheDocument();
    fireEvent.click(within(wide).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('radio', { name: 'Just mine' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all' }));
    // The personal view keeps the personal wording -- clearing your own history is a different act.
    const mine = await screen.findByRole('dialog');
    expect(within(mine).queryByText(/every account/i)).toBeNull();
  });
});

// The register is an admin oversight view spanning every account, so a row has to say WHOSE it is and
// the list has to stay navigable once it holds the whole team's conversations.
describe('BrainSessionsPanel — owner, filtering and sorting', () => {
  const owned = [
    { id: 'brain-a', title: 'Mine', model: 'gpt-5.5', updated_at: '2026-07-03T10:00:00.000Z', running: false, active: false, kind: 'conversation', tokens: 10, ownerId: 2, ownerLabel: 'Me' },
    { id: 'brain-b', title: 'Theirs', model: 'claude-opus-5', updated_at: '2026-07-02T10:00:00.000Z', running: false, active: false, kind: 'conversation', tokens: 20, ownerId: 7, ownerLabel: 'Bob Novák' },
    { id: 'brain-c', title: 'Also theirs', model: 'aaa-model', updated_at: '2026-07-01T10:00:00.000Z', running: false, active: false, kind: 'conversation', tokens: 30, ownerId: 7, ownerLabel: 'Bob Novák' },
  ];
  beforeEach(() => {
    admin = true;
    server.use(http.get('*/api/brain/managed-sessions', () => HttpResponse.json(owned)));
  });

  it('names the owner on every row', async () => {
    renderPanel();
    await screen.findByText('Theirs');
    expect(screen.getAllByText(/Bob Novák/).length).toBeGreaterThan(0);
  });

  it('leads with the model and gives the owner a face', async () => {
    renderPanel();
    await screen.findByText('Theirs');

    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent?.trim());
    expect(headers.slice(0, 4)).toEqual(['Model', 'Conversation', 'Owner', 'Tokens']);
    // The monogram stands in when the account list is unavailable — as it is here, and as it is for
    // any caller who may not read it — so the column has a face on every row either way.
    expect(screen.getAllByLabelText('Bob Novák').length).toBeGreaterThan(0);
  });

  it('opens a foreign conversation read-only and the caller\'s own for continuing', async () => {
    renderPanel();
    await screen.findByText('Theirs');
    // The daemon reads a foreign transcript for an admin but refuses a post into it, so the row must
    // not offer "continue" -- it would fail at send.
    expect(screen.getByRole('button', { name: 'View history in web chat: Theirs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in web chat: Mine' })).toBeInTheDocument();
  });

  // The owner dropdown is gone: the search covers the owner label, so typing a name narrows the
  // register to that person without a second control in the toolbar.
  it('filters down to one user through the search', async () => {
    renderPanel();
    await screen.findByText('Mine');

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'Bob' } });

    await waitFor(() => expect(screen.queryByText('Mine')).not.toBeInTheDocument());
    expect(screen.getByText('Theirs')).toBeInTheDocument();
    expect(screen.getByText('Also theirs')).toBeInTheDocument();
  });

  function rowTitles() {
    return [...screen.getByTestId('brain-sessions-list').querySelectorAll('[role="row"]:not(.data-table-header)')]
      .map((row) => row.textContent ?? '');
  }

  it('sorts by a column header instead of a sort control', async () => {
    renderPanel();
    await screen.findByText('Mine');

    fireEvent.click(screen.getByRole('button', { name: 'Model' }));

    await waitFor(() => expect(rowTitles()[0]).toContain('Also theirs')); // aaa-model sorts first
    expect(screen.getByRole('columnheader', { name: 'Model' })).toHaveAttribute('aria-sort', 'ascending');
  });

  // Clicking the column that already sorts must reverse it, otherwise the header can only ever
  // express half the orders and a "largest first" question has no answer.
  it('reverses the order when the active column is clicked again', async () => {
    renderPanel();
    await screen.findByText('Mine');

    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    await waitFor(() => expect(rowTitles()[0]).toContain('Also theirs'));

    fireEvent.click(screen.getByRole('button', { name: 'Model' }));

    await waitFor(() => expect(rowTitles()[0]).toContain('Mine')); // gpt-5.5 sorts last ascending
    expect(screen.getByRole('columnheader', { name: 'Model' })).toHaveAttribute('aria-sort', 'descending');
  });

  it('says so when the search matches nothing', async () => {
    renderPanel();
    await screen.findByText('Mine');

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz-nothing' } });

    expect(await screen.findByText('No conversation matches the filter')).toBeInTheDocument();
  });
});

/** The register sits in a FIXED-height dialog, so a hardcoded page of twelve rows left a dead band under
 *  the table on a large screen. The page is now measured from the scroll box. jsdom lays nothing out, so
 *  the geometry is supplied by hand — the point of the test is the arithmetic and the fallback, which is
 *  exactly what cannot be seen by reading the component. */
describe('BrainSessionsPanel — the page fills the dialog', () => {
  class FakeResizeObserver {
    static last: FakeResizeObserver | null = null;
    constructor(private cb: () => void) { FakeResizeObserver.last = this; }
    observe() {}
    disconnect() {}
    run() { this.cb(); }
  }

  const withGeometry = (boxHeight: number, rowHeight: number) => {
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) {
        if (this.getAttribute('role') === 'row') return { height: rowHeight } as DOMRect;
        return realRect.call(this);
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.dataset['testid'] === 'brain-sessions-scroll' ? boxHeight : 0; },
    });
    return () => {
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: realRect });
      Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    };
  };

  it('shows as many rows as the measured box fits instead of a fixed twelve', async () => {
    const restore = withGeometry(1000, 48);
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    try {
      renderPanel();
      await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());
      // (1000 - 48 header) / 48 = 19 rows fit, so all thirteen sit on one page — the fixed twelve would
      // have pushed the last one onto page two. Measured on mount, not first on resize: the dialog opens
      // at its final size, so waiting for a resize would show a short page until the user moved something.
      await waitFor(() => expect(screen.getByText('Conversation 13')).toBeInTheDocument());

      // Re-measuring the same box must be a no-op rather than a step in a feedback loop.
      await act(async () => { FakeResizeObserver.last?.run(); });
      expect(screen.getByText('Conversation 13')).toBeInTheDocument();
    } finally {
      restore();
      Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'ResizeObserver');
    }
  });

  it('keeps the fallback page when the box cannot be measured', async () => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    try {
      renderPanel();
      await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());
      // A zero-height box (hidden dialog, jsdom) must not be read as "no rows fit".
      await act(async () => { FakeResizeObserver.last?.run(); });
      expect(screen.getByText('Conversation 12')).toBeInTheDocument();
      expect(screen.queryByText('Conversation 13')).toBeNull();
    } finally {
      Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'ResizeObserver');
    }
  });
});
