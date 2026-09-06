import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import type { BrainActivityView } from '../../../lib/types';
import { ConversationHistoryPanel } from '../../../modules/advisor/ConversationHistoryPanel';

type TestSession = {
  id: string;
  title: string;
  provider?: string;
  model: string;
  active: boolean;
  activity?: BrainActivityView;
};

// The rail reads the ONE controller (BrainChatProvider) and the client directly (search/rename/export,
// mirroring Fáze 1); delete stays on the controller. We stub both so the test asserts the exact wiring.
const ctrl = vi.hoisted(() => {
  const switchSession = vi.fn(() => Promise.resolve());
  const deleteSession = vi.fn(() => Promise.resolve());
  const data: TestSession[] = [
    { id: 's1', title: 'First', provider: 'chatgpt-account', model: 'openai/gpt-5.6-sol', active: true },
    { id: 's2', title: 'Second', model: 'sonnet', active: false },
  ];
  return {
    switchSession,
    deleteSession,
    value: {
      sessions: { data },
      switchSession,
      deleteSession,
    },
  };
});
const client = vi.hoisted(() => ({
  brainSearch: vi.fn(() => Promise.resolve([{ sessionId: 's9', sessionTitle: 'Hit session', role: 'user', snippet: 'hello world', ts: '2026-07-08T00:00:00Z' }])),
  brainRenameSession: vi.fn(() => Promise.resolve({ id: 's1', title: 'Renamed' })),
  brainExportSession: vi.fn(() => Promise.resolve()),
  brainForkSession: vi.fn(() => Promise.resolve({ id: 's1-fork', title: 'First', forkedFrom: 's1' })),
  brainConversationLinks: vi.fn(() => Promise.resolve({ status: 'available', links: [] as Record<string, unknown>[] })),
}));

vi.mock('../../../modules/advisor/BrainChatProvider', () => ({ useBrainChat: () => ctrl.value }));
vi.mock('../../../lib/elowenClient', () => ({ elowenClient: client }));

/** The panel as its only host renders it: bare inside the shared switcher modal. The surface, Escape, the
 *  focus trap and dismissal belong to that modal now and are pinned in its own test — what is pinned here
 *  is the list itself, which is the part that used to be duplicated across three presentations. */
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

beforeEach(() => {
  ctrl.value.sessions.data = [
    { id: 's1', title: 'First', provider: 'chatgpt-account', model: 'openai/gpt-5.6-sol', active: true },
    { id: 's2', title: 'Second', model: 'sonnet', active: false },
  ];
  ctrl.switchSession.mockClear();
  ctrl.deleteSession.mockClear();
  client.brainSearch.mockClear();
  client.brainRenameSession.mockClear();
  client.brainExportSession.mockClear();
  client.brainForkSession.mockClear();
  client.brainConversationLinks.mockClear();
  client.brainConversationLinks.mockResolvedValue({ status: 'available', links: [] });
});

