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
  useReindexMemories: () => ({ mutate: vi.fn(), isPending: false }),
  useSaveCategorizationSettings: () => ({ mutate: saveCategorization, mutateAsync: saveCategorization }),
  useReclassifyMemories: () => ({ mutate: vi.fn(), isPending: false }),
}));

const EMBEDDING: EmbeddingSettings = { providerId: 'openai', model: 'text-embedding-3-small', baseUrl: '', dimensions: 1536, configured: true };
const CATEGORIZATION: CategorizationSettings = { providerId: 'anthropic', model: '', baseUrl: '', configured: false };
const MODELS: BrainModelOption[] = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-haiku', exec: 'elowen:anthropic/claude-haiku', source: 'api-key', contextWindow: 200000, contextWindowSet: false },
  { provider: 'openai', providerLabel: 'OpenAI', model: 'text-embedding-3-small', exec: 'elowen:openai/text-embedding-3-small', source: 'api-key', contextWindow: 8192, contextWindowSet: false },
];
const CONFIG = { brain: { providers: [{ id: 'anthropic', label: 'Anthropic', type: 'anthropic' }, { id: 'openai', label: 'OpenAI', type: 'openai' }] } };
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfig: () => ({ data: CONFIG }),
  useEmbeddingSettings: () => ({ data: EMBEDDING }),
  useCategorizationSettings: () => ({ data: CATEGORIZATION }),
  useBrainModels: () => ({ data: MODELS }),
}));

import { MemorySection } from '../../../modules/settings/MemorySection';

const renderSection = () => render(<ToastProvider><MemorySection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => { saveCategorization.mockClear(); saveEmbedding.mockClear(); });

describe('MemorySection — categorization model picker', () => {
  it('uses the shared settings group and row pattern for both memory model areas', () => {
    const { container } = renderSection();

    expect(container.querySelectorAll('[data-settings-group]')).toHaveLength(1);
    expect(container.querySelectorAll('.settings-row')).toHaveLength(8);
    expect(container.querySelector('.spatial-group')).toBeNull();
  });

  it('picks a provider-scoped model in the modal (rows carry icons) and autosaves it', async () => {
    renderSection();
    // The provider chips and both catalog fields render a Manage button each (embedding provider,
    // embedding model, categorization provider, categorization model) — the categorization MODEL
    // is the fourth, scoped to its "anthropic" provider.
    const manageButtons = screen.getAllByRole('button', { name: en.managePicker.manage });
    fireEvent.click(manageButtons[3]);
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
    const manageButtons = screen.getAllByRole('button', { name: en.managePicker.manage });
    fireEvent.click(manageButtons[3]);
    // No model saved → the pinned None row is the current pick.
    expect(await screen.findByRole('button', { name: en.managePicker.none })).toHaveAttribute('aria-pressed', 'true');
  });
});
