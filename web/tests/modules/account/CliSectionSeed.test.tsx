import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { BrainModelOption, CliSettings, PermissionSettings } from '../../../lib/types';

// Mutable query state so a test can flip in a fresh server object (a refetch) and assert the seed
// guard does NOT re-seed over a local edit.
const state = vi.hoisted(() => ({
  cli: null as CliSettings | null,
  perm: null as PermissionSettings | null,
  cliError: false,
  models: [] as BrainModelOption[],
}));
const mocks = vi.hoisted(() => ({ saveCli: vi.fn(), savePermissions: vi.fn(), refetchCli: vi.fn() }));

vi.mock('../../../lib/mutations', () => ({
  useSaveMyCliSettings: () => ({ mutate: mocks.saveCli, mutateAsync: mocks.saveCli }),
  useSaveMyPermissions: () => ({ mutate: mocks.savePermissions, mutateAsync: mocks.savePermissions }),
}));
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMyCliSettings: () => ({ data: state.cliError ? undefined : state.cli, isLoading: false, isError: state.cliError, refetch: mocks.refetchCli }),
  useMyPermissions: () => ({ data: state.perm, isLoading: false }),
  useBrainModels: () => ({ data: state.models }),
}));

import { CliSection } from '../../../modules/account/CliSection';

const CLI: CliSettings = {
  model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '',
  autoCompact: false, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '',
  autoRecall: true, autoLiveRecall: true, autoSave: true, fastMode: false,
};
const PERMISSIONS: PermissionSettings = { tools: {}, bash: {}, yolo: false, unattendedAsks: 'allow' };

const renderSection = () => render(<ToastProvider><CliSection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => {
  state.cli = { ...CLI };
  state.perm = { ...PERMISSIONS };
  state.cliError = false;
  state.models = [
    {
      provider: 'plain', providerLabel: 'Plain', model: 'catalog-first', exec: 'elowen:plain/catalog-first',
      source: 'api-key', contextWindow: 32000, contextWindowSet: false,
    },
    {
      provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5.6-sol', exec: 'elowen:openai/gpt-5.6-sol',
      source: 'api-key', contextWindow: 372000, contextWindowSet: false, default: true, fastAvailable: true,
      reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      reasoningLabels: { xhigh: 'ultra', max: 'max' },
    },
  ];
  mocks.saveCli.mockReset();
  mocks.savePermissions.mockReset();
  mocks.refetchCli.mockReset();
});

describe('CliSection — error state', () => {
  it('shows a retryable error instead of a permanent skeleton', () => {
    state.cliError = true;
    renderSection();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: en.cli.thinkingLabel })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetchCli).toHaveBeenCalledOnce();
  });
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

  it('persists Fast for the account when a configured route supports it', async () => {
    renderSection();
    const toggle = screen.getByRole('switch', { name: en.cli.fastModeToggle });
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.saveCli.mock.calls.some(([patch]) => JSON.stringify(patch) === '{"fastMode":true}')).toBe(true), { timeout: 1500 });
  });

  it('keeps Fast selectable but explains that the current model cannot use it', () => {
    state.cli = { ...CLI, model: 'catalog-first', modelProvider: 'plain', fastMode: true };
    renderSection();
    const toggle = screen.getByRole('switch', { name: en.cli.fastModeToggle });
    expect(toggle).not.toBeDisabled();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(en.cli.fastModeCurrentUnsupported)).toBeInTheDocument();
  });

  it('disables Fast honestly when no configured route supports it', () => {
    state.models = state.models.map(({ fastAvailable: _fastAvailable, ...model }) => model);
    renderSection();
    expect(screen.getByRole('switch', { name: en.cli.fastModeToggle })).toBeDisabled();
    expect(screen.getByText(en.cli.fastModeUnavailable)).toBeInTheDocument();
  });

  it('preserves a failed YOLO value so the user can retry it', async () => {
    mocks.savePermissions.mockRejectedValueOnce(new Error('failed'));
    renderSection();
    const toggle = () => screen.getByRole('switch', { name: en.cli.yoloToggle });
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: en.cli.yoloConfirm }));
    expect(toggle().getAttribute('aria-checked')).toBe('true');

    await waitFor(() => expect(mocks.savePermissions).toHaveBeenCalled(), { timeout: 1500 });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });
});