describe('ConversationHistoryPanel', () => {
  it('lists conversations with the bare structured model name', () => {
    renderPanel();
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    const model = screen.getByText('openai/gpt-5.6-sol');
    expect(model).toHaveAttribute('title', 'chatgpt-account/openai/gpt-5.6-sol');
    expect(screen.queryByText('chatgpt-account/openai/gpt-5.6-sol')).toBeNull();
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

  it('starts a new conversation via switchSession({ fresh: true })', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /New chat|Nová konverzace/i }));
    expect(ctrl.switchSession).toHaveBeenCalledWith({ fresh: true });
  });

  it('switches to a picked conversation via switchSession({ session })', () => {
    renderPanel();
    fireEvent.click(screen.getByText('Second'));
    expect(ctrl.switchSession).toHaveBeenCalledWith({ session: 's2' });
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
    renderPanel();
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /Branch conversation|Větvit konverzaci|Vetviť konverzáciu/i }));
    await waitFor(() => expect(client.brainForkSession).toHaveBeenCalledWith('s1'));
    // The user lands in the NEW conversation — never back in the one they branched off.
    await waitFor(() => expect(ctrl.switchSession).toHaveBeenCalledWith({ session: 's1-fork' }));
  });

  it('runs a fulltext search (≥2 chars) and highlights the match', async () => {
    renderPanel();
    fireEvent.change(screen.getByRole('textbox', { name: /Search conversations|Hledat v konverzacích/i }), { target: { value: 'he' } });
    await waitFor(() => expect(client.brainSearch).toHaveBeenCalledWith('he'));
    expect(await screen.findByText('Hit session')).toBeInTheDocument();
    const mark = document.querySelector('mark');
    expect(mark?.textContent).toBe('he');
  });

  it('carries the conversation activity state into search-result rows', async () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'done', seq: 8, at: null, detail: 'Finished', unread: true };
    client.brainSearch.mockResolvedValueOnce([{ sessionId: 's1', sessionTitle: 'First', role: 'assistant', snippet: 'hello', ts: '2026-07-08T00:00:00Z' }]);
    renderPanel();
    fireEvent.change(screen.getByRole('textbox', { name: /Search conversations|Hledat v konverzacích/i }), { target: { value: 'he' } });
    const result = await screen.findByText('First');
    expect(result).toHaveClass('font-semibold');
    expect(result.closest('button')).toHaveAttribute('aria-current', 'page');
    expect(result.closest('li')?.querySelector('[data-slot="sidebar-menu-badge"]')).toHaveAttribute('aria-hidden', 'true');
    expect(result.closest('li')?.querySelector('[data-activity-state]')).toHaveAttribute('data-activity-state', 'done');
  });

  it('uses the real shadcn menu anatomy for regular and search-result rows', async () => {
    renderPanel();
    expect(screen.getByRole('textbox', { name: /Search conversations|Hledat v konverzacích/i })).toHaveAttribute('data-slot', 'input');
    const menu = document.querySelector('[data-slot="sidebar-menu"]')!;
    expect(menu).toHaveAttribute('data-slot', 'sidebar-menu');
    const item = within(menu as HTMLElement).getAllByRole('listitem')[0]!;
    expect(item).toHaveAttribute('data-slot', 'sidebar-menu-item');
    expect(item.querySelector('[data-slot="sidebar-menu-button"]')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: /Search conversations|Hledat v konverzacích/i }), { target: { value: 'he' } });
    expect(await screen.findByText('Hit session')).toBeInTheDocument();
    const searchMenu = document.querySelector('[data-slot="sidebar-menu"]')!;
    expect(searchMenu).toHaveAttribute('data-slot', 'sidebar-menu');
    expect(within(searchMenu as HTMLElement).getAllByRole('listitem')[0]).toHaveAttribute('data-slot', 'sidebar-menu-item');
  });

  it('renders neutral activity without inventing a state icon', () => {
    renderPanel();
    const state = screen.getByText('First').closest('li')!.querySelector('[data-activity-state]')!;
    expect(state).toHaveAttribute('data-activity-state', 'idle');
    expect(state.querySelector('svg')).toBeNull();
    expect(state.querySelectorAll('.sr-only')).toHaveLength(1);
  });

  it('renders working activity as a reduced-motion-safe green pulse', () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'working', seq: 3, at: null, detail: 'Running', unread: false };
    renderPanel();
    const state = screen.getByText('First').closest('li')!.querySelector('[data-activity-state]')!;
    const icon = state.querySelector('svg')!;
    expect(state).toHaveAttribute('data-activity-state', 'working');
    expect(icon).toHaveAttribute('width', '8');
    expect(icon).toHaveClass('animate-pulse', 'fill-success', 'text-success', 'motion-reduce:animate-none');
    expect(within(state as HTMLElement).getByText('Working')).toBeInTheDocument();
  });

  it('keeps a read done check and does not render an unread badge', () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'done', seq: 4, at: null, detail: 'Finished', unread: false };
    renderPanel();
    const row = screen.getByText('First').closest('li')!;
    const state = row.querySelector('[data-activity-state]')!;
    expect(state).toHaveAttribute('data-activity-state', 'done');
    expect(state.querySelector('svg')).toHaveClass('text-success');
    expect(row.querySelector('[data-slot="sidebar-menu-badge"]')).toBeNull();
  });

  it('renders a done unread result with a semibold title and an independent accent badge', () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'done', seq: 5, at: null, detail: 'Finished', unread: true };
    renderPanel();
    const row = screen.getByText('First').closest('li')!;
    expect(screen.getByText('First')).toHaveClass('font-semibold');
    const badge = row.querySelector('[data-slot="sidebar-menu-badge"]')!;
    expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(badge).toHaveAttribute('data-unread', 'true');
    expect(badge).toHaveClass('bg-primary', 'rounded-full');
    expect(within(row).getByText('Completed, Unread result')).toBeInTheDocument();
    expect(row.querySelectorAll('.sr-only')).toHaveLength(1);
  });

  // The tip describes the ROW and hangs off it. Nothing inside the row's <button> may own it: a nested
  // tab stop is invalid there and announces nothing, the row's own onClick would eat the tap meant to
  // reveal the tip, and the floating panel is content no button is allowed to contain.
  it('exposes a bounded failed tooltip from the row itself, with no control nested in the row button', async () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'failed', seq: 6, at: null, detail: 'The provider rejected the request.', unread: false };
    renderPanel();
    const row = screen.getByText('First').closest('li')!;
    const rowButton = screen.getByText('First').closest('button')!;
    expect(rowButton.querySelector('[tabindex="0"]')).toBeNull();
    expect(rowButton.querySelector('[role="tooltip"]')).toBeNull();
    expect(rowButton.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    // The dot is the anchor and nothing more: it positions the tip and stays out of the tab order.
    const anchor = row.querySelector('[data-slot="tooltip-anchor"]')!;
    expect(anchor).toBeTruthy();
    expect(anchor.getAttribute('tabindex')).toBeNull();

    fireEvent.focus(rowButton);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveClass('w-64');
    expect(tip).toHaveTextContent('The provider rejected the request.');
    expect(rowButton).toHaveAttribute('aria-describedby', tip.id);
    expect(row.querySelector('[data-slot="sidebar-menu-badge"]')).toBeNull();

    fireEvent.blur(rowButton);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(rowButton).not.toHaveAttribute('aria-describedby');
  });

  it('opens the same failure tip from row hover', async () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'failed', seq: 6, at: null, detail: 'Connection refused.', unread: false };
    renderPanel();
    const rowButton = screen.getByText('First').closest('button')!;

    fireEvent.mouseEnter(rowButton);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Connection refused.');
    fireEvent.mouseLeave(rowButton);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  // A row whose run did not fail carries no tip at all — no anchor, no panel, nothing describing it.
  it('adds no tooltip wiring to a row that did not fail', () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'done', seq: 6, at: null, detail: 'Finished', unread: false };
    renderPanel();
    const row = screen.getByText('First').closest('li')!;
    const rowButton = screen.getByText('First').closest('button')!;
    expect(row.querySelector('[data-slot="tooltip-anchor"]')).toBeNull();
    expect(rowButton).not.toHaveAttribute('aria-describedby');
    fireEvent.focus(rowButton);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps failed unread state independent from the destructive tooltip', () => {
    ctrl.value.sessions.data[0]!.activity = { state: 'failed', seq: 7, at: null, detail: 'Failed to connect.', unread: true };
    renderPanel();
    const row = screen.getByText('First').closest('li')!;
    const state = row.querySelector('[data-activity-state]')!;
    expect(state.querySelector('svg')).toHaveClass('fill-destructive', 'text-destructive');
    expect(row.querySelector('[data-slot="sidebar-menu-badge"]')).toHaveAttribute('aria-hidden', 'true');
    expect(within(row).getByText('Run failed, Unread result')).toBeInTheDocument();
  });

  it('keeps active selection, page current state, action keyboard access and touch-visible actions', async () => {
    renderPanel();
    const first = screen.getByText('First').closest('button')!;
    expect(first).toHaveAttribute('aria-current', 'page');
    expect(first).toHaveAttribute('data-active', 'true');
    expect(first).toHaveClass('data-[active=true]:bg-sidebar-accent', 'data-[active=true]:text-sidebar-accent-foreground');
    const trigger = screen.getAllByRole('button', { name: /More actions|Další akce/i })[0]!;
    expect(trigger).toHaveClass('overlay-touch-target', 'pointer-coarse:opacity-100');
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /^Rename$|^Přejmenovat$/i })).toHaveFocus());
  });
});

