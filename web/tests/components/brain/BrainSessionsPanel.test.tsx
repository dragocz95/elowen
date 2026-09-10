import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { BrainSessionsPanel } from '../../../components/brain/BrainSessionsPanel';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { BRAIN_OPEN_EVENT, type BrainOpenRequest } from '../../../lib/brainDock';

// Moved from tests/pluginUi/agentsSessions.test.tsx when the register left the agents plugin's
// Sessions page: the panel is core data and renders as the administrator's view of the conversation
// switcher. It is admin-only now — the switcher shows the personal list itself and owns that choice —
// so every case here reads it as the operator does. That a non-administrator never reaches it, and
// never makes the cross-account request, is pinned at that boundary in the switcher's own test.
let admin = true;
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
/** The collapsed scheduled-job branches. `available` with no links is the normal case for an instance
 *  whose cron plugin is installed but has nothing filed under a conversation. */
let jobLinks: Record<string, unknown> = { status: 'available', links: [] };
/** Every `?ids` the register asked the branch read for, so a test can pin that it narrows to the page. */
const branchRequests: (string | null)[] = [];
const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'user', is_admin: admin } })),
  http.get('*/api/brain/sessions', () => HttpResponse.json(conversations)),
  http.get('*/api/brain/managed-sessions', () => HttpResponse.json(
    managedOverride ?? conversations.map((session) => ({ ...session, kind: 'conversation', tokens: 1200 })),
  )),
  http.get('*/api/brain/conversation-links', ({ request }) => {
    branchRequests.push(new URL(request.url).searchParams.get('ids'));
    return HttpResponse.json(jobLinks);
  }),
);
beforeEach(() => {
  admin = true;
  managedOverride = null;
  jobLinks = { status: 'available', links: [] };
  branchRequests.length = 0;
  localStorage.clear();
});
beforeAll(() => server.listen()); afterAll(() => server.close());
// A `server.use(...)` override outlives the test that added it, so a describe that installs its own
// fixture used to keep serving it to every describe below. Reset between tests instead.
afterEach(() => server.resetHandlers());

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
    // The shared <Pager /> — its controls carry a full accessible name ("Next page") because at narrow
    // widths the visible label is dropped and only that name is left to identify the button.
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Conversation 13')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Conversation 1')).not.toBeInTheDocument());
  });

  // The register spans every account, so a row has to say WHERE it happened and whether the owner column
  // names the person talking or merely the account a shared room is filed under. Without the second one a
  // colleague's Teams room reads exactly like the operator's own conversation.
  it('marks where a conversation happened, and a shared room as hosted rather than authored', async () => {
    admin = true;
    managedOverride = [
      { ...conversations[0], id: 'brain-ch-msteams-19:room@thread.tacv2', title: 'Shared room', kind: 'channel', tokens: 10, platform: 'msteams', direct: false, ownerId: 2, ownerLabel: 'Filip', lastWriterId: 7, lastWriterLabel: 'Michal' },
      { ...conversations[1], id: 'brain-ch-msteams-a:person', title: 'Private chat', kind: 'channel', tokens: 10, platform: 'msteams', direct: true, ownerId: 2, ownerLabel: 'Michal', lastWriterId: 7, lastWriterLabel: 'Michal' },
      { ...conversations[2], id: 'brain-2-web', title: 'Web chat', kind: 'conversation', tokens: 10, platform: null, direct: false, ownerId: 2, ownerLabel: 'Filip', lastWriterId: null, lastWriterLabel: null },
    ];
    renderPanel();
    await screen.findByText('Shared room');

    const row = (title: string) => screen.getByText(title).closest('[role="row"]') as HTMLElement;
    const mark = (title: string) => row(title).querySelector('img[src^="/platforms/"]');
    // Both Teams rows carry the Teams mark; the web conversation carries none, that being the norm here.
    expect(mark('Shared room')).toHaveAttribute('src', '/platforms/msteams.svg');
    expect(mark('Private chat')).toHaveAttribute('src', '/platforms/msteams.svg');
    expect(mark('Web chat')).toBeNull();
    // The shared room names the person who WROTE there (Michal), not the account it is filed under
    // (Filip) — that is the whole complaint this fixes — and says it is a room.
    expect(within(row('Shared room')).getByText('Michal')).toBeInTheDocument();
    expect(within(row('Shared room')).queryByText('Filip')).not.toBeInTheDocument();
    expect(within(row('Shared room')).getByText('room')).toBeInTheDocument();
    // A private chat and a web conversation are genuinely their owner's: unchanged, and unmarked.
    expect(within(row('Private chat')).queryByText('room')).not.toBeInTheDocument();
    expect(within(row('Web chat')).getByText('Filip')).toBeInTheDocument();
    expect(within(row('Web chat')).queryByText('room')).not.toBeInTheDocument();
  });

  /** Export, delete and the sub-agent tree are reachable only through this button, so it may not be a
   *  hover affordance: it is quiet at rest and washes to the foreground on hover. */
  it('keeps the row action trigger visible without hover', async () => {
    renderPanel();
    const trigger = await screen.findByRole('button', { name: 'Conversation 1: Actions' });
    expect(trigger.className).not.toMatch(/\bopacity-0\b/);
    expect(trigger.className).not.toMatch(/group-hover:opacity-100/);
    expect(trigger.className).toMatch(/\btext-muted-foreground\b/);
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
    // No all/mine control here: the switcher above owns that choice and would be asking it twice.
    expect(within(toolbar).queryByRole('radio')).toBeNull();
  });

  // "Delete all" hits an endpoint that deletes exactly what is listed, and this list is every account's.
  it('offers Delete all and says that it would wipe every account', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());

    fireEvent.click(await screen.findByRole('button', { name: 'Delete all' }));
    // `alertdialog`, not `dialog`: a confirmation is an alert dialog now, which is what makes it
    // undismissable by a stray press outside it.
    const wide = await screen.findByRole('alertdialog');
    expect(within(wide).getByText(/every account/i)).toBeInTheDocument();
    fireEvent.click(within(wide).getByRole('button', { name: 'Cancel' }));
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

