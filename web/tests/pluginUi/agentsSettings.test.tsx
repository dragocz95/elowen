import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ensurePluginUiRuntime } from '../../lib/pluginUi';
import { AgentsSettings } from '../../../plugins/agents/web-src/settings/AgentsSettings';
import { CliAgentsSettings } from '../../../plugins/agents/web-src/settings/CliAgentsSettings';
import { GithubSettings } from '../../../plugins/agents/web-src/settings/GithubSettings';
import manifest from '../../../plugins/agents/elowen-plugin.json';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

// The moved sections resolve everything through window.ElowenUiRuntime — install the REAL runtime,
// so this exercises the production contract the bundle runs against.
ensurePluginUiRuntime();

// View copy is served per-plugin by /plugins/ui; serving the REAL manifest en fallback keeps the
// assertions in lockstep with what production users see.
const strings = (manifest as { web: { strings: Record<string, string> } }).web.strings;

let putBody: unknown = null;
let patchBody: unknown = null;
const server = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json([{ name: 'agents', url: '/plugins/agents/web/index.js', apiVersion: 1, nav: [], settings: [], strings }])),
  http.get('*/api/config', () => HttpResponse.json({
    allowedExecs: ['sonnet', 'codex:gpt-5.4'], customModels: [],
    autopilot: { model: 'mimo-v2.5', apiUrl: 'https://relay.example/v1', apiKeySet: false, notes: 'mind the guardrails' },
    providers: { 'claude-code': { bin: 'claude', args: '' }, opencode: { bin: 'opencode', args: '' }, codex: { bin: 'codex', args: '' } },
    defaults: { exec: 'sonnet', autonomy: 'L1', maxSessions: 1 }, security: { tokenTtlDays: 30 },
  })),
  http.put('*/api/config', async ({ request }) => { putBody = await request.json(); return HttpResponse.json({ ok: true }); }),
  http.get('*/api/brain/models', () => HttpResponse.json([])),
  http.get('*/api/system/skills', () => HttpResponse.json({ skills: [{ provider: 'claude-code', present: true, installed: true, upToDate: false }, { provider: 'codex', present: false, installed: false, upToDate: false }] })),
  // The plugin-config sub-section (overseer model + PR keys) AND the AutopilotSection's agents-only
  // knobs (pilot/overseer execs, review/TDD toggles — plugin slice since config wave 2) fetch the
  // plugin detail; saves go through PATCH /plugins/agents/config.
  http.get('*/api/plugins/agents', () => HttpResponse.json({ name: 'agents', config: { overseerModel: '', pilotExec: '', overseerExec: '', reviewOnDone: false, tddMode: false }, configSchema: [{ key: 'overseerModel', type: 'string', label: 'Overseer model' }], i18n: {} })),
  http.patch('*/api/plugins/agents/config', async ({ request }) => { patchBody = await request.json(); return HttpResponse.json({ ok: true }); }),
  // The GitHub section's live banner reads the plugin's own probe (a root mount of this plugin).
  http.get('*/api/integrations/github-status', () => HttpResponse.json({
    ghInstalled: true, ghAuthenticated: true, account: 'dragocz95', tokenSet: false, ready: true, method: 'gh',
  })),
);
beforeEach(() => { putBody = null; patchBody = null; });
beforeAll(() => server.listen()); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('agents plugin settings — Autopilot section', () => {
  it('defaults to Relay mode and saves relay fields (execs cleared)', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><AgentsSettings surface="deck" plugin="agents" params={{ id: 'agents' }} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('How autopilot reasons')).toBeTruthy());
    expect(screen.getByText('Planner model')).toBeTruthy(); // same role labels in both modes
    expect(screen.getByDisplayValue('mind the guardrails')).toBeTruthy(); // notes edit inline (no drawer)

    // Auto-persist: nudging any autopilot field saves shortly after (no Save button for the section).
    // The relay credentials PUT the main config; the agents-only knobs PATCH the plugin slice.
    fireEvent.change(screen.getByPlaceholderText('claude-opus-4-8'), { target: { value: 'relay-model-x' } });
    await waitFor(() => {
      const ap = (putBody as { autopilot: { model: string } }).autopilot;
      expect(ap.model).toBe('relay-model-x');
      const values = (patchBody as { values: { pilotExec: string; overseerExec: string } }).values;
      expect(values.pilotExec).toBe(''); // relay mode clears the agent execs (plugin slice)
      expect(values.overseerExec).toBe('');
    });
  });

  it('switching to CLI Tools seeds and saves agent execs', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><AgentsSettings surface="deck" plugin="agents" params={{ id: 'agents' }} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('How autopilot reasons')).toBeTruthy());

    fireEvent.click(screen.getByText('CLI Tools')); // mode toggle — auto-persists the agent execs
    expect(screen.getByText('Planner model')).toBeTruthy(); // unified label in both modes
    await waitFor(() => {
      const values = (patchBody as { values: { pilotExec: string; overseerExec: string; reviewOnDone: boolean } }).values;
      expect(values.pilotExec).not.toBe(''); // seeded with a default model on switch (plugin slice)
      expect(values.overseerExec).not.toBe('');
      expect(values.reviewOnDone).toBe(false);
    });
  });

  it('toggles TDD mission mode and persists the plugin-slice tddMode', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><AgentsSettings surface="deck" plugin="agents" params={{ id: 'agents' }} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('How autopilot reasons')).toBeTruthy());

    const toggle = screen.getByRole('switch', { name: 'TDD mission mode' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect((patchBody as { values: { tddMode: boolean } }).values.tddMode).toBe(true));
  });

  it('saves the run defaults (executor/autonomy/max sessions) as their own PUT', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><AgentsSettings surface="deck" plugin="agents" params={{ id: 'agents' }} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('Autonomy')).toBeTruthy());

    fireEvent.click(screen.getByRole('radio', { name: 'L3' }));
    await waitFor(() => {
      const body = putBody as { defaults: { autonomy: string; exec: string; maxSessions: number }; autopilot?: unknown };
      expect(body.defaults).toEqual({ exec: 'sonnet', autonomy: 'L3', maxSessions: 1 });
      expect(body.autopilot).toBeUndefined(); // defaults save alone, not bundled with autopilot
    });
  });

  it('renders the plugin-config sub-section below the autopilot rows', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><AgentsSettings surface="deck" plugin="agents" params={{ id: 'agents' }} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('Overseer model')).toBeTruthy()); // from configSchema
  });
});

