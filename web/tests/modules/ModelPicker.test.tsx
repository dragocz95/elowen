import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createWrapper } from '../test-utils';
import { en } from '../../lib/i18n/dictionaries/en';
import type { BrainModelOption } from '../../lib/types';

// ModelPicker reads the single chat controller via useBrainChat — mock it so the picker is exercised in
// isolation against a controlled catalog + switch action (no network, no BrainChatProvider boot).
const ctx = vi.hoisted(() => ({
  value: {} as {
    models: BrainModelOption[] | null;
    currentModel: string;
    provider: string;
    providerLabel: string;
    setModel: (m: BrainModelOption) => void;
    loadModels: () => void;
    modelsLoading: boolean;
    modelsError: boolean;
  },
}));
vi.mock('../../modules/advisor/BrainChatProvider', () => ({ useBrainChat: () => ctx.value }));

import { ModelPicker } from '../../modules/advisor/ModelPicker';

const model = (over: Partial<BrainModelOption> & Pick<BrainModelOption, 'provider' | 'providerLabel' | 'model' | 'source'>): BrainModelOption => ({
  exec: `elowen:${over.provider}/${over.model}`, contextWindow: 200_000, contextWindowSet: true, ...over,
});

const CATALOG: BrainModelOption[] = [
  model({ provider: 'anthropic-oauth', providerLabel: 'Claude', model: 'claude-opus', source: 'oauth', reasoningLevels: ['low', 'high'], reasoningLabels: { low: 'Low', high: 'High' } }),
  model({ provider: 'anthropic-oauth', providerLabel: 'Claude', model: 'claude-sonnet', source: 'oauth' }),
  model({ provider: 'chatgpt-account', providerLabel: 'Účet ChatGPT', model: 'gpt-5.6-sol', source: 'oauth' }),
];

function setCtx(over: Partial<typeof ctx.value>): void {
  ctx.value = {
    models: null, currentModel: '', provider: '', providerLabel: '', setModel: vi.fn(), loadModels: vi.fn(), modelsLoading: false, modelsError: false,
    ...over,
  };
}

const renderPicker = (variant: 'full' | 'compact' = 'full') =>
  render(<ModelPicker variant={variant} />, { wrapper: createWrapper().wrapper });

const openPopover = () => fireEvent.pointerDown(screen.getByRole('button', { name: /./ }), { button: 0, ctrlKey: false });

beforeEach(() => setCtx({}));

describe('ModelPicker', () => {
  it('fetches the catalog once on first open when it is not yet loaded', async () => {
    const loadModels = vi.fn();
    setCtx({ models: null, loadModels });
    renderPicker();
    expect(loadModels).not.toHaveBeenCalled();
    openPopover();
    expect(loadModels).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    openPopover();
    expect(loadModels).toHaveBeenCalledTimes(1);
  });

  it('shows a bare OAuth model on the trigger while grouped rows keep provider ambiguity handling', () => {
    const duplicate = model({ provider: 'chatgpt-account', providerLabel: 'Účet ChatGPT', model: 'claude-sonnet', source: 'oauth' });
    setCtx({
      models: [...CATALOG, duplicate],
      currentModel: 'gpt-5.6-sol',
      provider: 'chatgpt-account',
      providerLabel: 'Účet ChatGPT',
    });
    renderPicker();
    const trigger = screen.getByRole('button', { name: 'gpt-5.6-sol' });
    expect(trigger).toHaveAttribute('title', 'Účet ChatGPT/gpt-5.6-sol');
    expect(trigger).not.toHaveTextContent('Účet ChatGPT/');
    openPopover();

    // Provider grouping + source badges.
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Účet ChatGPT')).toBeInTheDocument();
    expect(screen.getAllByText('OAuth').length).toBeGreaterThan(0);

    // The provider/model pair, not the visible label, decides which same-named row is active.
    const duplicateRows = screen.getAllByRole('menuitemradio', { name: /claude-sonnet/ });
    expect(duplicateRows).toHaveLength(2);
    expect(duplicateRows.every((row) => row.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(screen.getByRole('menuitemradio', { name: /gpt-5\.6-sol/ })).toHaveAttribute('aria-checked', 'true');

    // Reasoning chips render for the model that supports them (labelled), from its reasoningLabels.
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('switches the conversation on row click and closes the popover', () => {
    const setModel = vi.fn();
    setCtx({ models: CATALOG, currentModel: 'claude-opus', setModel });
    renderPicker();
    openPopover();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /gpt-5\.6-sol/ }));
    expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: 'chatgpt-account', model: 'gpt-5.6-sol' }));
    expect(screen.queryByRole('menu')).toBeNull(); // closed after a pick
  });

  it('supports keyboard opening, typeahead selection, and focus restoration', async () => {
    const setModel = vi.fn();
    setCtx({ models: CATALOG, currentModel: 'claude-opus', provider: 'anthropic-oauth', setModel });
    renderPicker();
    const trigger = screen.getByRole('button', { name: /claude-opus/ });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const first = await screen.findByRole('menuitemradio', { name: /claude-opus/ });
    await waitFor(() => expect(first).toHaveFocus());

    fireEvent.keyDown(first, { key: 'g' });
    const target = screen.getByRole('menuitemradio', { name: /gpt-5\.6-sol/ });
    await waitFor(() => expect(target).toHaveFocus());
    fireEvent.keyDown(target, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: 'chatgpt-account', model: 'gpt-5.6-sol' }));
    expect(trigger).toHaveFocus();
  });

  it('shows the RBAC no-allowed-model state when the server-filtered catalog is empty', () => {
    setCtx({ models: [] });
    renderPicker();
    openPopover();
    expect(screen.getByText(en.brainChat.modelPickerEmpty)).toBeInTheDocument();
  });

  it('shows the loading state while the catalog is being fetched', () => {
    setCtx({ models: null, modelsLoading: true });
    renderPicker();
    openPopover();
    expect(screen.getByText(en.brainChat.modelPickerLoading)).toBeInTheDocument();
  });

  it('shows the provider-error state with a retry that re-fetches', () => {
    const loadModels = vi.fn();
    setCtx({ models: null, modelsError: true, loadModels });
    renderPicker();
    openPopover();
    expect(screen.getByText(en.brainChat.modelPickerError)).toBeInTheDocument();
    loadModels.mockClear(); // ignore the on-open fetch; assert the retry button re-invokes
    fireEvent.click(screen.getByRole('menuitem', { name: en.brainChat.modelPickerRetry }));
    expect(loadModels).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
