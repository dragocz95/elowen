import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createWrapper } from '../test-utils';
import { en } from '../../lib/i18n/dictionaries/en';
import type { BrainModelOption } from '../../lib/types';

// ModelPicker reads the single chat controller via useBrainChat — mock it so the picker is exercised in
// isolation against a controlled catalog + switch action (no network, no BrainChatProvider boot).
const ctx = vi.hoisted(() => ({
  value: {} as {
    models: BrainModelOption[] | null;
    currentModel: string;
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
  model({ provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5', source: 'api-key' }),
];

function setCtx(over: Partial<typeof ctx.value>): void {
  ctx.value = {
    models: null, currentModel: '', setModel: vi.fn(), loadModels: vi.fn(), modelsLoading: false, modelsError: false,
    ...over,
  };
}

const renderPicker = (variant: 'full' | 'compact' = 'full') =>
  render(<ModelPicker variant={variant} />, { wrapper: createWrapper().wrapper });

const openPopover = () => fireEvent.click(screen.getByRole('button', { name: /./ }));

beforeEach(() => setCtx({}));

describe('ModelPicker', () => {
  it('fetches the catalog once on first open when it is not yet loaded', () => {
    const loadModels = vi.fn();
    setCtx({ models: null, loadModels });
    renderPicker();
    expect(loadModels).not.toHaveBeenCalled();
    openPopover();
    expect(loadModels).toHaveBeenCalledTimes(1);
  });

  it('groups by provider with an OAuth/source badge, marks the active model, and shows reasoning chips', () => {
    setCtx({ models: CATALOG, currentModel: 'claude-sonnet' });
    renderPicker();
    openPopover();

    // Provider grouping + source badges.
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('OAuth')).toBeInTheDocument();
    expect(screen.getByText('API')).toBeInTheDocument();

    // Active model is the selected option; the others are not.
    const active = screen.getByRole('option', { name: /claude-sonnet/ });
    expect(active).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /claude-opus/ })).toHaveAttribute('aria-selected', 'false');

    // Reasoning chips render for the model that supports them (labelled), from its reasoningLabels.
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('switches the conversation on row click and closes the popover', () => {
    const setModel = vi.fn();
    setCtx({ models: CATALOG, currentModel: 'claude-opus', setModel });
    renderPicker();
    openPopover();
    fireEvent.click(screen.getByRole('option', { name: /gpt-5/ }));
    expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', model: 'gpt-5' }));
    expect(screen.queryByRole('listbox')).toBeNull(); // closed after a pick
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
    fireEvent.click(screen.getByRole('button', { name: en.brainChat.modelPickerRetry }));
    expect(loadModels).toHaveBeenCalledTimes(1);
  });
});
