import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

beforeEach(() => { ctrl.switchSession.mockClear(); ctrl.deleteSession.mockClear(); client.brainSearch.mockClear(); client.brainRenameSession.mockClear(); client.brainExportSession.mockClear(); });

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

  it('deletes a conversation through the controller (id + active flag)', () => {
    renderRail('rail');
    openRowMenu(1); // the second, non-active row
    fireEvent.click(screen.getByRole('button', { name: /Delete conversation|Smazat konverzaci/i }));
    expect(ctrl.deleteSession).toHaveBeenCalledWith('s2', false);
  });

  it('renames via brainRenameSession then invalidates the sessions query', async () => {
    const { qc } = renderRail('rail');
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    openRowMenu(0);
    fireEvent.click(screen.getByRole('button', { name: /^Rename$|^Přejmenovat$/i }));
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
    fireEvent.click(screen.getByRole('button', { name: /^Rename$|^Přejmenovat$/i }));
    const input = screen.getByRole('textbox', { name: /Conversation title|Název konverzace/i });
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(client.brainRenameSession).not.toHaveBeenCalled();
    expect(screen.getByText('First')).toBeInTheDocument();
  });

  it('exports a conversation as HTML and as JSONL', () => {
    renderRail('rail');
    openRowMenu(0);
    fireEvent.click(screen.getByRole('button', { name: /Export as HTML|Exportovat jako HTML/i }));
    expect(client.brainExportSession).toHaveBeenCalledWith('s1', 'html');
    openRowMenu(0);
    fireEvent.click(screen.getByRole('button', { name: /Export as JSONL|Exportovat jako JSONL/i }));
    expect(client.brainExportSession).toHaveBeenCalledWith('s1', 'jsonl');
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
