import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import type { BrainActivityView } from '../../../lib/types';
import { BRAIN_COMPOSE_EVENT, BRAIN_OPEN_EVENT, type BrainOpenRequest } from '../../../lib/brainDock';
import { ConversationHistoryPanel } from '../../../modules/advisor/ConversationHistoryPanel';

type TestSession = {
  id: string;
  title: string;
  provider?: string;
  model: string;
  updated_at: string;
  running: boolean;
  active: boolean;
  tokens?: number;
  activity?: BrainActivityView;
};

// The panel reads the ONE controller (BrainChatProvider) and the client directly (search/rename/export);
// delete stays on the controller. We stub both so the test asserts the exact wiring.
const ctrl = vi.hoisted(() => {
  const switchSession = vi.fn(() => Promise.resolve());
  const startNewConversation = vi.fn(() => Promise.resolve());
  const deleteSession = vi.fn(() => Promise.resolve());
  const data: TestSession[] = [
    { id: 's1', title: 'First', provider: 'chatgpt-account', model: 'openai/gpt-5.6-sol', updated_at: '2026-07-08T10:00:00.000Z', running: false, active: true, tokens: 1234 },
    { id: 's2', title: 'Second', model: 'sonnet', updated_at: '2026-07-07T10:00:00.000Z', running: false, active: false, tokens: 10 },
  ];
  return {
    switchSession,
    startNewConversation,
    deleteSession,
    value: {
      sessions: { data },
      switchSession,
      startNewConversation,
      deleteSession,
    },
  };
});
const client = vi.hoisted(() => ({
  brainSearch: vi.fn(() => Promise.resolve([{ sessionId: 's9', sessionTitle: 'Hit session', role: 'user', snippet: 'hello world', ts: '2026-07-08T00:00:00Z' }])),
  brainRenameSession: vi.fn(() => Promise.resolve({ id: 's1', title: 'Renamed' })),
  brainExportSession: vi.fn(() => Promise.resolve()),
  brainForkSession: vi.fn(() => Promise.resolve({ id: 's1-fork', title: 'First', forkedFrom: 's1' })),
  brainConversationLinks: vi.fn(() => Promise.resolve(
    { status: 'available', links: [] as Record<string, unknown>[] } as Record<string, unknown>,
  )),
}));

vi.mock('../../../modules/advisor/BrainChatProvider', () => ({ useBrainChat: () => ctrl.value }));
vi.mock('../../../lib/elowenClient', () => ({ elowenClient: client }));

/** The panel as its only host renders it: bare inside the shared switcher modal. The surface, Escape, the
 *  focus trap and dismissal belong to that modal now and are pinned in its own test — what is pinned here
 *  is the table itself, which is the same table the administrator's register draws. */
function renderPanel(props: { onNavigate?: () => void; homeLink?: boolean } = {}) {
  const { wrapper: Wrapper, client: qc } = createWrapper();
  const utils = render(
    <Wrapper><ToastProvider><ConversationHistoryPanel {...props} /></ToastProvider></Wrapper>,
  );
  return { ...utils, qc };
}

const openRowMenu = (rowIndex: number) => {
  fireEvent.click(screen.getAllByRole('button', { name: /More actions|Další akce/i })[rowIndex]!);
};

/** The table row a conversation title sits in. */
const rowOf = (title: string): HTMLElement => screen.getByText(title).closest('[role="row"]') as HTMLElement;

beforeEach(() => {
  ctrl.value.sessions.data = [
    { id: 's1', title: 'First', provider: 'chatgpt-account', model: 'openai/gpt-5.6-sol', updated_at: '2026-07-08T10:00:00.000Z', running: false, active: true, tokens: 1234 },
    { id: 's2', title: 'Second', model: 'sonnet', updated_at: '2026-07-07T10:00:00.000Z', running: false, active: false, tokens: 10 },
  ];
  ctrl.switchSession.mockClear();
  ctrl.startNewConversation.mockClear();
  ctrl.deleteSession.mockClear();
  client.brainSearch.mockClear();
  client.brainRenameSession.mockClear();
  client.brainExportSession.mockClear();
  client.brainForkSession.mockClear();
  client.brainConversationLinks.mockClear();
  client.brainConversationLinks.mockResolvedValue({ status: 'available', links: [] });
});

