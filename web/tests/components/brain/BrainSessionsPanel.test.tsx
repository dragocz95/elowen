import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'user', is_admin: admin } })),
  http.get('*/api/brain/sessions', () => HttpResponse.json(conversations)),
  http.get('*/api/brain/managed-sessions', () => HttpResponse.json(conversations.map((session) => ({ ...session, kind: 'conversation', tokens: 1200 })) )),
);
beforeEach(() => { admin = false; localStorage.clear(); });
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
  it('offers Delete all over the admin\'s own list, never over the whole team\'s', async () => {
    admin = true;
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Delete all' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Just mine' }));

    const button = await screen.findByRole('button', { name: 'Delete all' });
    expect(button).toHaveClass('spatial-inline-action');
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