/** Delegated sessions belong UNDER the conversation that started them, not beside it as duplicates. The
 *  register still lists conversations: a branch is collapsed until somebody opens it, and only roots are
 *  sorted, counted and paged. */
describe('BrainSessionsPanel — the sub-agent tree', () => {
  const family = [
    { id: 'brain-root', title: 'Planning', model: 'gpt-5.5', updated_at: '2026-07-05T10:00:00.000Z', running: false, active: false, kind: 'conversation', tokens: 10, ownerId: 2, ownerLabel: 'Me' },
    { id: 'brain-child', title: 'Delegated worker', model: 'gpt-5.5', updated_at: '2026-07-04T10:00:00.000Z', running: false, active: false, kind: 'conversation', tokens: 20, ownerId: 2, ownerLabel: 'Me', parentSessionId: 'brain-root' },
    { id: 'brain-grandchild', title: 'Nested worker', model: 'gpt-5.5', updated_at: '2026-07-03T10:00:00.000Z', running: false, active: false, kind: 'conversation', tokens: 30, ownerId: 2, ownerLabel: 'Me', parentSessionId: 'brain-child' },
    { id: 'brain-orphan', title: 'Detached worker', model: 'gpt-5.5', updated_at: '2026-07-02T10:00:00.000Z', running: false, active: false, kind: 'conversation', tokens: 40, ownerId: 2, ownerLabel: 'Me', parentSessionId: 'brain-gone' },
    { id: 'brain-foreign-child', title: 'Foreign worker', model: 'gpt-5.5', updated_at: '2026-07-01T10:00:00.000Z', running: false, active: false, kind: 'conversation', tokens: 50, ownerId: 7, ownerLabel: 'Bob', parentSessionId: 'brain-root' },
  ];
  beforeEach(() => { admin = true; managedOverride = family; });

  const disclosure = (title: string) => screen.getByRole('button', { name: `Sub-agents of ${title}` });

  it('hides a delegated session until its parent branch is opened', async () => {
    renderPanel();
    await screen.findByText('Planning');
    expect(screen.queryByText('Delegated worker')).toBeNull();
    expect(disclosure('Planning')).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(disclosure('Planning'));

    expect(await screen.findByText('Delegated worker')).toBeInTheDocument();
    expect(disclosure('Planning')).toHaveAttribute('aria-expanded', 'true');
    // The grandchild stays behind its own branch — one click opens one level.
    expect(screen.queryByText('Nested worker')).toBeNull();
    fireEvent.click(disclosure('Delegated worker'));
    expect(await screen.findByText('Nested worker')).toBeInTheDocument();
  });

  it('counts descendants on the disclosure and opens the conversation only from the title', async () => {
    const opened: string[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
    window.addEventListener('elowen:open-brain-session', listener);
    try {
      renderPanel();
      await screen.findByText('Planning');
      // Two sessions hang below Planning; the foreign one is not one of them.
      expect(within(disclosure('Planning')).getByText('2')).toBeInTheDocument();

      fireEvent.click(disclosure('Planning'));
      expect(opened).toEqual([]);

      fireEvent.click(screen.getByRole('button', { name: 'Open in web chat: Planning' }));
      expect(opened).toEqual(['brain-root']);
    } finally {
      window.removeEventListener('elowen:open-brain-session', listener);
    }
  });

  it('shows a session whose parent is gone, and one owned by somebody else, as roots', async () => {
    renderPanel();
    await screen.findByText('Planning');
    // Both are visible without opening anything: an unreachable child would be a deleted conversation.
    expect(screen.getByText('Detached worker')).toBeInTheDocument();
    expect(screen.getByText('Foreign worker')).toBeInTheDocument();
    // A leaf root has nothing to disclose.
    expect(screen.queryByRole('button', { name: 'Sub-agents of Detached worker' })).toBeNull();
  });

  it('pages and counts roots, never the rows an open branch adds', async () => {
    renderPanel();
    await screen.findByText('Planning');
    const roots = () => screen.getByTestId('brain-sessions-list').querySelectorAll('[data-tree-row="root"]');
    expect(roots()).toHaveLength(3); // Planning, Detached worker, Foreign worker
    expect(within(screen.getByTestId('brain-sessions-toolbar')).getByText('3')).toBeInTheDocument();

    fireEvent.click(disclosure('Planning'));
    await screen.findByText('Delegated worker');

    expect(roots()).toHaveLength(3);
    expect(within(screen.getByTestId('brain-sessions-toolbar')).getByText('3')).toBeInTheDocument();
  });

  it('keeps a matching descendant reachable and restores the reader’s own branches after the search', async () => {
    renderPanel();
    await screen.findByText('Planning');

    // A match deep in the tree pulls its ancestors along and opens the path to it.
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'Nested' } });
    expect(await screen.findByText('Nested worker')).toBeInTheDocument();
    expect(screen.getByText('Planning')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Detached worker')).toBeNull());

    // Clearing it returns to the reader's own state, which was: everything closed.
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByText('Detached worker')).toBeInTheDocument());
    expect(screen.queryByText('Nested worker')).toBeNull();
    expect(screen.queryByText('Delegated worker')).toBeNull();

    // A branch the reader opened survives a search that hides it entirely.
    fireEvent.click(disclosure('Planning'));
    await screen.findByText('Delegated worker');
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'Detached' } });
    await waitFor(() => expect(screen.queryByText('Planning')).toBeNull());
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
    expect(await screen.findByText('Delegated worker')).toBeInTheDocument();
  });
});

