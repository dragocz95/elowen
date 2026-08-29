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

const SEED: TerminalSettings = { fontSize: 16, fontFamily: 'menlo', cursorStyle: 'bar', cursorBlink: false, scrollback: 2000, theme: 'auto', palette: DARK_PALETTE, promptHistoryDepth: 250, interruptConfirmMs: 2500 };
const state = vi.hoisted(() => ({ error: false }));
const mocks = vi.hoisted(() => ({ refetch: vi.fn() }));
vi.mock('../../../lib/queries', () => ({ useMyTerminalSettings: () => (state.error ? { data: undefined, isLoading: false, isError: true, refetch: mocks.refetch } : { data: SEED, isLoading: false, isError: false }) }));

import { TerminalSection } from '../../../modules/account/TerminalSection';
import { first } from '../../first.js';

const renderSection = () => render(<ToastProvider><TerminalSection /></ToastProvider>, { wrapper: createWrapper().wrapper });
const colorInputs = (c: HTMLElement) => c.querySelectorAll('input[type="color"]');

beforeEach(() => { mutate.mockClear(); state.error = false; mocks.refetch.mockClear(); });

describe('TerminalSection — error state', () => {
  it('shows a retryable error instead of a permanent skeleton', () => {
    state.error = true;
    renderSection();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Colors' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});

describe('TerminalSection', () => {
  it('seeds the form from the query and hides the palette while theme is auto', () => {
    const { container } = renderSection();
    expect(screen.getByText('16px')).toBeTruthy();              // fontSize seeded
    expect(colorInputs(container).length).toBe(0);              // theme:'auto' → no swatches
  });

  it('reveals the full 21-colour palette + presets when switching to Custom in the drawer', () => {
    renderSection();
    // The colors editor lives in the side drawer behind the row's manage button (portalled to body).
    fireEvent.click(screen.getByRole('button', { name: 'Colors' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(colorInputs(document.body).length).toBe(21);
    // The preset picker is a SelectMenu, not a native select: its options only exist in the DOM while
    // the listbox is open, so the menu has to be opened before one can be asserted.
    fireEvent.click(screen.getByRole('combobox', { name: 'Load preset' }));
    expect(screen.getByRole('option', { name: 'Dracula' })).toBeTruthy();
  });

  it('keeps the preview and palette shrinkable inside the drawer', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Colors' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));

    expect(screen.getByTestId('terminal-colors-layout')).toHaveClass('min-w-0', 'grid-cols-[minmax(0,1fr)]');
    expect(screen.getByTestId('terminal-preview')).toHaveClass('min-w-0', 'max-w-full');
    expect(document.body.querySelector('[data-terminal-palette]')).toHaveClass('grid-cols-2', '@sm:grid-cols-3', '@md:grid-cols-4');
  });

  it('autosaves the patched fields after a change', async () => {
    renderSection();
    const fontSize = first(screen.getAllByRole('slider'), 'slider');
    fireEvent.keyDown(fontSize, { key: 'ArrowRight' });
    fireEvent.keyDown(fontSize, { key: 'ArrowRight' });
    await waitFor(() => expect(mutate).toHaveBeenCalled(), { timeout: 1500 });
    expect((first(mutate.mock.calls, 'save call')[0] as TerminalSettings).fontSize).toBe(18);
  });

  // The two CLI chat knobs must SEED from the stored settings: were the form to keep its built-in
  // defaults, the next unrelated autosave would write them back over whatever the user had chosen.
  it('seeds the CLI chat knobs from the stored settings and carries them through a save', async () => {
    renderSection();
    const depth = screen.getByRole('slider', { name: 'Prompt history' });
    const window = screen.getByRole('slider', { name: 'Double Esc window' });
    expect(depth).toHaveAttribute('aria-valuenow', '250');
    expect(window).toHaveAttribute('aria-valuenow', '2.5'); // stored in milliseconds, edited in seconds
    expect(screen.getByText('250 lines')).toBeTruthy();
    expect(screen.getByText('2.5 s')).toBeTruthy();

    fireEvent.keyDown(depth, { key: 'ArrowRight' });
    await waitFor(() => expect(mutate).toHaveBeenCalled(), { timeout: 1500 });
    const saved = first(mutate.mock.calls, 'save call')[0] as TerminalSettings;
    expect(saved.promptHistoryDepth).toBe(260);
    expect(saved.interruptConfirmMs).toBe(2500); // the untouched sibling travels at its stored value
  });
});
