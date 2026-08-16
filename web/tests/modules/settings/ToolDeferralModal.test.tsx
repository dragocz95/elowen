import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { cs } from '../../../lib/i18n/dictionaries/cs';
import { en } from '../../../lib/i18n/dictionaries/en';
import { sk } from '../../../lib/i18n/dictionaries/sk';
import { RUNTIME_LIMIT_DEFAULTS } from '../../../modules/settings/RuntimeLimitsModal';
import { ToolDeferralModal } from '../../../modules/settings/ToolDeferralModal';
import type { ConfigPatch, RuntimeConfig } from '../../../lib/types';

const CATALOG = [
  {
    sourceId: 'plugin:discord', label: 'Discord', kind: 'plugin' as const, override: null,
    tools: [
      { name: 'DiscordCreateChannel', label: 'Discord Create Channel', eligible: true, lockedReason: null, defaultMode: 'deferred' as const, override: null, effective: 'deferred' as const, reason: 'source-default' },
      { name: 'DiscordDeleteChannel', label: 'Discord Delete Channel', eligible: true, lockedReason: null, defaultMode: 'immediate' as const, override: null, effective: 'immediate' as const, reason: 'default-immediate' },
    ],
  },
  {
    sourceId: 'builtin', label: 'Built-in', kind: 'builtin' as const, override: null,
    tools: [
      { name: 'TodoWrite', label: 'Todo Write', eligible: false, lockedReason: 'never-defer' as const, defaultMode: 'immediate' as const, override: null, effective: 'immediate' as const, reason: 'never-defer' },
      { name: 'ScanCode', label: 'Scan Code', eligible: true, lockedReason: null, defaultMode: 'deferred' as const, override: null, effective: 'deferred' as const, reason: 'source-default' },
    ],
  },
];

const runtime = (overrides: RuntimeConfig['toolDeferralOverrides'] = { sources: {}, tools: {} }): RuntimeConfig => ({
  limits: RUNTIME_LIMIT_DEFAULTS,
  toolDeferralEnabled: true,
  remoteCompactionEnabled: false,
  toolDeferralOverrides: overrides,
  subagentRunnerEnabled: false,
  subagentRunnerPoolMax: null,
});

function renderModal(options: { initial?: RuntimeConfig; onSave?: (patch: ConfigPatch) => Promise<unknown> } = {}) {
  const onSave = options.onSave ?? vi.fn(() => Promise.resolve({}));
  render(
    <LanguageProvider>
      <ToolDeferralModal runtime={options.initial ?? runtime()} onSave={onSave} onClose={() => {}} />
    </LanguageProvider>,
  );
  return { onSave };
}

function group(name: string) {
  return screen.getByRole('radiogroup', { name: `Loading mode for ${name}` });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ToolDeferralModal', () => {
  it('starts every catalog group collapsed', async () => {
    renderModal();
    await screen.findByText('Discord');

    expect(screen.queryByText('Discord Create Channel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Discord' }));
    expect(screen.getByText('Discord Create Channel')).toBeInTheDocument();
  });

  it('searches both tool and plugin names and opens matching groups', async () => {
    renderModal();
    await screen.findByText('Discord');

    fireEvent.change(screen.getByRole('textbox', { name: 'Search tools' }), { target: { value: 'scan' } });
    expect(screen.getByText('Scan Code')).toBeInTheDocument();
    expect(screen.queryByText('Discord Create Channel')).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search tools' }), { target: { value: 'discord' } });
    expect(screen.getByText('Discord Create Channel')).toBeInTheDocument();
    expect(screen.getByText('Discord Delete Channel')).toBeInTheDocument();
  });

  it('keeps overrides when the global switch is turned off', async () => {
    const onSave = vi.fn(() => Promise.resolve({}));
    renderModal({ initial: runtime({ sources: { 'plugin:discord': 'deferred' }, tools: { 'plugin:discord': { DiscordDeleteChannel: 'immediate' } } }), onSave });
    await screen.findByText('Discord');

    fireEvent.click(screen.getByRole('switch', { name: 'Enable deferred tool loading' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ runtime: {
      toolDeferralEnabled: false,
      limits: { toolDeferThreshold: 10 },
      toolDeferralOverrides: { sources: { 'plugin:discord': 'deferred' }, tools: { 'plugin:discord': { DiscordDeleteChannel: 'immediate' } } },
    } });
  });

  it('supports a group choice with a per-tool exception in one explicit save', async () => {
    const onSave = vi.fn(() => Promise.resolve({}));
    renderModal({ onSave });
    await screen.findByText('Discord');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Discord' }));

    fireEvent.click(within(group('Discord')).getByRole('radio', { name: 'ToolSearch' }));
    const toolMode = screen.getByRole('radiogroup', { name: 'Loading mode for Discord Delete Channel' });
    fireEvent.click(within(toolMode).getByRole('radio', { name: 'Immediate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ runtime: {
      toolDeferralEnabled: true,
      limits: { toolDeferThreshold: 10 },
      toolDeferralOverrides: {
        sources: { 'plugin:discord': 'deferred' },
        tools: { 'plugin:discord': { DiscordDeleteChannel: 'immediate' } },
      },
    } });
  });

  it('removes a per-tool override when Default is selected', async () => {
    const onSave = vi.fn(() => Promise.resolve({}));
    renderModal({ initial: runtime({ sources: {}, tools: { 'plugin:discord': { DiscordCreateChannel: 'immediate' } } }), onSave });
    await screen.findByText('Discord');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Discord' }));

    const toolMode = screen.getByRole('radiogroup', { name: 'Loading mode for Discord Create Channel' });
    fireEvent.click(within(toolMode).getByRole('radio', { name: 'Default' }));
    expect(within(toolMode).getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ runtime: {
      toolDeferralEnabled: true,
      limits: { toolDeferThreshold: 10 },
      toolDeferralOverrides: { sources: {}, tools: {} },
    } });
  });

  it('does not allow a locked tool to become deferred', async () => {
    const onSave = vi.fn(() => Promise.resolve({}));
    renderModal({ onSave });
    await screen.findByRole('button', { name: 'Expand Built-in' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand Built-in' }));

    const locked = screen.getByRole('button', { name: 'Todo Write: Always immediate' });
    expect(locked).toBeDisabled();
    fireEvent.click(locked);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ runtime: expect.objectContaining({ toolDeferralOverrides: { sources: {}, tools: {} } }) }));
  });

  it('keeps all tool-loading labels in locale parity', () => {
    expect(Object.keys(cs.brain.toolLoading)).toEqual(Object.keys(en.brain.toolLoading));
    expect(Object.keys(sk.brain.toolLoading)).toEqual(Object.keys(en.brain.toolLoading));
    expect(Object.keys(cs.brain.toolLoading.reason)).toEqual(Object.keys(en.brain.toolLoading.reason));
    expect(Object.keys(sk.brain.toolLoading.reason)).toEqual(Object.keys(en.brain.toolLoading.reason));
  });
});
