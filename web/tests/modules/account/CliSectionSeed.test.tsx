import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { CliSettings, PermissionSettings } from '../../../lib/types';

// Mutable query state so a test can flip in a fresh server object (a refetch) and assert the seed
// guard does NOT re-seed over a local edit.
const state = vi.hoisted(() => ({ cli: null as CliSettings | null, perm: null as PermissionSettings | null }));
const mocks = vi.hoisted(() => ({ saveCli: vi.fn(), savePermissions: vi.fn() }));

vi.mock('../../../lib/mutations', () => ({
  useSaveMyCliSettings: () => ({ mutate: mocks.saveCli }),
  useSaveMyPermissions: () => ({ mutate: mocks.savePermissions }),
}));
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMyCliSettings: () => ({ data: state.cli, isLoading: false }),
  useMyPermissions: () => ({ data: state.perm, isLoading: false }),
  useBrainModels: () => ({ data: [
    {
      provider: 'plain', providerLabel: 'Plain', model: 'catalog-first', exec: 'elowen:plain/catalog-first',
      source: 'api-key', contextWindow: 32000, contextWindowSet: false,
    },
    {
      provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5.6-sol', exec: 'elowen:openai/gpt-5.6-sol',
      source: 'oauth', contextWindow: 372000, contextWindowSet: false, default: true,
      reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      reasoningLabels: { xhigh: 'ultra', max: 'max' },
    },
  ] }),
}));

import { CliSection } from '../../../modules/account/CliSection';

const CLI: CliSettings = {
  model: '', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '',
  autoCompact: false, autoCompactAt: 80, advisorStyle: 'professional', discordUserId: '', whatsappNumber: '',
  autoRecall: true, autoSave: true,
};
const PERMISSIONS: PermissionSettings = { tools: {}, bash: {}, yolo: false, unattendedAsks: 'allow' };

const renderSection = () => render(<ToastProvider><CliSection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => {
  state.cli = { ...CLI };
  state.perm = { ...PERMISSIONS };
  mocks.saveCli.mockReset();
  mocks.savePermissions.mockReset();
});

describe('CliSection — seed guard', () => {
  it('does NOT clobber a local edit when the query refetches with different server data', async () => {
    const { rerender } = renderSection();
    // Local edit: pick the "high" thinking level (server seed was the default '').
    fireEvent.click(screen.getByRole('button', { name: 'high' }));
    expect(screen.getByRole('button', { name: 'high' }).getAttribute('aria-pressed')).toBe('true');

    // A sibling save invalidates ['my-cli-settings']; the refetch returns a NEW object with the OLD
    // (stale) thinking level. The seed guard must ignore it and keep the in-progress local edit.
    state.cli = { ...CLI, thinkingLevel: 'low' };
    rerender(<ToastProvider><CliSection /></ToastProvider>);

    expect(screen.getByRole('button', { name: 'high' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'low' }).getAttribute('aria-pressed')).toBe('false');
    // And the value that autosaves is the local edit, never the clobbering server value.
    await waitFor(() => expect(mocks.saveCli).toHaveBeenCalled(), { timeout: 1500 });
    expect(mocks.saveCli.mock.calls.at(-1)![0]).toMatchObject({ thinkingLevel: 'high' });
  });

  it('renders only the active model capabilities with provider-facing ultra and max labels', () => {
    renderSection();
    expect(screen.getByRole('button', { name: 'ultra' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'max' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'minimal' })).toBeNull();
  });

  it('changes reasoning through the draggable range control', async () => {
    renderSection();
    const scale = screen.getByRole('slider', { name: en.cli.thinkingLabel });
    fireEvent.change(scale, { target: { value: '3' } });
    await waitFor(() => expect(mocks.saveCli).toHaveBeenCalled(), { timeout: 1500 });
    expect(mocks.saveCli.mock.calls.at(-1)![0]).toMatchObject({ thinkingLevel: 'high' });
  });

  it('reverts the YOLO toggle to the server value when the autosave fails', async () => {
    mocks.savePermissions.mockImplementation((_patch: unknown, opts?: { onError?: () => void }) => opts?.onError?.());
    renderSection();
    const toggle = () => screen.getByRole('switch', { name: en.cli.yoloToggle });
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-checked')).toBe('true'); // optimistic

    await waitFor(() => expect(mocks.savePermissions).toHaveBeenCalled(), { timeout: 1500 });
    // Save rejected → revert to server truth (false), not left stuck on the optimistic value.
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'), { timeout: 1500 });
  });
});
