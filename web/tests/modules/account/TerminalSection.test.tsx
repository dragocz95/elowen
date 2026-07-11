import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { DARK_PALETTE } from '../../../components/terminal/palettes';
import type { TerminalSettings } from '../../../lib/types';

// xterm never renders under jsdom — stub it for the live preview (mirrors the terminal component tests).
vi.mock('@xterm/xterm', () => ({
  Terminal: class { open = vi.fn(); write = vi.fn(); clear = vi.fn(); reset = vi.fn(); dispose = vi.fn(); loadAddon = vi.fn(); options: Record<string, unknown> = {}; },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const mutate = vi.fn();
vi.mock('../../../lib/mutations', () => ({ useSaveMyTerminalSettings: () => ({ mutate, mutateAsync: mutate }) }));

const SEED: TerminalSettings = { fontSize: 16, fontFamily: 'menlo', cursorStyle: 'bar', cursorBlink: false, scrollback: 2000, theme: 'auto', palette: DARK_PALETTE };
vi.mock('../../../lib/queries', () => ({ useMyTerminalSettings: () => ({ data: SEED, isLoading: false }) }));

import { TerminalSection } from '../../../modules/account/TerminalSection';

const renderSection = () => render(<ToastProvider><TerminalSection /></ToastProvider>, { wrapper: createWrapper().wrapper });
const colorInputs = (c: HTMLElement) => c.querySelectorAll('input[type="color"]');

beforeEach(() => mutate.mockClear());

describe('TerminalSection', () => {
  it('seeds the form from the query and hides the palette while theme is auto', () => {
    const { container } = renderSection();
    expect(screen.getByText('16px')).toBeTruthy();              // fontSize seeded
    expect(colorInputs(container).length).toBe(0);              // theme:'auto' → no swatches
  });

  it('reveals the full 21-colour palette + presets when switching to Custom', () => {
    const { container } = renderSection();
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(colorInputs(container).length).toBe(21);
    expect(screen.getByText('Dracula')).toBeTruthy();           // a preset option
  });

  it('autosaves the patched fields after a change', async () => {
    renderSection();
    fireEvent.change(screen.getAllByRole('slider')[0]!, { target: { value: '18' } }); // fontSize slider
    await waitFor(() => expect(mutate).toHaveBeenCalled(), { timeout: 1500 });
    expect((mutate.mock.calls[0]![0] as TerminalSettings).fontSize).toBe(18);
  });
});
