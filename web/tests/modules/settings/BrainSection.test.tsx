import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';

const saveProviders = vi.fn();
const disconnect = vi.fn();
const CONFIG = { brain: { providers: [], agentName: 'Elowen', maxSteps: 20 } };
const OAUTH = { 'oauth-anthropic': true, 'oauth-openai-codex': false, 'oauth-github-copilot': false };

vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfig: () => ({ data: CONFIG }),
  useBrainOauthStatus: () => ({ data: OAUTH, refetch: vi.fn() }),
}));
vi.mock('../../../lib/mutations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useUpdateConfig: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useSaveBrainProviders: () => ({ mutate: saveProviders }),
  useBrainOauthDisconnect: () => ({ mutate: disconnect }),
}));
vi.mock('../../../lib/elowenClient', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    elowenClient: { ...(actual.elowenClient as object), brainOauthCatalog: vi.fn(() => Promise.resolve({ models: ['claude-opus', 'claude-sonnet'] })) },
  };
});

import { BrainSection } from '../../../modules/settings/BrainSection';

const renderSection = () => render(<ToastProvider><BrainSection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => { saveProviders.mockClear(); disconnect.mockClear(); });

describe('BrainSection — OAuth account model picker', () => {
  it('opens the manage modal for a connected account, picks a model (icon rows), and saves the selection', async () => {
    renderSection();
    // The connected Claude account exposes a "Models" button opening the manage-selection modal.
    fireEvent.click(screen.getByRole('button', { name: `${en.brain.pickModels}: ${en.brain.types['oauth-anthropic']}` }));
    // Catalog loads async → rows render with per-model brand icons.
    const row = await screen.findByRole('button', { name: 'claude-opus' });
    expect(row.querySelector('img')).toBeTruthy();
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.saveChanges }));

    await waitFor(() => expect(saveProviders).toHaveBeenCalled());
    const payload = saveProviders.mock.calls.at(-1)![0] as { id: string; models: string[] }[];
    const entry = payload.find((p) => p.id === 'anthropic');
    expect(entry?.models).toEqual(['claude-opus']);
  });

  it('confirms before disconnecting an OAuth account', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: `${en.brain.disconnect}: ${en.brain.types['oauth-anthropic']}` }));
    expect(disconnect).not.toHaveBeenCalled();
    expect(screen.getByText(en.brain.disconnectConfirm.replace('{provider}', en.brain.types['oauth-anthropic']))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.brain.disconnect }));
    expect(disconnect).toHaveBeenCalledWith('oauth-anthropic', expect.any(Object));
  });
});
