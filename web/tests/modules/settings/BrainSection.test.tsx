import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { interpolate } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { ElowenConfig } from '../../../lib/types';

const saveProviders = vi.fn();
const disconnect = vi.fn();
const updateConfig = vi.fn(() => Promise.resolve(CONFIG));
const CONFIG = {
  brain: { providers: [], agentName: 'Elowen', maxSteps: 20, hiddenOauth: [] as string[] },
  runtime: {
    limits: {
      localShellTimeoutMs: 30000, memorySemanticFloorPerMille: 200, toolDeferThreshold: 10, eventRetentionDays: 30,
      streamSilenceLimitMs: 75000, streamReviveSilenceLimitMs: 45000, toastDurationMs: 4500,
    },
    toolDeferralEnabled: true,
    memoryRetention: {
      enabled: true, graceDays: 14, vitalityFloor: 10,
      halfLifeByImportance: { 1: 3, 2: 7, 3: 14, 4: 30, 5: 0 },
    },
  },
};
// The daemon's /brain/oauth/status returns the full supported type set (OAUTH_BUILTIN); the rendered
// account rows are derived from these keys, so the mock mirrors the endpoint faithfully.
const OAUTH = { 'oauth-anthropic': true, 'oauth-openai-codex': false, 'oauth-github-copilot': false, 'oauth-kimi': false };
const oauthRefetch = vi.fn();
const rateLimitsRefetch = vi.fn();
/** Per test: the rate-limit windows the connected accounts report, keyed by built-in provider id. */
let RATE_LIMITS: Record<string, { provider: string; planType: string | null; windows: { usedPercent: number; windowMinutes: number | null; resetsAt: number | null }[]; fetchedAt: number; stale: boolean }> | undefined;

// The connect dialog polls /brain/oauth/flow; the poll promise is resolved by hand so a test can land an
// answer at a chosen moment (notably after the dialog was cancelled). Hoisted because the elowenClient
// factory runs before this module's body, via the queries import chain.
const oauthFlowMocks = vi.hoisted(() => {
  const pending: { resolve: ((flow: { id: string; status: string }) => void) | null } = { resolve: null };
  return {
    pending,
    start: vi.fn(() => Promise.resolve({ id: 'flow-1', status: 'action-required', authUrl: 'https://auth.example/device' })),
    flow: vi.fn(() => new Promise<{ id: string; status: string }>((resolve) => { pending.resolve = resolve; })),
  };
});

// The endpoint probe behind the provider modal's model picker, resolved by hand per call so a test can
// land answers out of order (a slow probe for an edited-away URL arriving last).
const probeMock = vi.hoisted(() => {
  const pending: { baseUrl: string; resolve: (r: { models: string[] }) => void }[] = [];
  return {
    pending,
    probe: vi.fn((body: { baseUrl: string }) => new Promise<{ models: string[] }>((resolve) => {
      pending.push({ baseUrl: body.baseUrl, resolve });
    })),
  };
});
type HostedStatusProvider = {
  providerId: string;
  enabled: boolean;
  verifiable: boolean;
  effective: 'active' | 'off' | 'unsupported' | 'unverified';
  models: { modelId: string; status: 'supported' | 'unsupported' | 'unverified'; checkedAt: number | null }[];
};
const hostedMocks = vi.hoisted(() => ({
  status: vi.fn<() => Promise<{ providers: {
    providerId: string;
    enabled: boolean;
    verifiable: boolean;
    effective: 'active' | 'off' | 'unsupported' | 'unverified';
    models: { modelId: string; status: 'supported' | 'unsupported' | 'unverified'; checkedAt: number | null }[];
  }[] }>>()
    .mockResolvedValue({ providers: [] }),
  probe: vi.fn<() => Promise<{ providerId: string; modelId: string; status: 'supported' | 'unsupported' | 'error'; reason: string; checkedAt: number }>>()
    .mockResolvedValue({ providerId: 'azure', modelId: 'deployment', status: 'supported', reason: 'server_search_and_replay_ok', checkedAt: 1 }),
}));