describe('agents plugin settings — CLI Agents section', () => {
  it('renders provider rows and persists an edited binary under providers', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><CliAgentsSettings surface="deck" plugin="agents" params={{ id: 'cli-agents' }} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeTruthy());

    const bins = screen.getAllByPlaceholderText('claude');
    fireEvent.change(bins[0], { target: { value: '/usr/local/bin/claude' } });
    await waitFor(() => {
      const p = (putBody as { providers: Record<string, { bin: string }> }).providers;
      expect(p['claude-code'].bin).toBe('/usr/local/bin/claude');
    });
  });

  it('shows per-provider skill status badges from /system/skills', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><CliAgentsSettings surface="deck" plugin="agents" params={{ id: 'cli-agents' }} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('outdated')).toBeTruthy()); // present+installed, not upToDate
    expect(screen.getByText('not on this machine')).toBeTruthy();
    // An update is available (outdated) → the install button is enabled.
    expect(screen.getByRole('button', { name: 'Install / Update' })).toBeEnabled();
  });
});

describe('agents plugin settings — GitHub section', () => {
  it('renders the live auth banner from the plugin\'s own probe', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><GithubSettings surface="deck" plugin="agents" params={{ id: 'github' }} /></ToastProvider></Wrapper>);
    expect(await screen.findByText('GitHub ready — pushing as @dragocz95 via the gh CLI')).toBeTruthy();
  });

  it('saves prEnabled into the plugin config slice and omits an untouched token', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><GithubSettings surface="deck" plugin="agents" params={{ id: 'github' }} /></ToastProvider></Wrapper>);
    const toggle = await screen.findByRole('switch', { name: 'PR workflow' });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => {
      const values = (patchBody as { values: Record<string, unknown> }).values;
      expect(values.prEnabled).toBe(true);
      // A secret field arriving empty would CLEAR the stored token, so it is omitted, not sent blank.
      expect('ghToken' in values).toBe(false);
    });
    expect(putBody).toBeNull(); // nothing of this section belongs to the main config
  });

  it('sends a freshly typed token with the same save and then clears the input', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><GithubSettings surface="deck" plugin="agents" params={{ id: 'github' }} /></ToastProvider></Wrapper>);
    await screen.findByRole('switch', { name: 'PR workflow' });

    // Two controls carry the label in the orbital layout: the pod's orb and the hidden manage button
    // the selection surface uses. Either opens the drawer — the orb is the one a user clicks.
    fireEvent.click(screen.getAllByRole('button', { name: 'GitHub token' })[0]!); // opens the edit drawer
    const input = screen.getByLabelText('GitHub token', { selector: 'input' });
    fireEvent.change(input, { target: { value: 'ghp_typed_secret' } });
    await waitFor(() => {
      const values = (patchBody as { values: Record<string, unknown> }).values;
      expect(values.ghToken).toBe('ghp_typed_secret');
    });
    await waitFor(() => expect(input).toHaveValue(''));
  });
});

describe('agents plugin settings — declared vs registered', () => {
  it('every settings section the manifest declares has a component in the bundle', async () => {
    // The manifest is what draws the rail entry; a declared id with no component renders the
    // "settings unavailable" placeholder to a user who clicked a section that looks real.
    const registered: Record<string, unknown> = {};
    (window as unknown as { __elowenRegisterPluginUi?: (p: string, r: { settings?: Record<string, unknown> }) => void })
      .__elowenRegisterPluginUi = (_plugin, reg) => { Object.assign(registered, reg.settings ?? {}); };
    await import('../../../plugins/agents/web-src/index');

    const declared = (manifest as { web: { settings: { id: string; layout?: string }[] } }).web.settings;
    expect(declared.map((s) => s.id).filter((id) => !(id in registered))).toEqual([]);
  });

  it('the GitHub section declares the orbital layout it had as a core category', () => {
    // Moved, not redesigned: without this declaration the panel would render the same rows as a
    // classic stack, which is a visible change to a section nobody asked to redesign.
    const declared = (manifest as { web: { settings: { id: string; layout?: string }[] } }).web.settings;
    expect(declared.find((s) => s.id === 'github')?.layout).toBe('orbital');
  });
});
