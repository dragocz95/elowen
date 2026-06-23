import { describe, it, expect, vi } from 'vitest';
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

function fakeDock(over: Partial<UseDockState['state']> = {}): UseDockState {
  return {
    state: { open: true, side: 'right', width: 560, panes: [{ id: 'advisor', kind: 'advisor' }], sizes: [1], ...over },
    setOpen: vi.fn(),
    setSide: vi.fn(),
    setWidth: vi.fn(),
    setSizes: vi.fn(),
    addSessionPane: vi.fn(),
    removePane: vi.fn(),
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

  it('toggles the dock side', () => {
    const dock = fakeDock({ side: 'right' });
    renderPanel(dock);
    fireEvent.click(screen.getByRole('button', { name: /dock left|ukotvit vlevo/i }));
    expect(dock.setSide).toHaveBeenCalledWith('left');
  });
});