describe('ConversationHistoryPanel', () => {
  // The personal list and the administrator's register are ONE table: same columns in the same order,
  // with the owner replaced by the state, because every row here already belongs to the reader.
  it('renders the register table with the state column in front of the model', () => {
    renderPanel();
    const table = screen.getByTestId('conversation-history-list');
    expect(table).toHaveAttribute('role', 'table');
    const header = within(table).getAllByRole('row')[0]!;
    const names = within(header).getAllByRole('columnheader').map((cell) => cell.textContent);
    // The trailing name belongs to the row-wide open control, which is the whole row's single tab stop.
    expect(names).toEqual(['State', 'Model', 'Conversation', 'Tokens', 'Updated', 'Actions', 'Open']);
    expect(within(rowOf('First')).getByText('1.2k')).toBeInTheDocument();
    // A phone keeps the state and the name and nothing else: the model, the tokens and the timestamp are
    // all wide-only, so the title is never squeezed into a few characters on a 390px screen.
    for (const column of ['Model', 'Tokens', 'Updated']) {
      expect(within(header).getByRole('columnheader', { name: new RegExp(`^${column}`) })).toHaveAttribute('data-priority', 'wide');
    }
    expect(within(header).getByRole('columnheader', { name: /^Conversation/ })).toHaveAttribute('data-priority', 'always');
  });

  it('lists conversations with the bare structured model name', () => {
    renderPanel();
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    const model = screen.getByText('openai/gpt-5.6-sol');
    expect(model.closest('[title]')).toHaveAttribute('title', 'chatgpt-account/openai/gpt-5.6-sol');
    expect(screen.queryByText('chatgpt-account/openai/gpt-5.6-sol')).toBeNull();
  });

  /** Rename, branch, export, delete and the sub-agent tree are reachable only through this button, so a
   *  reader has to be able to SEE that the row has actions before touching it. It used to be painted at
   *  `opacity-0` until the row was hovered. */
  it('keeps the row action trigger visible without hover', () => {
    renderPanel();
    for (const trigger of screen.getAllByRole('button', { name: /More actions|Další akce|Ďalšie akcie/i })) {
      expect(trigger.className).not.toMatch(/\bopacity-0\b/);
      expect(trigger.className).not.toMatch(/group-hover:opacity-100/);
      // Quiet, not invisible: muted at rest and the ordinary foreground wash on hover.
      expect(trigger.className).toMatch(/\btext-muted-foreground\b/);
    }
  });

  it('uses the shared Radix action-menu keyboard contract and returns focus on Escape', async () => {
    renderPanel();
    const trigger = screen.getAllByRole('button', { name: /More actions|Další akce/i })[0]!;
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    const rename = await screen.findByRole('menuitem', { name: /^Rename$|^Přejmenovat$/i });
    await waitFor(() => expect(rename).toHaveFocus());
    fireEvent.keyDown(rename, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /Branch conversation|Větvit konverzaci|Vetviť konverzáciu/i })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('returns delete-confirm Cancel and Escape focus to the exact row action trigger', async () => {
    renderPanel();
    const trigger = screen.getAllByRole('button', { name: /More actions|Další akce/i })[1]!;

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete conversation|Smazat konverzaci/i }));
    const firstConfirm = await screen.findByRole('alertdialog', { name: /Delete this conversation|Smazat tuto konverzaci/i });
    fireEvent.click(within(firstConfirm).getByRole('button', { name: /Cancel|Zrušit/i }));
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete conversation|Smazat konverzaci/i }));
    const secondConfirm = await screen.findByRole('alertdialog', { name: /Delete this conversation|Smazat tuto konverzaci/i });
    fireEvent.keyDown(secondConfirm, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('shows a back-to-dashboard link only when homeLink is set (phone /chat has no TopBar)', () => {
    const { wrapper: Wrapper } = createWrapper();
    const linkName = /Přehled|Dashboard|Prehľad/i;
    const { rerender } = render(<Wrapper><ToastProvider><ConversationHistoryPanel /></ToastProvider></Wrapper>);
    expect(screen.queryByRole('link', { name: linkName })).not.toBeInTheDocument();
    rerender(<Wrapper><ToastProvider><ConversationHistoryPanel homeLink /></ToastProvider></Wrapper>);
    expect(screen.getByRole('link', { name: linkName })).toHaveAttribute('href', '/dash');
  });

  // The new-conversation control hands the whole act to the controller: it creates the conversation, asks
  // which project it runs in, and only then reveals the chat. The switcher's own job is to get out of the
  // way, so the project question is not raised behind the list it was started from.
  it('hands a new conversation to the controller and dismisses the switcher', async () => {
    const composed = vi.fn();
    window.addEventListener(BRAIN_COMPOSE_EVENT, composed);
    const onNavigate = vi.fn();
    renderPanel({ onNavigate });
    fireEvent.click(screen.getByRole('button', { name: /New chat|Nová konverzace/i }));
    expect(ctrl.startNewConversation).toHaveBeenCalledTimes(1);
    expect(ctrl.switchSession).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    // The composer is revealed once the project question is settled, which is the controller's half.
    await Promise.resolve();
    expect(composed).not.toHaveBeenCalled();
    window.removeEventListener(BRAIN_COMPOSE_EVENT, composed);
  });

  // Opening a conversation has to bring the CHAT on screen, not merely rebind the controller. Raised from
  // the dock over a plugin page — or on a phone, which has no dock at all — a bare switch left the reader
  // looking at the settings page they opened the switcher over, with the conversation loaded behind it.
  // The WHOLE row opens the conversation, not a button around the title: on a phone a name-sized target
  // in a 40px row is the difference between switching conversations and missing.
  it('opens a picked conversation through the shared open-in-chat request', () => {
    const opened = vi.fn();
    window.addEventListener(BRAIN_OPEN_EVENT, opened);
    renderPanel();
    const open = within(rowOf('Second')).getByRole('button', { name: 'Open in web chat: Second' });
    expect(open).toHaveClass('data-table-row-open');
    fireEvent.click(open);
    expect(opened).toHaveBeenCalled();
    expect((opened.mock.calls[0]![0] as CustomEvent<BrainOpenRequest>).detail)
      .toEqual({ sessionId: 's2', continuable: true });
    window.removeEventListener(BRAIN_OPEN_EVENT, opened);
  });

  it('confirms the concrete delete consequence before calling the controller', async () => {
    renderPanel();
    openRowMenu(1); // the second, non-active row
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete conversation|Smazat konverzaci/i }));
    expect(ctrl.deleteSession).not.toHaveBeenCalled();

    const confirmation = await screen.findByRole('alertdialog', { name: /Delete this conversation|Smazat tuto konverzaci/i });
    expect(confirmation).toHaveTextContent('Second');
    fireEvent.click(screen.getByRole('button', { name: /Delete conversation|Smazat konverzaci/i }));
    await waitFor(() => expect(ctrl.deleteSession).toHaveBeenCalledWith('s2', false));
  });

  it('keeps the conversation and confirmation in place when deletion fails', async () => {
    ctrl.deleteSession.mockRejectedValueOnce(new Error('delete failed'));
    renderPanel();
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete conversation|Smazat konverzaci/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Delete conversation|Smazat konverzaci/i }));

    await waitFor(() => expect(ctrl.deleteSession).toHaveBeenCalledWith('s1', true));
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog', { name: /Delete this conversation|Smazat tuto konverzaci/i })).toBeInTheDocument();
  });

  it('locks a pending delete, deduplicates confirmation, then settles before another session can open', async () => {
    let resolveDelete!: () => void;
    ctrl.deleteSession.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    const { container } = renderPanel();

    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete conversation|Smazat konverzaci/i }));
    const dialog = await screen.findByRole('alertdialog', { name: /Delete this conversation|Smazat tuto konverzaci/i });
    const confirm = within(dialog).getByRole('button', { name: /Delete conversation|Smazat konverzaci/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(ctrl.deleteSession).toHaveBeenCalledTimes(1);
      expect(dialog).toHaveAttribute('aria-busy', 'true');
      expect(confirm).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: /Cancel|Zrušit/i })).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: /Close|Zavřít/i })).toBeDisabled();
      expect(container).toHaveAttribute('inert');
      expect(container).toHaveAttribute('aria-hidden', 'true');
    });

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getAllByRole('alertdialog')).toEqual([dialog]);

    resolveDelete();
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: /Delete this conversation|Smazat tuto konverzaci/i })).not.toBeInTheDocument());
    expect(container).not.toHaveAttribute('inert');

    openRowMenu(1);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete conversation|Smazat konverzaci/i }));
    expect(await screen.findByRole('alertdialog', { name: /Delete this conversation|Smazat tuto konverzaci/i })).toHaveTextContent('Second');
  });

  it('renames via brainRenameSession then invalidates the sessions query', async () => {
    const { qc } = renderPanel();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Rename$|^Přejmenovat$/i }));
    const input = screen.getByRole('textbox', { name: /Conversation title|Název konverzace/i });
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(client.brainRenameSession).toHaveBeenCalledWith('s1', 'New name'));
    expect(client.brainRenameSession).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['brain-sessions'] }));
  });

  it('keeps a failed rename open and retries from the inline status', async () => {
    client.brainRenameSession.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ id: 's1', title: 'Retried' });
    renderPanel();
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Rename$|^Přejmenovat$/i }));
    const input = screen.getByRole('textbox', { name: /Conversation title|Název konverzace/i });
    fireEvent.change(input, { target: { value: 'Retry me' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(client.brainRenameSession).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('textbox', { name: /Conversation title|Název konverzace/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry|Zkusit znovu/i }));
    await waitFor(() => expect(client.brainRenameSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /Conversation title|Název konverzace/i })).toBeNull());
  });

  it('cancels a rename on Escape without committing', () => {
    renderPanel();
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Rename$|^Přejmenovat$/i }));
    const input = screen.getByRole('textbox', { name: /Conversation title|Název konverzace/i });
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(client.brainRenameSession).not.toHaveBeenCalled();
    expect(screen.getByText('First')).toBeInTheDocument();
  });

  it('exports a conversation as HTML and as JSONL', () => {
    renderPanel();
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /Export as HTML|Exportovat jako HTML/i }));
    expect(client.brainExportSession).toHaveBeenCalledWith('s1', 'html');
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /Export as JSONL|Exportovat jako JSONL/i }));
    expect(client.brainExportSession).toHaveBeenCalledWith('s1', 'jsonl');
  });

  it('branches a conversation and opens the copy, leaving the source selected until then', async () => {
    const opened = vi.fn();
    window.addEventListener(BRAIN_OPEN_EVENT, opened);
    renderPanel();
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /Branch conversation|Větvit konverzaci|Vetviť konverzáciu/i }));
    await waitFor(() => expect(client.brainForkSession).toHaveBeenCalledWith('s1'));
    // The user lands in the NEW conversation — never back in the one they branched off.
    await waitFor(() => expect((opened.mock.calls.at(-1)?.[0] as CustomEvent<BrainOpenRequest>).detail)
      .toEqual({ sessionId: 's1-fork', continuable: true }));
    window.removeEventListener(BRAIN_OPEN_EVENT, opened);
  });

  // A transcript hit does not add a row of its own: the conversation it belongs to stays one row, and the
  // snippet says WHY that row survived the query.
  it('runs a fulltext search (≥2 chars) and highlights the match under the conversation', async () => {
    client.brainSearch.mockResolvedValueOnce([{ sessionId: 's1', sessionTitle: 'First', role: 'user', snippet: 'hello world', ts: '2026-07-08T00:00:00Z' }]);
    renderPanel();
    fireEvent.change(screen.getByRole('searchbox', { name: /Search conversations|Hledat v konverzacích/i }), { target: { value: 'he' } });
    await waitFor(() => expect(client.brainSearch).toHaveBeenCalledWith('he'));
    expect(await screen.findByText(/llo world/)).toBeInTheDocument();
    const mark = document.querySelector('mark');
    expect(mark?.textContent).toBe('he');
    // The conversation that did NOT answer the query is gone from the table.
    expect(screen.queryByText('Second')).toBeNull();
  });

  it('carries the conversation activity state and unread mark into a searched row', async () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'done', seq: 8, at: null, detail: 'Finished', unread: true };
    client.brainSearch.mockResolvedValueOnce([{ sessionId: 's1', sessionTitle: 'First', role: 'assistant', snippet: 'hello', ts: '2026-07-08T00:00:00Z' }]);
    renderPanel();
    fireEvent.change(screen.getByRole('searchbox', { name: /Search conversations|Hledat v konverzacích/i }), { target: { value: 'he' } });
    const result = await screen.findByText('First');
    expect(result).toHaveClass('font-semibold');
    const row = result.closest('[role="row"]')!;
    expect(row).toHaveAttribute('aria-current', 'page');
    expect(row.querySelector('[data-unread]')).toHaveAttribute('aria-hidden', 'true');
    expect(row.querySelector('[data-activity-state]')).toHaveAttribute('data-activity-state', 'done');
  });

  it('renders neutral activity without inventing a state icon', () => {
    renderPanel();
    const state = rowOf('First').querySelector('[data-activity-state]')!;
    expect(state).toHaveAttribute('data-activity-state', 'idle');
    expect(state.querySelector('svg')).toBeNull();
    expect(state.querySelectorAll('.sr-only')).toHaveLength(1);
  });

  it('renders working activity as a reduced-motion-safe green pulse', () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'working', seq: 3, at: null, detail: 'Running', unread: false };
    renderPanel();
    const state = rowOf('First').querySelector('[data-activity-state]')!;
    const icon = state.querySelector('svg')!;
    expect(state).toHaveAttribute('data-activity-state', 'working');
    expect(icon).toHaveAttribute('width', '8');
    expect(icon).toHaveClass('animate-pulse', 'fill-success', 'text-success', 'motion-reduce:animate-none');
    expect(within(state as HTMLElement).getByText('Working')).toBeInTheDocument();
  });

  it('keeps a read done check and does not render an unread badge', () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'done', seq: 4, at: null, detail: 'Finished', unread: false };
    renderPanel();
    const row = rowOf('First');
    const state = row.querySelector('[data-activity-state]')!;
    expect(state).toHaveAttribute('data-activity-state', 'done');
    expect(state.querySelector('svg')).toHaveClass('lucide-circle-check', 'text-success');
    expect(row.querySelector('[data-unread]')).toBeNull();
  });

  // A tick reads as "the answer you asked for is ready". A schedule firing into a conversation produces
  // neither a question nor a reader waiting on it, so a finished job wears the clock its schedules wear
  // and says so out loud. Only the completed state differs: a failed run is a failed run either way.
  it('marks a completed SCHEDULED turn with the job clock instead of the done check', () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'done', seq: 9, at: null, detail: 'Digest sent', automation: 'scheduled', unread: true };
    renderPanel();
    const row = rowOf('First');
    const state = row.querySelector('[data-activity-state]')!;
    expect(state).toHaveAttribute('data-activity-state', 'done');
    expect(state.querySelector('svg')).toHaveClass('lucide-clock', 'text-success');
    expect(within(row).getByText('Scheduled job completed, Unread result')).toBeInTheDocument();
  });

  it('renders a done unread result with a semibold title and an independent accent mark', () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'done', seq: 5, at: null, detail: 'Finished', unread: true };
    renderPanel();
    const row = rowOf('First');
    expect(screen.getByText('First')).toHaveClass('font-semibold');
    const badge = row.querySelector('[data-unread]')!;
    expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(badge).toHaveClass('bg-primary', 'rounded-full');
    expect(within(row).getByText('Completed, Unread result')).toBeInTheDocument();
  });

  // The failure tip hangs off the STATE cell, which is a cell of its own — inside the row's title button a
  // second tab stop would be invalid markup, the row's own onClick would eat the tap meant to reveal the
  // tip, and the floating panel is content no button may contain.
  it('exposes a bounded failed tooltip from the state cell, never from inside the row button', async () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'failed', seq: 6, at: null, detail: 'The provider rejected the request.', unread: false };
    renderPanel();
    const row = rowOf('First');
    const rowButton = within(row).getByRole('button', { name: 'Open in web chat: First' });
    expect(rowButton.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    expect(rowButton.querySelector('[data-slot="tooltip-anchor"]')).toBeNull();

    const state = within(row).getByRole('button', { name: 'Run failed' });
    fireEvent.focus(state);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveClass('w-64');
    expect(tip).toHaveTextContent('The provider rejected the request.');
    expect(state).toHaveAttribute('aria-describedby', tip.id);
    expect(row.querySelector('[data-unread]')).toBeNull();

    fireEvent.blur(state);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(state).not.toHaveAttribute('aria-describedby');
  });

  it('opens the same failure tip from hover', async () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'failed', seq: 6, at: null, detail: 'Connection refused.', unread: false };
    renderPanel();
    const state = within(rowOf('First')).getByRole('button', { name: 'Run failed' });

    fireEvent.mouseEnter(state);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Connection refused.');
    fireEvent.mouseLeave(state);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  // A row whose run did not fail carries no tip at all — no anchor, no panel, and no control in the cell.
  it('adds no tooltip wiring to a row that did not fail', () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'done', seq: 6, at: null, detail: 'Finished', unread: false };
    renderPanel();
    const row = rowOf('First');
    expect(row.querySelector('[data-slot="tooltip-anchor"]')).toBeNull();
    expect(within(row).queryByRole('button', { name: /Completed/ })).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps failed unread state independent from the destructive tooltip', () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'failed', seq: 7, at: null, detail: 'Failed to connect.', unread: true };
    renderPanel();
    const row = rowOf('First');
    const state = row.querySelector('[data-activity-state]')!;
    expect(state.querySelector('svg')).toHaveClass('fill-destructive', 'text-destructive');
    expect(row.querySelector('[data-unread]')).toHaveAttribute('aria-hidden', 'true');
    expect(within(row).getByText('Run failed, Unread result')).toBeInTheDocument();
  });

  it('keeps active selection and action keyboard access', async () => {
    renderPanel();
    expect(rowOf('First')).toHaveAttribute('aria-current', 'page');
    const trigger = screen.getAllByRole('button', { name: /More actions|Další akce/i })[0]!;
    // The touch-only reveal it used to carry is gone: the trigger is visible on every pointer now.
    expect(trigger).not.toHaveClass('pointer-coarse:opacity-100');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /^Rename$|^Přejmenovat$/i })).toHaveFocus());
  });

  // The table sorts on every column it shows, exactly as the register does.
  it('sorts by a column and reverses it on a second click', () => {
    renderPanel();
    const titles = () => screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    fireEvent.click(screen.getByRole('button', { name: /^Conversation/ }));
    expect(titles()[0]).toContain('First');
    fireEvent.click(screen.getByRole('button', { name: /^Conversation/ }));
    expect(titles()[0]).toContain('Second');
  });
});