/** One provider record of GET /brain/providers/hosted-tool-search/status, defaulted to the shape the
 *  daemon reports for a capable, switched-on provider so each test states only what it is about. */
const hostedProvider = (providerId: string, overrides: Partial<HostedStatusProvider> = {}): HostedStatusProvider => ({
  providerId, enabled: true, verifiable: false, effective: 'active', models: [], ...overrides,
});

/** The pending probe for `baseUrl`, as an explicit failure when the component never issued it. */
const probeFor = (baseUrl: string) => {
  const call = probeMock.pending.find((p) => p.baseUrl === baseUrl);
  if (!call) throw new Error(`no probe was issued for ${baseUrl} (issued: ${probeMock.pending.map((p) => p.baseUrl).join(', ') || 'none'})`);
  return call.resolve;
};

/** The connect dialog's in-flight poll resolver, as an explicit failure when no poll is in flight. */
const pendingPoll = () => {
  const resolve = oauthFlowMocks.pending.resolve;
  if (!resolve) throw new Error('the connect dialog has no poll in flight');
  return resolve;
};

vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfig: () => ({ data: CONFIG }),
  useBrainOauthStatus: () => ({ data: OAUTH, refetch: oauthRefetch }),
  useBrainRateLimitsAll: () => ({ data: RATE_LIMITS, refetch: rateLimitsRefetch }),
}));
vi.mock('../../../lib/mutations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useUpdateConfig: () => ({ mutate: vi.fn(), mutateAsync: updateConfig }),
  useSaveBrainProviders: () => ({ mutate: saveProviders }),
  useBrainOauthDisconnect: () => ({ mutate: disconnect }),
}));
vi.mock('../../../lib/elowenClient', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    elowenClient: {
      ...(actual.elowenClient as object),
      brainOauthCatalog: vi.fn(() => Promise.resolve({ models: ['claude-opus', 'claude-sonnet'] })),
      brainOauthStart: oauthFlowMocks.start,
      brainOauthFlow: oauthFlowMocks.flow,
      brainProviderProbe: probeMock.probe,
      brainHostedToolSearchStatus: hostedMocks.status,
      brainHostedToolSearchProbe: hostedMocks.probe,
    },
  };
});

import { BrainSection, modelPickerItems } from '../../../modules/settings/BrainSection';
import { BrainProvidersSection } from '../../../modules/settings/BrainProvidersSection';