/** The recurring jobs organized under a conversation. They are navigation, not sessions: they hang in
 *  their own collapsed branch, they open the cron editor, and they never enter the conversation count. */
describe('BrainSessionsPanel — scheduled job branches', () => {
  const one = [
    { id: 'brain-root', title: 'Planning', model: 'gpt-5.5', updated_at: '2026-07-05T10:00:00.000Z', running: false, active: false, kind: 'conversation', tokens: 10, ownerId: 2, ownerLabel: 'Me' },
  ];
  beforeEach(() => {
    admin = true;
    managedOverride = one;
    jobLinks = {
      status: 'available',
      links: [
        { jobId: 'job-2', conversationId: 'brain-root', name: 'Weekly report', enabled: false, scope: 'personal', href: '/p/cronjob?job=job-2' },
        { jobId: 'job-1', conversationId: 'brain-root', name: 'Nightly digest', enabled: true, scope: 'personal', href: '/p/cronjob?job=job-1' },
      ],
    };
  });

  // The disclosure is named after what it actually reveals. This conversation delegated nothing, so its
  // chevron uncovers the schedules branch alone — which is exactly the shape of a conversation created to
  // hold recurring jobs, and calling that "sub-agents" names something that is not there.
  it('names the root disclosure after the schedules when nothing was delegated below', async () => {
    renderPanel();
    await screen.findByText('Planning');
    expect(await screen.findByRole('button', { name: 'Schedules filed under Planning' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sub-agents of Planning' })).toBeNull();
  });

  it('files the schedules in their own collapsed branch and links each to its editor', async () => {
    renderPanel();
    await screen.findByText('Planning');
    expect(screen.queryByText('Scheduled jobs')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Schedules filed under Planning' }));
    const branch = await screen.findByRole('button', { name: 'Scheduled jobs of Planning' });
    expect(branch).toHaveAttribute('aria-expanded', 'false');
    expect(within(branch).getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('Nightly digest')).toBeNull();

    fireEvent.click(branch);

    // Ordered by name, and each row is a link into the job's own editor — nothing runs.
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Nightly digest', 'Weekly reportPaused']);
    expect(links[0]).toHaveAttribute('href', '/p/cronjob?job=job-1');
    expect(links[1]).toHaveAttribute('href', '/p/cronjob?job=job-2');
    expect(screen.getByRole('link', { name: 'Open the schedule: Weekly report, paused' })).toBeInTheDocument();
    // A schedule is not a conversation: the register still counts one.
    expect(within(screen.getByTestId('brain-sessions-toolbar')).getByText('1')).toBeInTheDocument();
  });

  it('finds a conversation by the name of a job filed under it', async () => {
    renderPanel();
    await screen.findByText('Planning');

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'Nightly' } });

    expect(await screen.findByText('Nightly digest')).toBeInTheDocument();
    expect(screen.getByText('Planning')).toBeInTheDocument();
    // Only the matching schedule — the other one is not an answer to this query.
    expect(screen.queryByText('Weekly report')).toBeNull();
  });

  it('says a job read failed instead of showing a conversation as having no schedules', async () => {
    jobLinks = { status: 'error', links: [] };
    renderPanel();
    await screen.findByText('Planning');
    expect(await screen.findByText('Scheduled jobs could not be loaded')).toBeInTheDocument();
  });

  it('renders no branch at all when the cron plugin cannot answer', async () => {
    jobLinks = { status: 'unavailable', links: [] };
    renderPanel();
    await screen.findByText('Planning');
    expect(screen.queryByText('Scheduled jobs could not be loaded')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Schedules filed under Planning' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sub-agents of Planning' })).toBeNull();
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

  /** The page is a page of ROOTS, so the row it is measured from has to be a root. Opening a branch puts
   *  a nested session — shorter and denser — directly under the first conversation, and measuring that
   *  one claimed ten times as many conversations fit as actually do. */
  it('measures a root row rather than whatever an open branch put second', async () => {
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) {
        if (this.dataset['treeRow'] === 'root') return { height: 100 } as DOMRect;
        if (this.getAttribute('role') === 'row') return { height: 10 } as DOMRect;
        return realRect.call(this);
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.dataset['testid'] === 'brain-sessions-scroll' ? 1000 : 0; },
    });
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    admin = true;
    managedOverride = [
      ...conversations.map((session) => ({ ...session, kind: 'conversation', tokens: 10, ownerId: 2, ownerLabel: 'Me' })),
      { id: 'brain-nested', title: 'Nested worker', model: 'gpt-5.5', updated_at: '2026-07-13T09:00:00.000Z', running: false, active: false, kind: 'conversation', tokens: 5, ownerId: 2, ownerLabel: 'Me', parentSessionId: 'brain-1' },
    ];
    try {
      renderPanel();
      await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());
      // (1000 - 10 header) / 100 = 9 conversations fit.
      await act(async () => { FakeResizeObserver.last?.run(); });
      expect(screen.queryByText('Conversation 10')).toBeNull();
      expect(screen.getByText('Conversation 9')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Sub-agents of Conversation 1' }));
      await screen.findByText('Nested worker');
      await act(async () => { FakeResizeObserver.last?.run(); });

      expect(screen.queryByText('Conversation 10')).toBeNull();
      expect(screen.getByText('Conversation 9')).toBeInTheDocument();
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: realRect });
      Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
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

/** The administrator's view of the same tree: reached from the row's action menu and drawn as a
 *  drill-down in place of the register. The register itself stays one row per conversation, with the
 *  ancestry nesting it has always had. */
describe('BrainSessionsPanel — sub-agent tree', () => {
  const branch = (subagents: Record<string, unknown[]>, over: Record<string, unknown> = {}) => {
    jobLinks = { status: 'available', links: [], subagentStatus: 'available', subagents, ...over };
  };
  const withNested = () => {
    managedOverride = [
      ...conversations.slice(0, 3).map((session) => ({ ...session, kind: 'conversation', tokens: 10, ownerId: 2, ownerLabel: 'Me' })),
      { id: 'brain-ch-subagent-sub-a', title: 'Nested worker', model: 'gpt-5.5', updated_at: '2026-07-13T09:00:00.000Z', running: false, active: false, kind: 'conversation', tokens: 5, ownerId: 2, ownerLabel: 'Me', parentSessionId: 'brain-1' },
    ];
  };
  const openTree = async (title: string, count = 1) => {
    fireEvent.click(await screen.findByRole('button', { name: `${title}: Actions` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: `Sub-agents (${count})` }));
  };

  /** The regression: every conversation of the register grew a full-width branch row with a tree guide
   *  under it. The tree moved into the row's own menu, and the register is a list of conversations again. */
  it('adds no branch row to the register and offers the tree in the row menu', async () => {
    branch({ 'brain-1': [{ kind: 'delegate', key: 'sub:a', name: 'Audit auth', status: 'done', childSessionId: 'brain-ch-subagent-sub-a', children: [] }] });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());

    fireEvent.click(await screen.findByRole('button', { name: 'Conversation 1: Actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Sub-agents (1)' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(document.querySelector('[data-tree-row="subagent"]')).toBeNull();
    expect(screen.queryByText('Audit auth')).toBeNull();
  });

  it('drills into the tree of the conversation the menu belongs to, and back', async () => {
    branch({ 'brain-1': [{ kind: 'delegate', key: 'sub:a', name: 'Audit auth', status: 'done', childSessionId: 'brain-ch-subagent-sub-a', children: [] }] });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());
    await openTree('Conversation 1');

    expect(await screen.findByTestId('brain-sessions-subagents-tree')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Conversation 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Audit auth' })).toBeInTheDocument();
    expect(screen.queryByTestId('brain-sessions-list')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Back to conversations|Zpět na konverzace|Späť na konverzácie/ }));
    expect(await screen.findByTestId('brain-sessions-list')).toBeInTheDocument();
  });

  /** The register nests a delegated session under the conversation that started it from the session
   *  ancestry alone. That is a different affordance from the tree and keeps every row it ever showed. */
  it('keeps a delegated session in its ancestry place under the conversation', async () => {
    withNested();
    branch({ 'brain-1': [{ kind: 'delegate', key: 'sub:a', name: 'Nested worker', status: 'done', childSessionId: 'brain-ch-subagent-sub-a', children: [] }] });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Sub-agents of Conversation 1' }));

    expect(await screen.findByText('Nested worker')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Sub-agent runs under/ })).toBeNull();
  });

  it('offers nothing to open for a conversation that delegated nothing', async () => {
    branch({ 'brain-1': [{ kind: 'delegate', key: 'sub:a', name: 'Audit auth', status: 'done', childSessionId: 'brain-ch-subagent-sub-a', children: [] }] });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 2')).toBeInTheDocument());

    fireEvent.click(await screen.findByRole('button', { name: 'Conversation 2: Actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Sub-agents (0)' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('opens a sub-agent read-only and lets its host dismiss', async () => {
    branch({ 'brain-1': [{ kind: 'delegate', key: 'sub:a', name: 'Audit auth', status: 'error', childSessionId: 'brain-ch-subagent-sub-a', children: [] }] });
    const opened: BrainOpenRequest[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent<BrainOpenRequest>).detail);
    window.addEventListener(BRAIN_OPEN_EVENT, listener);
    try {
      renderPanel();
      await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());
      await openTree('Conversation 1');
      fireEvent.click(await screen.findByRole('button', { name: 'Audit auth' }));
    } finally {
      window.removeEventListener(BRAIN_OPEN_EVENT, listener);
    }

    expect(opened).toEqual([{ sessionId: 'brain-ch-subagent-sub-a', continuable: false }]);
  });

  /** The branch is a tree walk, and this register spans every account. It is asked for the page on
   *  screen rather than for the whole instance. */
  it('asks for the branches of the page on screen', async () => {
    branch({});
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());

    await waitFor(() => expect(branchRequests.at(-1)).toBeTruthy());
    const asked = branchRequests.at(-1)!.split(',');
    expect(asked).toContain('brain-1');
    // Page one holds twelve of the thirteen conversations, so the thirteenth is not asked about.
    expect(asked).not.toContain('brain-13');
    // And no request ever goes out WITHOUT the narrowing: an empty page omits the parameter entirely,
    // which the daemon reads as "every conversation the caller can see".
    expect(branchRequests).not.toContain(null);
  });

  it('says a failed core read out loud rather than showing every conversation as having delegated nothing', async () => {
    branch({}, { subagentStatus: 'error' });
    renderPanel();

    await waitFor(() => expect(screen.getByText('Sub-agents could not be loaded')).toBeInTheDocument());
  });
});
