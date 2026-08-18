import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { interpolate } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';

const saveProviders = vi.fn();
const disconnect = vi.fn();
const updateConfig = vi.fn(() => Promise.resolve(CONFIG));
const CONFIG = {
  brain: { providers: [], agentName: 'Elowen', maxSteps: 20 },
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
const hostedMocks = vi.hoisted(() => ({
  status: vi.fn<() => Promise<{ providers: { providerId: string; models: { modelId: string; status: 'supported' | 'unsupported' | 'unverified'; checkedAt: number | null }[] }[] }>>()
    .mockResolvedValue({ providers: [] }),
  probe: vi.fn<() => Promise<{ providerId: string; modelId: string; status: 'supported' | 'unsupported' | 'error'; reason: string; checkedAt: number }>>()
    .mockResolvedValue({ providerId: 'azure', modelId: 'deployment', status: 'supported', reason: 'server_search_and_replay_ok', checkedAt: 1 }),
}));

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
  useBrainRateLimitsAll: () => ({ data: undefined, refetch: rateLimitsRefetch }),
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

const renderSection = () => render(<ToastProvider><BrainSection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => {
  saveProviders.mockClear(); disconnect.mockClear(); updateConfig.mockClear();
  oauthRefetch.mockClear(); rateLimitsRefetch.mockClear();
  oauthFlowMocks.start.mockClear(); oauthFlowMocks.flow.mockClear(); oauthFlowMocks.pending.resolve = null;
  probeMock.probe.mockClear(); probeMock.pending.length = 0;
  hostedMocks.status.mockReset(); hostedMocks.status.mockResolvedValue({ providers: [] });
  hostedMocks.probe.mockClear();
  (CONFIG.brain.providers as unknown[]).length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('BrainSection — OAuth account model picker', () => {
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

  it('shows persisted Azure verification status and probes the exact configured deployment', async () => {
    (CONFIG.brain.providers as unknown[]).push({
      id: 'azure', label: 'Azure production', type: 'openai', api: 'openai-responses',
      baseUrl: 'https://resource.openai.azure.com/openai/v1', models: ['deployment'], apiKeySet: true,
    });
    hostedMocks.status
      .mockResolvedValueOnce({ providers: [{ providerId: 'azure', models: [{ modelId: 'deployment', status: 'unverified', checkedAt: null }] }] })
      .mockResolvedValue({ providers: [{ providerId: 'azure', models: [{ modelId: 'deployment', status: 'supported', checkedAt: 1 }] }] });

    renderSection();
    expect(await screen.findByText(en.brain.hostedSearchUnverified)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.brain.hostedSearchVerify }));
    await waitFor(() => expect(hostedMocks.probe).toHaveBeenCalledWith({ providerId: 'azure', modelId: 'deployment' }));
    await waitFor(() => expect(screen.getAllByText(en.brain.hostedSearchVerified).length).toBeGreaterThan(0));
  });

  it('does not let an older status request overwrite a completed verification', async () => {
    (CONFIG.brain.providers as unknown[]).push({
      id: 'azure', label: 'Azure production', type: 'openai', api: 'openai-responses',
      baseUrl: 'https://resource.openai.azure.com/openai/v1', models: ['deployment'], apiKeySet: true,
    });
    let resolveInitial!: (value: { providers: { providerId: string; models: { modelId: string; status: 'unverified'; checkedAt: null }[] }[] }) => void;
    hostedMocks.status
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValue({ providers: [{ providerId: 'azure', models: [{ modelId: 'deployment', status: 'supported', checkedAt: 1 }] }] });

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: en.brain.hostedSearchVerify }));
    await waitFor(() => expect(screen.getAllByText(en.brain.hostedSearchVerified).length).toBeGreaterThan(0));
    await act(async () => resolveInitial({ providers: [{ providerId: 'azure', models: [{ modelId: 'deployment', status: 'unverified', checkedAt: null }] }] }));
    expect(screen.queryByText(en.brain.hostedSearchUnverified)).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: en.managePicker.manage }));
    expect(await screen.findByRole('button', { name: 'new-model' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'old-model' })).toBeNull();
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

    fireEvent.change(screen.getByRole('slider', { name: en.brain.retention.graceDays }), { target: { value: '30' } });
    // The RuntimeLimits-style autosave PUTs the whole runtime block after the debounce — retention included.
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      runtime: expect.objectContaining({
        memoryRetention: expect.objectContaining({ graceDays: 30 }),
      }),
    })), { timeout: 3000 });
  });
});