/** The recurring jobs filed under a conversation, as a collapsed branch under its row. Navigation only:
 *  a job row opens the schedule's own editor and nothing about the schedule changes. */
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
    // Radix names the content the trigger controls, so the disclosure announces itself properly.
    expect(trigger).toHaveAttribute('aria-controls');
  });

  it('separates the disclosure from opening the conversation', async () => {
    withLinks(digest);
    renderPanel();
    fireEvent.click(await branch());
    expect(ctrl.switchSession).not.toHaveBeenCalled();
    // The trigger is a sibling of the row button, never nested inside it.
    expect(screen.getByText('First').closest('button')!.querySelector('[data-slot="collapsible-trigger"]')).toBeNull();
  });

  // Opening a schedule leaves the app on the cron editor, so the switcher covering it has to go — the
  // panel says so once, through the host's callback, and never dismisses anything itself.
  it('tells its host to close when a schedule is opened', async () => {
    withLinks(digest);
    const onNavigate = vi.fn();
    renderPanel({ onNavigate });
    fireEvent.click(await branch());
    fireEvent.click(await screen.findByRole('link', { name: /Nightly digest/ }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('adds job matches to the search without losing the transcript snippets', async () => {
    withLinks(digest, report);
    client.brainSearch.mockResolvedValueOnce([
      { sessionId: 's1', sessionTitle: 'First', role: 'user', snippet: 'a digest of the day', ts: '2026-07-08T00:00:00Z' },
      { sessionId: 's1', sessionTitle: 'First', role: 'assistant', snippet: 'the digest again', ts: '2026-07-08T01:00:00Z' },
    ]);
    renderPanel();
    fireEvent.change(screen.getByRole('textbox', { name: /Search conversations|Hledat v konverzacích/i }), { target: { value: 'digest' } });

    // The snippets survive, highlight and all — the match itself sits in its own <mark>, so the
    // surrounding text is what identifies each row.
    expect(await screen.findByText(/of the day/)).toBeInTheDocument();
    expect(screen.getByText(/again/)).toBeInTheDocument();
    expect(document.querySelectorAll('mark')).toHaveLength(2);
    // The schedule is offered once, under its conversation, however many snippets matched.
    const jobRows = await screen.findAllByRole('link', { name: /Open the schedule/ });
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toHaveAttribute('href', '/p/cronjob?job=job-1');
    expect(screen.queryByText('Weekly report')).toBeNull();
  });

  it('never lists a conversation the sidebar does not hold', async () => {
    // A direct platform chat is an eligible cron target but is NOT in the personal conversation list.
    withLinks({ ...digest, conversationId: 'brain-ch-telegram-42', name: 'Channel digest' });
    renderPanel();
    await screen.findByText('First');
    expect(screen.queryByText('Channel digest')).toBeNull();
    expect(screen.queryByRole('button', { name: /Scheduled jobs of/ })).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: /Search conversations|Hledat v konverzacích/i }), { target: { value: 'digest' } });
    await screen.findByText('Hit session');
    expect(screen.queryByText('Channel digest')).toBeNull();
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

/** The incident: an open row menu was painted OVER by the conversation rows below it, straight across
 *  Rename, Branch, Export and Delete — every action those rows reach only through that menu.
 *
 *  The panel carries `overlay-layer-menu`, the app's menu z-index band, and that was never the problem.
 *  Its ANCHOR was: the action button sat in an absolutely positioned box centred with `top-1/2
 *  -translate-y-1/2`, and a transform CREATES A STACKING CONTEXT. Inside one, the panel's z-index can
 *  only rank against its own siblings — the subtree then ranks as the anchor does, a positioned element
 *  with z-index auto, painted in tree order, so every later row won. Raising the panel's z-index changed
 *  nothing, which is what makes this a stacking-context bug rather than a layer-value one.
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

    const row = panel.closest('[data-slot="sidebar-menu-item"]');
    expect(row).not.toBeNull();
    const trapped: string[] = [];
    for (let node = panel.parentElement; node && node !== row; node = node.parentElement) {
      for (const token of node.className.toString().split(/\s+/).filter(Boolean)) {
        if (TRAPS.test(token)) trapped.push(token);
      }
    }
    expect(trapped).toEqual([]);
  });

  it('centres the action button on the row without a transform', () => {
    renderPanel();
    const anchor = screen.getAllByRole('button', { name: /More actions|Další akce/i })[0]!.closest('.absolute')!;
    expect(anchor).toHaveClass('inset-y-0', 'right-1', 'flex', 'items-center');
    expect(anchor.className).not.toMatch(/translate|top-1\/2/);
  });
});
