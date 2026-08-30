import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { ChatHistoryRail } from '../../../modules/advisor/ChatHistoryRail';

// The rail reads the ONE controller (BrainChatProvider) and the client directly (search/rename/export,
// mirroring Fáze 1); delete stays on the controller. We stub both so the test asserts the exact wiring.
const ctrl = vi.hoisted(() => {
  const switchSession = vi.fn(() => Promise.resolve());
  const deleteSession = vi.fn(() => Promise.resolve());
  return {
    switchSession,
    deleteSession,
    value: {
      sessions: { data: [
        { id: 's1', title: 'First', model: 'gpt', active: true },
        { id: 's2', title: 'Second', model: 'sonnet', active: false },
      ] },
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
}));

vi.mock('../../../modules/advisor/BrainChatProvider', () => ({ useBrainChat: () => ctrl.value }));
vi.mock('../../../lib/elowenClient', () => ({ elowenClient: client }));

function renderRail(variant: 'rail' | 'drawer' | 'dropdown') {
  const { wrapper: Wrapper, client: qc } = createWrapper();
  const utils = render(<Wrapper><ToastProvider><ChatHistoryRail variant={variant} open /></ToastProvider></Wrapper>);
  return { ...utils, qc };
}

const openRowMenu = (rowIndex: number) => {
  fireEvent.click(screen.getAllByRole('button', { name: /More actions|Další akce/i })[rowIndex]!);
};

beforeEach(() => { ctrl.switchSession.mockClear(); ctrl.deleteSession.mockClear(); client.brainSearch.mockClear(); client.brainRenameSession.mockClear(); client.brainExportSession.mockClear(); client.brainForkSession.mockClear(); });

describe('ChatHistoryRail', () => {
  it('lists the conversations off the shared controller', () => {
    renderRail('rail');
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('mounts from the same component in all three variants', () => {
    for (const variant of ['rail', 'drawer', 'dropdown'] as const) {
      const { unmount } = renderRail(variant);
      expect(screen.getByText('First')).toBeInTheDocument();
      unmount();
    }
  });

  it('uses the shared Radix action-menu keyboard contract and returns focus on Escape', async () => {
    renderRail('rail');
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
    renderRail('rail');
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
    const { rerender } = render(<Wrapper><ToastProvider><ChatHistoryRail variant="drawer" open /></ToastProvider></Wrapper>);
    expect(screen.queryByRole('link', { name: linkName })).not.toBeInTheDocument();
    rerender(<Wrapper><ToastProvider><ChatHistoryRail variant="drawer" open homeLink /></ToastProvider></Wrapper>);
    expect(screen.getByRole('link', { name: linkName })).toHaveAttribute('href', '/dash');
  });

  it('starts a new conversation via switchSession({ fresh: true })', () => {
    renderRail('rail');
    fireEvent.click(screen.getByRole('button', { name: /New chat|Nová konverzace/i }));
    expect(ctrl.switchSession).toHaveBeenCalledWith({ fresh: true });
  });

  it('switches to a picked conversation via switchSession({ session })', () => {
    renderRail('rail');
    fireEvent.click(screen.getByText('Second'));
    expect(ctrl.switchSession).toHaveBeenCalledWith({ session: 's2' });
  });

  it('confirms the concrete delete consequence before calling the controller', async () => {
    renderRail('rail');
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
    renderRail('rail');
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete conversation|Smazat konverzaci/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Delete conversation|Smazat konverzaci/i }));

    await waitFor(() => expect(ctrl.deleteSession).toHaveBeenCalledWith('s1', true));
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog', { name: /Delete this conversation|Smazat tuto konverzaci/i })).toBeInTheDocument();
  });

  it('deduplicates a pending delete and ignores its stale completion after a newer dialog opens', async () => {
    let resolveDelete!: () => void;
    ctrl.deleteSession.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    renderRail('rail');

    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete conversation|Smazat konverzaci/i }));
    const firstDialog = await screen.findByRole('alertdialog', { name: /Delete this conversation|Smazat tuto konverzaci/i });
    const confirm = within(firstDialog).getByRole('button', { name: /Delete conversation|Smazat konverzaci/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(ctrl.deleteSession).toHaveBeenCalledTimes(1);

    fireEvent.click(within(firstDialog).getByRole('button', { name: /Cancel|Zrušit/i }));
    openRowMenu(1);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete conversation|Smazat konverzaci/i }));
    const newerDialog = await screen.findByRole('alertdialog', { name: /Delete this conversation|Smazat tuto konverzaci/i });
    expect(newerDialog).toHaveTextContent('Second');

    resolveDelete();
    await waitFor(() => expect(screen.getByRole('alertdialog', { name: /Delete this conversation|Smazat tuto konverzaci/i })).toHaveTextContent('Second'));
  });

  it('renames via brainRenameSession then invalidates the sessions query', async () => {
    const { qc } = renderRail('rail');
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

  it('cancels a rename on Escape without committing', () => {
    renderRail('rail');
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Rename$|^Přejmenovat$/i }));
    const input = screen.getByRole('textbox', { name: /Conversation title|Název konverzace/i });
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(client.brainRenameSession).not.toHaveBeenCalled();
    expect(screen.getByText('First')).toBeInTheDocument();
  });

  it('exports a conversation as HTML and as JSONL', () => {
    renderRail('rail');
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /Export as HTML|Exportovat jako HTML/i }));
    expect(client.brainExportSession).toHaveBeenCalledWith('s1', 'html');
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /Export as JSONL|Exportovat jako JSONL/i }));
    expect(client.brainExportSession).toHaveBeenCalledWith('s1', 'jsonl');
  });

  it('branches a conversation and opens the copy, leaving the source selected until then', async () => {
    renderRail('rail');
    openRowMenu(0);
    fireEvent.click(screen.getByRole('menuitem', { name: /Branch conversation|Větvit konverzaci|Vetviť konverzáciu/i }));
    await waitFor(() => expect(client.brainForkSession).toHaveBeenCalledWith('s1'));
    // The user lands in the NEW conversation — never back in the one they branched off.
    await waitFor(() => expect(ctrl.switchSession).toHaveBeenCalledWith({ session: 's1-fork' }));
  });

  // The drawer is the one variant that is a dialog, and it used to answer Escape from a React handler on
  // its own layer — which reached it only because the search field happened to hold focus. Both halves
  // are the primitive's now, so both are pinned: the field still takes focus on open, and Escape closes
  // the drawer from anywhere inside it.
  it('opens the drawer with focus in the search field and closes it on Escape', async () => {
    const onClose = vi.fn();
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ChatHistoryRail variant="drawer" open onClose={onClose} /></ToastProvider></Wrapper>);

    const search = screen.getByRole('textbox', { name: /Search conversations|Hledat v konverzacích/i });
    expect(search).toHaveFocus();

    fireEvent.keyDown(search, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('runs a fulltext search (≥2 chars) and highlights the match', async () => {
    renderRail('rail');
    fireEvent.change(screen.getByRole('textbox', { name: /Search conversations|Hledat v konverzacích/i }), { target: { value: 'he' } });
    await waitFor(() => expect(client.brainSearch).toHaveBeenCalledWith('he'));
    expect(await screen.findByText('Hit session')).toBeInTheDocument();
    const mark = document.querySelector('mark');
    expect(mark?.textContent).toBe('he');
  });
});
