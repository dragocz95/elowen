import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { AdvisorPanel } from '../../../modules/advisor/AdvisorPanel';
import type { UseDockState } from '../../../lib/useDockState';

vi.mock('../../../modules/advisor/AdvisorPane', () => ({
  AdvisorPane: ({ pane }: { pane: { id: string } }) => <div data-testid="pane">{pane.id}</div>,
}));
vi.mock('../../../modules/advisor/SessionPicker', () => ({
  SessionPicker: ({ open }: { open: boolean }) => (open ? <div data-testid="picker" /> : null),
}));
vi.mock('../../../modules/advisor/BrainChat', () => ({ BrainChat: () => <div data-testid="brain-chat" /> }));
// The dock defaults to chat mode; these pane-stack tests exercise the terminal mode.
beforeEach(() => localStorage.setItem('orca.dock.mode', 'terminal'));

function fakeDock(over: Partial<UseDockState['state']> = {}): UseDockState {
  return {
    state: { open: true, side: 'right', width: 560, height: 420, advisor: true, panes: [{ id: 'advisor', kind: 'advisor' }], sizes: [1], ...over },
    setOpen: vi.fn(),
    setSide: vi.fn(),
    setWidth: vi.fn(),
    setHeight: vi.fn(),
    setSizes: vi.fn(),
    addSessionPane: vi.fn(),
    removePane: vi.fn(),
    addAdvisorPane: vi.fn(),
  };
}

const renderPanel = (dock: UseDockState) =>
  render(<LanguageProvider><AdvisorPanel dock={dock} /></LanguageProvider>);

describe('AdvisorPanel', () => {
  it('renders a pane per dock pane', () => {
    renderPanel(fakeDock());
    expect(screen.getByTestId('pane').textContent).toBe('advisor');
  });

  it('closes the panel via the close button', () => {
    const dock = fakeDock();
    renderPanel(dock);
    fireEvent.click(screen.getByRole('button', { name: /^close$|^zavřít$/i }));
    expect(dock.setOpen).toHaveBeenCalledWith(false);
  });

  it('offers all four dock positions from the position menu', () => {
    const dock = fakeDock({ side: 'right' });
    renderPanel(dock);
    fireEvent.click(screen.getByRole('button', { name: /dock position|pozice panelu/i }));
    fireEvent.click(screen.getByRole('button', { name: /dock to bottom|ukotvit dolů/i }));
    expect(dock.setSide).toHaveBeenCalledWith('bottom');
  });
});