const renderSection = () => render(<ToastProvider><BrainSection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => {
  saveProviders.mockReset();
  saveProviders.mockImplementation((_providers, options) => options?.onSuccess?.());
  disconnect.mockClear(); updateConfig.mockClear();
  oauthRefetch.mockClear(); rateLimitsRefetch.mockClear();
  RATE_LIMITS = undefined;
  oauthFlowMocks.start.mockClear(); oauthFlowMocks.flow.mockClear(); oauthFlowMocks.pending.resolve = null;
  probeMock.probe.mockClear(); probeMock.pending.length = 0;
  hostedMocks.status.mockReset(); hostedMocks.status.mockResolvedValue({ providers: [] });
  hostedMocks.probe.mockClear();
  (CONFIG.brain.providers as unknown[]).length = 0;
  CONFIG.brain.hiddenOauth.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('BrainSection — OAuth account model picker', () => {
  it('waits for config before seeding hidden OAuth accounts', async () => {
    const hiddenConfig = { ...CONFIG, brain: { ...CONFIG.brain, hiddenOauth: ['oauth-kimi'] } };
    const { rerender } = render(<ToastProvider><BrainProvidersSection config={undefined} /></ToastProvider>, { wrapper: createWrapper().wrapper });

    rerender(<ToastProvider><BrainProvidersSection config={hiddenConfig as unknown as ElowenConfig} /></ToastProvider>);
    await waitFor(() => expect(screen.queryByText(en.brain.types['oauth-kimi'])).toBeNull());
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('provides shared settings groups for the page-owned settings document', () => {
    const { container } = renderSection();

    expect(container.querySelector('[data-settings-document]')).toBeNull();
    expect(container.querySelectorAll('[data-settings-group]')).toHaveLength(3);
    // One row per OAuth account type (Claude, ChatGPT, Copilot, Kimi) plus the provider entries and the
    // three editor rows (Limits, Runtime, Tool loading).
    expect(container.querySelectorAll('.settings-row')).toHaveLength(10);
    expect(container.querySelector('.spatial-group')).toBeNull();
    expect(container.querySelector('.border-y.divide-y')).toBeNull();
  });

  it('renders a configured provider favicon through the brand icon slot', () => {
    hostedMocks.status.mockImplementation(() => new Promise(() => {}));
    (CONFIG.brain.providers as unknown[]).push({
      id: 'coresynth', label: 'CoreSynth', type: 'openai',
      baseUrl: 'https://api.coresynth.io/v1', models: ['model-a'], apiKeySet: true,
    });

    renderSection();
    const row = screen.getByText('CoreSynth').closest('.settings-row');
    const icon = row?.querySelector(".settings-row__icon[data-icon-kind='brand']");

    expect(icon).toBeTruthy();
    expect(icon?.querySelector('img')).toHaveAttribute('src', 'https://coresynth.io/favicon.ico');
  });

  it('shows persisted Azure verification status and probes the exact configured deployment', async () => {
    (CONFIG.brain.providers as unknown[]).push({
      id: 'azure', label: 'Azure production', type: 'openai', api: 'openai-responses',
      baseUrl: 'https://resource.openai.azure.com/openai/v1', models: ['deployment'], apiKeySet: true,
    });
    hostedMocks.status
      .mockResolvedValueOnce({ providers: [hostedProvider('azure', { verifiable: true, effective: 'unverified', models: [{ modelId: 'deployment', status: 'unverified', checkedAt: null }] })] })
      .mockResolvedValue({ providers: [hostedProvider('azure', { verifiable: true, models: [{ modelId: 'deployment', status: 'supported', checkedAt: 1 }] })] });

    renderSection();
    expect(await screen.findByText(en.brain.hostedSearchUnverified)).toBeInTheDocument();
    // The status badge IS the verify control now, so it names the provider it would check rather than
    // sitting beside a second button that said the same thing.
    fireEvent.click(screen.getByRole('button', { name: `${en.brain.hostedSearchVerify}: Azure production` }));
    await waitFor(() => expect(hostedMocks.probe).toHaveBeenCalledWith({ providerId: 'azure', modelId: 'deployment' }));
    await waitFor(() => expect(screen.getAllByText(en.brain.hostedSearchVerified).length).toBeGreaterThan(0));
  });

  it('does not let an older status request overwrite a completed verification', async () => {
    (CONFIG.brain.providers as unknown[]).push({
      id: 'azure', label: 'Azure production', type: 'openai', api: 'openai-responses',
      baseUrl: 'https://resource.openai.azure.com/openai/v1', models: ['deployment'], apiKeySet: true,
    });
    let resolveInitial!: (value: { providers: HostedStatusProvider[] }) => void;
    hostedMocks.status
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValue({ providers: [hostedProvider('azure', { verifiable: true, models: [{ modelId: 'deployment', status: 'supported', checkedAt: 1 }] })] });

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: `${en.brain.hostedSearchVerify}: Azure production` }));
    await waitFor(() => expect(screen.getAllByText(en.brain.hostedSearchVerified).length).toBeGreaterThan(0));
    await act(async () => resolveInitial({ providers: [hostedProvider('azure', { verifiable: true, effective: 'unverified', models: [{ modelId: 'deployment', status: 'unverified', checkedAt: null }] })] }));
    expect(screen.queryByText(en.brain.hostedSearchUnverified)).not.toBeInTheDocument();
  });

  it('offers the native tool search switch only where the daemon reports a hosted route', async () => {
    (CONFIG.brain.providers as unknown[]).push(
      { id: 'openai', label: 'OpenAI', type: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.5'], apiKeySet: true },
      { id: 'relay', label: 'Relay', type: 'openai', api: 'openai-responses', baseUrl: 'https://openrouter.ai/api/v1', models: ['gpt-5.5'], apiKeySet: true },
    );
    hostedMocks.status.mockResolvedValue({ providers: [
      hostedProvider('openai', { models: [{ modelId: 'gpt-5.5', status: 'supported', checkedAt: null }] }),
      hostedProvider('anthropic'),
    ] });

    renderSection();
    // The connected Claude account carries one too — its entry id is the built-in provider name, which is
    // what the daemon reports the account's hosted status under.
    expect(await screen.findByRole('button', { name: `${en.brain.hostedSearchSettings}: ${en.brain.types['oauth-anthropic']}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${en.brain.hostedSearchSettings}: OpenAI` })).toBeInTheDocument();
    // A relay speaking the same wire API has no hosted route to switch off, so it gets no switch at all.
    expect(screen.queryByRole('button', { name: `${en.brain.hostedSearchSettings}: Relay` })).toBeNull();
    // A disconnected account is absent from the daemon's list for the same reason.
    expect(screen.queryByRole('button', { name: `${en.brain.hostedSearchSettings}: ${en.brain.types['oauth-github-copilot']}` })).toBeNull();
  });

  it('keeps the subscription meters when the account also carries the tool search switch', async () => {
    // The gear once took the row's `control` slot, and SettingsRow treats `children` as a mere alias of
    // it — so the usage rail passed as children silently vanished on every connected account. The meters
    // are the record's value; the gear is an action beside manage and disconnect.
    RATE_LIMITS = { anthropic: { provider: 'anthropic', planType: 'max', windows: [{ usedPercent: 31, windowMinutes: 300, resetsAt: null }], fetchedAt: Date.now(), stale: false } };
    hostedMocks.status.mockResolvedValue({ providers: [hostedProvider('anthropic')] });

    renderSection();
    const gear = await screen.findByRole('button', { name: `${en.brain.hostedSearchSettings}: ${en.brain.types['oauth-anthropic']}` });
    const row = gear.closest('.settings-row')!;
    expect(row.querySelectorAll('[data-testid="oauth-usage-window"]')).toHaveLength(1);
    expect(gear.closest('.settings-row__actions')).not.toBeNull();
    expect(row.querySelector('.settings-row__control')?.querySelector('[data-testid="oauth-usage-window"]')).not.toBeNull();
  });

  it('opens the switch popover with focus on the switch, not on the help tip', async () => {
    hostedMocks.status.mockResolvedValue({ providers: [hostedProvider('anthropic')] });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: `${en.brain.hostedSearchSettings}: ${en.brain.types['oauth-anthropic']}` }));
    const dialog = await screen.findByRole('dialog', { name: en.brain.hostedSearchTitle });
    // Radix autofocuses the first tabbable in the panel; a HelpTip there opens its tooltip over the panel.
    await waitFor(() => expect(within(dialog).getByRole('switch')).toHaveFocus());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('turns the native tool search off through the provider save path and reports the state', async () => {
    (CONFIG.brain.providers as unknown[]).push({
      id: 'openai', label: 'OpenAI', type: 'openai', api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.5'], apiKeySet: true,
    });
    hostedMocks.status
      .mockResolvedValueOnce({ providers: [hostedProvider('openai', { models: [{ modelId: 'gpt-5.5', status: 'supported', checkedAt: null }] })] })
      .mockResolvedValue({ providers: [hostedProvider('openai', { enabled: false, effective: 'off', models: [{ modelId: 'gpt-5.5', status: 'supported', checkedAt: null }] })] });

    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: `${en.brain.hostedSearchSettings}: OpenAI` }));
    const toggle = await screen.findByRole('switch', { name: `${en.brain.hostedSearchTitle}: OpenAI` });
    expect(toggle).toBeChecked();
    expect(screen.getByText(en.brain.hostedSearchActive)).toBeInTheDocument();

    fireEvent.click(toggle);
    // Saved as a field on the provider row through the ordinary providers PUT — no endpoint of its own,
    // and no API key round-tripped back to the daemon.
    await waitFor(() => expect(saveProviders).toHaveBeenCalledWith([expect.objectContaining({
      id: 'openai', hostedToolSearchEnabled: false,
    })], expect.anything()));
    expect(saveProviders.mock.calls[0]?.[0][0]).not.toHaveProperty('apiKeySet');
    await waitFor(() => expect(screen.getByText(en.brain.hostedSearchOff)).toBeInTheDocument());
    expect(screen.getByRole('switch', { name: `${en.brain.hostedSearchTitle}: OpenAI` })).not.toBeChecked();
  });

  it('turns it back on by omitting the field rather than sending true', async () => {
    (CONFIG.brain.providers as unknown[]).push({
      id: 'openai', label: 'OpenAI', type: 'openai', api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.5'], apiKeySet: true, hostedToolSearchEnabled: false,
    });
    hostedMocks.status.mockResolvedValue({ providers: [hostedProvider('openai', {
      enabled: false, effective: 'off', models: [{ modelId: 'gpt-5.5', status: 'supported', checkedAt: null }],
    })] });

    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: `${en.brain.hostedSearchSettings}: OpenAI` }));
    fireEvent.click(await screen.findByRole('switch', { name: `${en.brain.hostedSearchTitle}: OpenAI` }));

    // Absent IS "on": the daemon stores no value meaning enabled, so a `true` would be dropped anyway and
    // sending one would suggest the client can grant a route it cannot.
    await waitFor(() => expect(saveProviders).toHaveBeenCalled());
    expect(saveProviders.mock.calls[0]?.[0][0]).not.toHaveProperty('hostedToolSearchEnabled');
  });

  it('creates the account entry the switch needs when the OAuth account has none', async () => {
    hostedMocks.status.mockResolvedValue({ providers: [hostedProvider('anthropic')] });

    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: `${en.brain.hostedSearchSettings}: ${en.brain.types['oauth-anthropic']}` }));
    fireEvent.click(await screen.findByRole('switch', { name: `${en.brain.hostedSearchTitle}: ${en.brain.types['oauth-anthropic']}` }));

    await waitFor(() => expect(saveProviders).toHaveBeenCalledWith([{
      id: 'anthropic', label: en.brain.types['oauth-anthropic'], type: 'oauth-anthropic',
      baseUrl: '', models: [], hostedToolSearchEnabled: false,
    }], expect.anything()));
  });

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

  it('keeps a still-selected model that dropped out of the live catalog so it can be un-checked', () => {
    // Regression: a model removed from the provider's API used to vanish from the picker while staying in
    // the saved selection — active, listed in Models, with no way to turn it off. It must now appear under
    // the "unavailable" group so the user can un-check it (after which it is gone from the selection).
    const items = modelPickerItems(['claude-opus', 'claude-sonnet'], ['claude-opus', 'claude-gone'], 'No longer in the catalog');
    const gone = items.find((i) => i.id === 'claude-gone');
    expect(gone).toBeTruthy();
    expect(gone!.group).toBe('unavailable');
    expect(gone!.groupLabel).toBe('No longer in the catalog');
    // A live model stays ungrouped at the top, listed once (no duplicate for a selected-and-live model).
    expect(items.filter((i) => i.id === 'claude-opus')).toEqual([expect.objectContaining({ group: '' })]);
    // A live but unselected model is still offered.
    expect(items.some((i) => i.id === 'claude-sonnet')).toBe(true);
  });

  it('ignores a connect poll that resolves after the dialog was cancelled, and calls cancelling no failure', async () => {
    // Regression: cancelling only cleared the interval, so a poll already in flight still settled the
    // flow — the cancelled account was reported connected (success toast + usage refetch) seconds later.
    // Cancelling is also not an error: closing the dialog must not raise the red "connect failed" toast.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderSection();
    fireEvent.click(screen.getAllByRole('button', { name: en.brain.connect })[0]);
    // The dialog carries its title as its accessible name, so it is addressable by role.
    await waitFor(() => expect(screen.getByRole('dialog', { name: en.brain.connectTitle })).toBeInTheDocument());

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(oauthFlowMocks.flow).toHaveBeenCalled();

    const resolvePoll = pendingPoll();
    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }));
    await act(async () => { resolvePoll({ id: 'flow-1', status: 'success' }); });

    expect(rateLimitsRefetch).not.toHaveBeenCalled();
    expect(screen.queryByText(en.brain.connectedToast)).toBeNull();
    expect(screen.queryByText(en.brain.connectFailed)).toBeNull();
  });

  it('waits for a connect poll to answer before scheduling the next one', async () => {
    // On a fixed interval a slow poll is still in flight when the next one fires, and the older answer
    // landing last briefly pushes the dialog back to a state the flow has already left.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderSection();
    fireEvent.click(screen.getAllByRole('button', { name: en.brain.connect })[0]);
    await waitFor(() => expect(screen.getByRole('dialog', { name: en.brain.connectTitle })).toBeInTheDocument());

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(oauthFlowMocks.flow).toHaveBeenCalledTimes(1);
    // Two more interval ticks pass while the first poll is still unanswered — no overlapping poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(oauthFlowMocks.flow).toHaveBeenCalledTimes(1);

    // Once it answers, polling resumes on the same cadence.
    await act(async () => { pendingPoll()({ id: 'flow-1', status: 'action-required' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(oauthFlowMocks.flow).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest probed catalog when the abandoned endpoint answers last', async () => {
    // Regression: the debounce cleanup did not reach a probe already in flight, so a slow answer for an
    // endpoint the operator had edited away could overwrite the catalog of the URL now in the field.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: en.brain.addProvider }));
    const url = screen.getByPlaceholderText('https://ai.example.com/v1');

    fireEvent.change(url, { target: { value: 'https://old.example/v1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    fireEvent.change(url, { target: { value: 'https://new.example/v1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    // Answers land in the opposite order: the current endpoint first, the abandoned one after it.
    await act(async () => { probeFor('https://new.example/v1')({ models: ['new-model'] }); });
    await act(async () => { probeFor('https://old.example/v1')({ models: ['old-model'] }); });

    // The summary's button carries the selection it manages in its own name, so it does not answer to
    // the enclosing field's label.
    fireEvent.click(screen.getByRole('button', { name: `${en.managePicker.manage}: ${en.brain.models}` }));
    expect(await screen.findByRole('button', { name: 'new-model' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'old-model' })).toBeNull();
  });

  it('uses the optional temperature slider in the provider form and preserves zero', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: en.brain.addProvider }));
    fireEvent.click(screen.getByRole('radio', { name: en.brain.types.anthropic }));
    fireEvent.change(screen.getByPlaceholderText('CoreSynth Proxy'), { target: { value: 'Anthropic direct' } });

    expect(screen.queryByRole('spinbutton')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: en.brain.compatibility.temperatureOverride }));
    const slider = screen.getByRole('slider', { name: en.brain.temperature });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider).toHaveAttribute('aria-valuetext', '0.8');
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider).toHaveAttribute('aria-valuetext', '0.0');

    fireEvent.click(screen.getByRole('button', { name: en.common.save }));
    const payload = saveProviders.mock.calls.at(-1)![0] as { label: string; temperature?: number }[];
    expect(payload).toContainEqual(expect.objectContaining({ label: 'Anthropic direct', temperature: 0 }));
  });

  it('keeps the complete provider draft open after a failed save and blocks duplicate submits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let saveOptions: { onError?: () => void } | undefined;
    saveProviders.mockImplementation((_providers, options) => { saveOptions = options; });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: en.brain.addProvider }));

    fireEvent.change(screen.getByPlaceholderText('CoreSynth Proxy'), { target: { value: 'Failure relay' } });
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'secret-token' } });
    fireEvent.change(screen.getByRole('textbox', { name: en.brain.models }), { target: { value: 'model-a\nmodel-b' } });
    fireEvent.click(screen.getByText(en.brain.compatibility.title).closest('button')!);
    fireEvent.click(screen.getByRole('switch', { name: en.brain.compatibility.temperatureOverride }));
    fireEvent.keyDown(screen.getByRole('slider', { name: en.brain.temperature }), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('switch', { name: en.brain.compatibility.supportsLongCacheRetention }));
    fireEvent.click(screen.getByRole('button', { name: en.common.done }));

    const endpoint = screen.getByPlaceholderText('https://ai.example.com/v1');
    fireEvent.change(endpoint, { target: { value: 'https://relay.example/v1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    await act(async () => { probeFor('https://relay.example/v1')({ models: [] }); });

    const saveButton = screen.getByRole('button', { name: en.common.save });
    fireEvent.click(saveButton);
    expect(saveProviders).toHaveBeenCalledTimes(1);
    expect(saveButton).toBeDisabled();
    fireEvent.click(saveButton);
    expect(saveProviders).toHaveBeenCalledTimes(1);

    await act(async () => { saveOptions?.onError?.(); });
    expect(screen.getByRole('dialog', { name: en.brain.addProvider })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Failure relay')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://relay.example/v1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('secret-token')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: en.brain.models })).toHaveValue('model-a\nmodel-b');

    fireEvent.click(screen.getByText(en.brain.compatibility.title).closest('button')!);
    expect(screen.getByRole('switch', { name: en.brain.compatibility.supportsLongCacheRetention })).toBeChecked();
    expect(screen.getByRole('slider', { name: en.brain.temperature })).toHaveAttribute('aria-valuetext', '0.8');
    expect(screen.getByText(en.brain.providerSaveError)).toBeInTheDocument();
  });

  it('closes the provider form only after a successful save', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: en.brain.addProvider }));
    fireEvent.click(screen.getByRole('radio', { name: en.brain.types.anthropic }));
    fireEvent.change(screen.getByPlaceholderText('CoreSynth Proxy'), { target: { value: 'Saved provider' } });
    fireEvent.click(screen.getByRole('button', { name: en.common.save }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: en.brain.addProvider })).toBeNull());
  });

  it('names the provider dialog for assistive technology', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: en.brain.addProvider }));
    expect(screen.getByRole('dialog', { name: en.brain.addProvider })).toBeInTheDocument();
  });

  it('confirms before disconnecting an OAuth account', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: `${en.brain.disconnect}: ${en.brain.types['oauth-anthropic']}` }));
    expect(disconnect).not.toHaveBeenCalled();
    expect(screen.getByText(interpolate(en.brain.disconnectConfirm, { provider: en.brain.types['oauth-anthropic'], agentName: 'Elowen' }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.brain.disconnect }));
    expect(disconnect).toHaveBeenCalledWith('oauth-anthropic', expect.any(Object));
  });

  it('saves a memory-retention edit through the runtime draft autosave', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: en.brain.retention.manage }));
    expect(screen.getByRole('dialog', { name: en.brain.retention.title })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('slider', { name: en.brain.retention.graceDays }), { key: 'ArrowRight' });
    // The RuntimeLimits-style autosave PUTs the whole runtime block after the debounce — retention included.
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({
        memoryRetention: expect.objectContaining({ graceDays: 15 }),
      }),
    })), { timeout: 3000 });
  });
});