/** The recurring jobs filed under a conversation, as a collapsed branch under its row. */
describe('ConversationHistoryPanel — scheduled job branches', () => {
  const digest = { jobId: 'job-1', conversationId: 's1', name: 'Nightly digest', enabled: true, scope: 'personal', href: '/p/cronjob?job=job-1' };
  const report = { jobId: 'job-2', conversationId: 's1', name: 'Weekly report', enabled: false, scope: 'personal', href: '/p/cronjob?job=job-2' };
  const withLinks = (...links: Record<string, unknown>[]) =>
    client.brainConversationLinks.mockResolvedValue({ status: 'available', links });
  const branch = () => screen.findByRole('button', { name: 'Scheduled jobs of First' });

  it('keeps the schedules folded away until the disclosure is opened', async () => {
    withLinks(digest, report);
    renderPanel();
    const trigger = await branch();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(within(trigger).getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('Nightly digest')).toBeNull();
    // A conversation with no schedules gets no branch at all.
    expect(screen.queryByRole('button', { name: 'Scheduled jobs of Second' })).toBeNull();

    fireEvent.click(trigger);

    const links = await screen.findAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/p/cronjob?job=job-1', '/p/cronjob?job=job-2']);
    expect(screen.getByRole('link', { name: 'Open the schedule: Weekly report, paused' })).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls');
  });

  /** A schedule is drawn as a branch of the conversation above it, not as a row that merely starts
   *  further right — and the trunk stops at the LAST one, which is what closes the group. */
  it('draws each schedule as a branch of its conversation and closes the trunk on the last', async () => {
    withLinks(digest, report);
    renderPanel();
    fireEvent.click(await branch());

    await screen.findByText('Nightly digest');
    const guides = document.querySelectorAll('[data-tree-guide]');
    expect(Array.from(guides).map((g) => g.getAttribute('data-tree-guide'))).toEqual(['branch', 'last']);
  });

  // Following a schedule is meant to land in the transcript its runs produced, which is where a reader who
  // clicks a job from a conversation list is going. Only a schedule the daemon could not place that way —
  // one that has never fired — keeps pointing at the schedule's own editor.
  it('opens the conversation a schedule actually ran in when the daemon names one', async () => {
    const opened = vi.fn();
    window.addEventListener(BRAIN_OPEN_EVENT, opened);
    withLinks({ ...digest, run: { sessionId: 'brain-ch-cron-job-1', continuable: false } });
    const onNavigate = vi.fn();
    renderPanel({ onNavigate });
    fireEvent.click(await branch());
    fireEvent.click(await screen.findByRole('button', { name: /Nightly digest/ }));
    expect((opened.mock.calls.at(-1)?.[0] as CustomEvent<BrainOpenRequest>).detail)
      .toEqual({ sessionId: 'brain-ch-cron-job-1', continuable: false });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    window.removeEventListener(BRAIN_OPEN_EVENT, opened);
  });

  it('separates the disclosure from opening the conversation', async () => {
    withLinks(digest);
    renderPanel();
    fireEvent.click(await branch());
    expect(ctrl.switchSession).not.toHaveBeenCalled();
    // The trigger is a sibling of the row-wide open control, never nested inside it, and it keeps its own
    // pointer events while the title cell hands its clicks down to the row.
    const row = rowOf('First');
    expect(within(row).getByRole('button', { name: 'Open in web chat: First' }).querySelector('[aria-expanded]')).toBeNull();
    expect(within(row).getByRole('button', { name: /Scheduled jobs of First/ })).toHaveClass('pointer-events-auto');
    expect(screen.getByText('First').closest('[role="cell"]')).toHaveClass('pointer-events-none');
  });

  // Opening a schedule leaves the app on another surface, so the switcher covering it has to go — the
  // panel says so once, through the host's callback, and never dismisses anything itself.
  it('tells its host to close when a schedule is opened', async () => {
    withLinks(digest);
    const onNavigate = vi.fn();
    renderPanel({ onNavigate });
    fireEvent.click(await branch());
    fireEvent.click(await screen.findByRole('link', { name: /Nightly digest/ }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('adds job matches to the search without losing the transcript snippet', async () => {
    withLinks(digest, report);
    client.brainSearch.mockResolvedValueOnce([
      { sessionId: 's1', sessionTitle: 'First', role: 'user', snippet: 'a digest of the day', ts: '2026-07-08T00:00:00Z' },
    ]);
    renderPanel();
    fireEvent.change(screen.getByRole('searchbox', { name: /Search conversations|Hledat v konverzacích/i }), { target: { value: 'digest' } });

    // The snippet survives, highlight and all — the match itself sits in its own <mark>.
    expect(await screen.findByText(/of the day/)).toBeInTheDocument();
    expect(document.querySelectorAll('mark')).toHaveLength(1);
    // A matching schedule uncovers the branch it sits in, and a conversation that answered the query in
    // its own right keeps its whole schedule list rather than being pruned down to the matching one.
    const jobRows = await screen.findAllByRole('link', { name: /Open the schedule/ });
    expect(jobRows.map((a) => a.getAttribute('href'))).toEqual(['/p/cronjob?job=job-1', '/p/cronjob?job=job-2']);
  });

  it('never lists a conversation the switcher does not hold', async () => {
    // A direct platform chat is an eligible cron target but is NOT in the personal conversation list.
    withLinks({ ...digest, conversationId: 'brain-ch-telegram-42', name: 'Channel digest' });
    renderPanel();
    await screen.findByText('First');
    expect(screen.queryByText('Channel digest')).toBeNull();
    expect(screen.queryByRole('button', { name: /Scheduled jobs of/ })).toBeNull();
  });

  it('says a job read failed instead of showing every conversation as unscheduled', async () => {
    client.brainConversationLinks.mockResolvedValue({ status: 'error', links: [] });
    renderPanel();
    // A line that appears under a long list after the fact is missed by a reader who is not looking at
    // it, so it is announced — the register says the same thing the same way.
    expect(await screen.findByRole('status')).toHaveTextContent('Scheduled jobs could not be loaded');
  });

  it('shows nothing at all when the cron plugin cannot answer', async () => {
    client.brainConversationLinks.mockResolvedValue({ status: 'unavailable', links: [] });
    renderPanel();
    await screen.findByText('First');
    expect(screen.queryByText('Scheduled jobs could not be loaded')).toBeNull();
    expect(screen.queryByRole('button', { name: /Scheduled jobs of/ })).toBeNull();
  });
});

/** The sub-agents that ran under a personal conversation. They are reached from the conversation's own
 *  action menu and shown as a drill-down INSIDE the switcher — the register itself stays a list of
 *  conversations, one row each. Navigation into what already ran: every row of the tree either opens a
 *  transcript READ-ONLY or does nothing but expand. */
describe('ConversationHistoryPanel — sub-agent tree', () => {
  const agent = (over: Partial<Record<string, unknown>> = {}) => ({
    kind: 'delegate', key: 'sub:c-a', name: 'Audit auth', status: 'done',
    childSessionId: 'brain-ch-subagent-sub-a', children: [], ...over,
  });
  const withBranch = (subagents: Record<string, unknown[]>, over: Record<string, unknown> = {}) => {
    client.brainConversationLinks.mockResolvedValue({
      status: 'available', links: [], subagentStatus: 'available', subagents, subagentsTruncated: false, ...over,
    });
  };
  const menuOf = (title: string) => screen.findByRole('button', { name: new RegExp(`^${title}: (More actions|Další akce|Ďalšie akcie)`) });
  /** Open a conversation's tree the only way the panel offers it. */
  const openTree = async (title: string, count = 1) => {
    fireEvent.click(await menuOf(title));
    fireEvent.click(await screen.findByRole('menuitem', { name: `Sub-agents (${count})` }));
  };

  /** The regression: every conversation grew a full-width branch row with a tree guide under it, on a
   *  surface whose rows are supposed to be one conversation each. */
  it('adds no branch row under the conversation and offers the tree in its menu instead', async () => {
    withBranch({ s1: [agent()] });
    renderPanel();

    fireEvent.click(await menuOf('First'));
    expect(await screen.findByRole('menuitem', { name: 'Sub-agents (1)' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(document.querySelector('[data-tree-row="subagent"]')).toBeNull();
    expect(screen.queryByText('Audit auth')).toBeNull();
  });

  it('drills into the tree of the conversation the menu belongs to, and back', async () => {
    withBranch({ s1: [agent()] });
    renderPanel();
    await openTree('First');

    // The drill-down takes the surface over: the conversation it belongs to is named at the top and the
    // list of conversations is gone until the reader comes back.
    expect(await screen.findByTestId('conversation-subagents-tree')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'First' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Audit auth' })).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-history-list')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Back to conversations|Zpět na konverzace|Späť na konverzácie/ }));
    expect(await screen.findByTestId('conversation-history-list')).toBeInTheDocument();
    expect(screen.queryByText('Audit auth')).toBeNull();
  });

  it('offers nothing to open for a conversation that delegated nothing', async () => {
    withBranch({ s1: [agent()] });
    renderPanel();

    fireEvent.click(await menuOf('Second'));
    expect(await screen.findByRole('menuitem', { name: 'Sub-agents (0)' })).toHaveAttribute('aria-disabled', 'true');
  });

  /** A finished delegation is a record of what happened, not a chat to resume — and the daemon would
   *  refuse a post into it anyway. `continuable` must therefore be FALSE. */
  it('opens a sub-agent read-only and dismisses the switcher behind it', async () => {
    withBranch({ s1: [agent()] });
    const opened = vi.fn();
    const onNavigate = vi.fn();
    window.addEventListener(BRAIN_OPEN_EVENT, opened);
    try {
      renderPanel({ onNavigate });
      await openTree('First');
      fireEvent.click(await screen.findByRole('button', { name: 'Audit auth' }));
    } finally {
      window.removeEventListener(BRAIN_OPEN_EVENT, opened);
    }

    expect((opened.mock.calls[0]![0] as CustomEvent<BrainOpenRequest>).detail)
      .toEqual({ sessionId: 'brain-ch-subagent-sub-a', continuable: false });
    expect(onNavigate).toHaveBeenCalled();
  });

  /** A workflow fans out to N node sessions and never had a transcript of its own, so its row groups
   *  rather than navigates. Its nodes are the rows worth following. */
  it('groups a workflow and only lets its nodes be opened', async () => {
    withBranch({
      s1: [{
        kind: 'workflow', key: 'wf:s1:call-9', name: 'Batch', status: 'running', children: [
          { kind: 'workflowNode', key: 'wfn:1', name: 'Review', status: 'done', childSessionId: 'brain-ch-subagent-wf-1', children: [] },
          { kind: 'workflowNode', key: 'wfn:2', name: 'Publish the summary', status: 'pending', children: [] },
        ],
      }],
    });
    renderPanel();
    // The count is every row the tree can draw, nested ones included.
    await openTree('First', 3);

    expect(screen.queryByRole('button', { name: 'Batch' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'What Batch delegated' }));
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
    // An undispatched node has no transcript to open, and nothing pretends otherwise.
    expect(screen.queryByRole('button', { name: 'Publish the summary' })).toBeNull();
    expect(screen.getByText('Publish the summary')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
  });

  it('keeps the tree on screen across a refetch', async () => {
    withBranch({ s1: [agent()] });
    const { qc } = renderPanel();
    await openTree('First');
    expect(await screen.findByText('Audit auth')).toBeInTheDocument();

    await qc.invalidateQueries({ queryKey: ['brain-conversation-links'] });

    await waitFor(() => expect(screen.getByText('Audit auth')).toBeInTheDocument());
    expect(screen.getByTestId('conversation-subagents-tree')).toBeInTheDocument();
  });

  it('says a failed core read out loud instead of showing every conversation as having delegated nothing', async () => {
    client.brainConversationLinks.mockResolvedValue({
      status: 'available', links: [], subagentStatus: 'error', subagents: {}, subagentsTruncated: false,
    });
    renderPanel();

    expect(await screen.findByRole('status')).toHaveTextContent('Sub-agents could not be loaded');
  });

  it('shows no tree at all for a daemon that does not carry one', async () => {
    client.brainConversationLinks.mockResolvedValue({ status: 'available', links: [] });
    renderPanel();
    await screen.findByText('First');

    fireEvent.click(await menuOf('First'));
    expect(await screen.findByRole('menuitem', { name: 'Sub-agents (0)' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText('Sub-agents could not be loaded')).toBeNull();
  });

  /** The id list narrows the tree read to the rows on screen. An EMPTY list is "no conversation is on
   *  screen" — but the client omits the parameter when it has no ids, and the daemon then walks the
   *  sub-agent tree of every conversation the caller may see. So an empty page asks nothing at all. */
  it('narrows the branch read to the page and asks nothing while no page is on screen', async () => {
    renderPanel();
    await screen.findByText('First');

    await waitFor(() => expect(client.brainConversationLinks).toHaveBeenCalledWith('mine', ['s1', 's2']));
    for (const call of client.brainConversationLinks.mock.calls) expect(call).toEqual(['mine', ['s1', 's2']]);
  });

  it('asks nothing at all when the caller has no conversation', async () => {
    ctrl.value.sessions.data = [];
    renderPanel();
    await screen.findByText('No conversations yet');

    expect(client.brainConversationLinks).not.toHaveBeenCalled();
  });
});

/** The incident: an open row menu was painted OVER by the conversation rows below it, straight across
 *  Rename, Branch, Export and Delete — every action those rows reach only through that menu.
 *
 *  The panel carries `overlay-layer-menu`, the app's menu z-index band, and that was never the problem.
 *  Its ANCHOR was: a transform CREATES A STACKING CONTEXT, and inside one the panel's z-index can only
 *  rank against its own siblings — the subtree then ranks as the anchor does, a positioned element with
 *  z-index auto, painted in tree order, so every later row won.
 *
 *  jsdom paints nothing, so what is pinned here is that cause: no element between the open panel and its
 *  row may create a stacking context. The paint order itself is verified in a real browser. */
describe('ConversationHistoryPanel row menu — overlay stacking', () => {
  // Tailwind utilities that create a stacking context and would trap the panel's layer again.
  const TRAPS = /^(transform|transform-gpu|isolate|filter|opacity-\d|mix-blend-|backdrop-|will-change-|blur-|-?(translate|scale|rotate|skew)-)/;

  it('holds the action menu in an anchor that creates no stacking context', async () => {
    renderPanel();
    openRowMenu(0);
    const panel = await screen.findByRole('menu');
    expect(panel).toHaveClass('overlay-layer-menu');

    const row = panel.closest('[role="row"]');
    expect(row).not.toBeNull();
    const trapped: string[] = [];
    for (let node = panel.parentElement; node && node !== row; node = node.parentElement) {
      for (const token of node.className.toString().split(/\s+/).filter(Boolean)) {
        if (TRAPS.test(token)) trapped.push(token);
      }
    }
    expect(trapped).toEqual([]);
  });
});
