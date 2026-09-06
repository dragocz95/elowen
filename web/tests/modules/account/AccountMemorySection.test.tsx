import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { CliSettings } from '../../../lib/types';

const mutate = vi.fn();
vi.mock('../../../lib/mutations', () => ({ useSaveMyCliSettings: () => ({ mutate, mutateAsync: mutate }) }));

const SEED: CliSettings = {
  model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '',
  autoCompact: false, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '',
  autoRecall: true, autoLiveRecall: true, autoSave: true,
};
const state = vi.hoisted(() => ({ error: false }));
const mocks = vi.hoisted(() => ({ refetch: vi.fn() }));
vi.mock('../../../lib/queries', () => ({
  useMyCliSettings: () => (state.error ? { data: undefined, isLoading: false, isError: true, refetch: mocks.refetch } : { data: SEED, isLoading: false, isError: false }),
}));

import { AccountMemorySection } from '../../../modules/account/AccountMemorySection';

const renderSection = () => render(<ToastProvider><AccountMemorySection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => { mutate.mockClear(); state.error = false; mocks.refetch.mockClear(); });

describe('AccountMemorySection — error state', () => {
  it('shows a retryable error instead of a permanent skeleton', () => {
    state.error = true;
    renderSection();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});

describe('AccountMemorySection', () => {
  it('seeds the toggles and autosaves a change', async () => {
    renderSection();
    const toggle = screen.getAllByRole('switch')[0];
    if (!toggle) throw new Error('no toggle rendered');
    fireEvent.click(toggle);
    await waitFor(() => expect(mutate).toHaveBeenCalled(), { timeout: 1500 });
  });

  it('offers recall-while-working as its own switch and saves it independently', async () => {
    renderSection();
    // Three switches now: recall at turn start, recall while working, and auto-save. The middle one is
    // the new one, and turning it off must not disturb the other two — an operator who wants the agent
    // undisturbed mid-turn should not lose ordinary recall as a side effect.
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(3);

    const live = switches[1];
    if (!live) throw new Error('the live-recall switch is missing');
    fireEvent.click(live);

    await waitFor(() => expect(mutate).toHaveBeenCalled(), { timeout: 1500 });
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
      autoLiveRecall: false, autoRecall: true, autoSave: true,
    }));
  });

  /** THE SWITCH STANDS ALONE. Each record used to print its sentence again beside the switch, which is a
   *  third copy of what the title and the help mark already say — and, because it sat inside the control
   *  slot, it pushed every switch out of the column the trailing band puts them in. The sentence survives
   *  as the switch's accessible name, so nothing is lost to a screen reader. */
  it('carries no caption beside the switch, only the switch itself', () => {
    const { container } = renderSection();
    const controls = container.querySelectorAll('.settings-row__control');
    expect(controls).toHaveLength(3);
    for (const control of controls) {
      expect(control.children).toHaveLength(1);
      expect(control.firstElementChild).toHaveAttribute('role', 'switch');
      expect(control.textContent).toBe('');
    }
    expect(screen.getByRole('switch', { name: 'Search memory after each message' })).toBeInTheDocument();
    // The sentence is the switch's name, not a caption printed beside it.
    expect(screen.queryByText('Search memory after each message')).not.toBeInTheDocument();
  });
});
