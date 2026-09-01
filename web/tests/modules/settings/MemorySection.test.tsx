import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { EmbeddingSettings, CategorizationSettings, BrainModelOption } from '../../../lib/types';

const saveCategorization = vi.fn();
const saveEmbedding = vi.fn();
vi.mock('../../../lib/mutations', () => ({
  useSaveEmbeddingSettings: () => ({ mutate: saveEmbedding, mutateAsync: saveEmbedding }),
  useSaveCategorizationSettings: () => ({ mutate: saveCategorization, mutateAsync: saveCategorization }),
}));

const EMBEDDING: EmbeddingSettings = { providerId: 'openai', model: 'text-embedding-3-small', baseUrl: '', dimensions: 1536, configured: true };
const CATEGORIZATION: CategorizationSettings = { providerId: 'anthropic', model: '', baseUrl: '', configured: false };
const MODELS: BrainModelOption[] = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-haiku', exec: 'elowen:anthropic/claude-haiku', source: 'api-key', contextWindow: 200000, contextWindowSet: false },
  { provider: 'openai', providerLabel: 'OpenAI', model: 'text-embedding-3-small', exec: 'elowen:openai/text-embedding-3-small', source: 'api-key', contextWindow: 8192, contextWindowSet: false },
];
const CONFIG = { brain: { providers: [{ id: 'anthropic', label: 'Anthropic', type: 'anthropic' }, { id: 'openai', label: 'OpenAI', type: 'openai' }] } };
const state = vi.hoisted(() => ({ embeddingError: false, categorizationError: false }));
const mocks = vi.hoisted(() => ({ refetchEmbedding: vi.fn(), refetchCategorization: vi.fn() }));
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfig: () => ({ data: CONFIG }),
  useEmbeddingSettings: () => (state.embeddingError
    ? { data: undefined, isError: true, refetch: mocks.refetchEmbedding }
    : { data: EMBEDDING, isError: false, refetch: mocks.refetchEmbedding }),
  useCategorizationSettings: () => (state.categorizationError
    ? { data: undefined, isError: true, refetch: mocks.refetchCategorization }
    : { data: CATEGORIZATION, isError: false, refetch: mocks.refetchCategorization }),
  useBrainModels: () => ({ data: MODELS }),
}));

import { MemorySection } from '../../../modules/settings/MemorySection';

const renderSection = () => render(<ToastProvider><MemorySection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => {
  saveCategorization.mockClear(); saveEmbedding.mockClear();
  state.embeddingError = false; state.categorizationError = false;
  mocks.refetchEmbedding.mockClear(); mocks.refetchCategorization.mockClear();
});

describe('MemorySection — error state', () => {
  it('shows a retryable error instead of a permanent skeleton when embedding settings fail to load', () => {
    state.embeddingError = true;
    renderSection();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: en.managePicker.manage })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetchEmbedding).toHaveBeenCalledOnce();
  });

  it('shows a retryable error when categorization settings fail to load', () => {
    state.categorizationError = true;
    renderSection();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetchCategorization).toHaveBeenCalledOnce();
  });
});

describe('MemorySection — categorization model picker', () => {
  it('uses the shared settings group and row pattern for both memory model areas', () => {
    const { container } = renderSection();

    expect(container.querySelectorAll('[data-settings-group]')).toHaveLength(1);
    expect(container.querySelectorAll('.settings-row')).toHaveLength(6);
    expect(screen.queryByRole('button', { name: 'Reindex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reclassify memories' })).toBeNull();
    expect(container.querySelector('.spatial-group')).toBeNull();
  });

  it('picks a provider-scoped model in the modal (rows carry icons) and autosaves it', async () => {
    renderSection();
    // Each of the four pickers on this card is named for its own field now, so the categorization
    // MODEL is reachable by name instead of by its index among four identical "Manage" buttons.
    fireEvent.click(screen.getByRole('button', { name: en.categorization.modelLabel }));
    // The catalog is provider-scoped (anthropic) → the model row shows with its brand icon.
    const row = await screen.findByRole('button', { name: 'claude-haiku' });
    expect(row.querySelector('img')).toBeTruthy();
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.saveChanges }));

    await waitFor(() => expect(saveCategorization).toHaveBeenCalled(), { timeout: 1500 });
    expect(saveCategorization.mock.calls.at(-1)![0]).toMatchObject({ providerId: 'anthropic', model: 'claude-haiku' });
  });

  it('the pinned "None" row clears the model back to empty', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: en.categorization.modelLabel }));
    // No model saved → the pinned None row is the current pick.
    expect(await screen.findByRole('button', { name: en.managePicker.none })).toHaveAttribute('aria-pressed', 'true');
  });

  it('gives the custom model and optional dimensions inputs explicit translated names', () => {
    renderSection();
    expect(screen.getByRole('textbox', { name: en.memory.embeddingModelCustom })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: en.memory.embeddingDimensions })).toHaveValue(1536);
  });
});
