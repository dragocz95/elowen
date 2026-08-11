import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/settings', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import SettingsPage from '../../app/settings/page';
import { SkillsEditor } from '../../modules/settings/SkillsEditor';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';
import { en } from '../../lib/i18n/dictionaries/en';

let putBody: unknown = null;
const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'codex:gpt-5.4'], customModels: [], autopilot: { model: 'mimo-v2.5', apiUrl: 'https://relay.example/v1', apiKeySet: false, notes: '' }, providers: { 'claude-code': { bin: 'claude', args: '' }, opencode: { bin: 'opencode', args: '' }, codex: { bin: 'codex', args: '' } }, defaults: { exec: 'sonnet', autonomy: 'L1', maxSessions: 1 }, security: { tokenTtlDays: 30 } })),
  http.get('*/api/system', () => HttpResponse.json({
    version: '0.26.0', latest: '0.26.0', updateAvailable: false, autoUpdate: false, lastUpdatedAt: '2026-07-11T12:00:00.000Z',
    diagnostics: { cpuPercent: 12, memoryUsedBytes: 3_200_000_000, memoryTotalBytes: 16_000_000_000, uptimeSeconds: 1_098_000 },
  })),
  http.get('*/api/system/skills', () => HttpResponse.json({ skills: [] })),
  http.put('*/api/config', async ({ request }) => { putBody = await request.json(); return HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], autopilot: { model: 'mimo-v2.5', apiUrl: 'https://relay.example/v1', apiKeySet: false, notes: '' }, defaults: { exec: 'sonnet', autonomy: 'L1', maxSessions: 1 }, security: { tokenTtlDays: 30 } }); }),
);
beforeEach(() => localStorage.setItem('elowen.settings.category', 'models'));
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
  window.history.replaceState(null, '', '/settings');
}); afterAll(() => server.close());

describe('SettingsPage', () => {
  it('matches the reference section order and renders real System diagnostics in one control deck', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);

    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
    const rail = screen.getByRole('radiogroup', { name: 'Settings sections' });
    expect(Array.from(rail.querySelectorAll('[role="radio"]')).map((node) => node.textContent)).toEqual([
      'System', 'Elowen AI', 'Models', 'CLI Agents', 'Plugins', 'GitHub', 'Autopilot', 'Memory', 'Data',
    ]);
    expect(screen.getByText('System diagnostics')).toBeInTheDocument();
    expect(screen.getByText('12%')).toBeInTheDocument();

    // Constellation: the service/security rows orbit as one cosmos; only the diagnostics widget
    // keeps a classic group frame.
    const systemPanel = screen.getByText('System diagnostics').closest('[data-settings-panel="system"]');
    expect(systemPanel?.querySelectorAll('[data-testid="cosmos"]')).toHaveLength(1);
    expect(systemPanel?.querySelectorAll('[data-settings-group]')).toHaveLength(1);
    expect(screen.getByText('System diagnostics').closest('[data-settings-group]')).toHaveClass('settings-diagnostics');
  });

  it('renders every settings section inside the same document contract', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);

    await screen.findByRole('heading', { level: 1, name: 'System' });
    for (const name of ['System', 'Elowen AI', 'Models', 'CLI Agents', 'Plugins', 'GitHub', 'Autopilot', 'Memory', 'Data']) {
      fireEvent.click(screen.getByRole('radio', { name }));
      await waitFor(() => {
        const activePanel = container.querySelector(`[data-settings-panel]:not([style*="display: none"])`);
        expect(activePanel?.querySelectorAll(':scope > [data-settings-document]')).toHaveLength(1);
      });
    }
  });

  it('auto-saves a changed model allowlist on toggle (no manual save button)', async () => {
    putBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());
    // Models auto-persist: a toggle PUTs immediately, no separate "Save models" button.
    expect(screen.queryByRole('button', { name: 'Save models' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Claude Sonnet 4.5')); // uncheck sonnet → auto-saves
    await waitFor(() => expect((putBody as { allowedExecs: string[] }).allowedExecs).not.toContain('sonnet'));
  });

  it('auto-save sends customModels in the PUT body', async () => {
    putBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());
    fireEvent.click(screen.getByLabelText('Claude Sonnet 4.5')); // any change triggers the PUT
    await waitFor(() => expect((putBody as { customModels: unknown }).customModels).toBeDefined());
    expect(Array.isArray((putBody as { customModels: unknown[] }).customModels)).toBe(true);
  });

  it('edits a model description and persists it under modelNotes', async () => {
    putBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());
    // Rows are grouped by provider (claude-code first), so the first row is Sonnet.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add description' })[0]);
    // The note modal auto-saves on edit — no manual Save button; the change PUTs shortly after.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Model description' }), { target: { value: 'Strong at refactoring' } });
    await waitFor(() => expect((putBody as { modelNotes: Record<string, string> }).modelNotes).toMatchObject({ sonnet: 'Strong at refactoring' }));
  });

  it('renders the Add model affordance', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());
    expect(screen.getByRole('button', { name: 'Add model' })).toBeTruthy();
  });

  it('filters model rows from the search above provider groups', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());

    const search = screen.getByRole('searchbox', { name: 'Search models…' });
    expect(screen.getAllByTestId('model-row').length).toBeGreaterThan(1);

    fireEvent.change(search, { target: { value: 'GPT 5.5' } });
    expect(screen.getByText('GPT 5.5')).toBeTruthy();
    expect(screen.queryByText('Claude Sonnet 4.5')).toBeNull();

    fireEvent.change(search, { target: { value: 'nothing-matches-this' } });
    expect(screen.getByText('No models match this search.')).toBeTruthy();
    expect(screen.queryAllByTestId('model-row')).toHaveLength(0);
  });

  it('retains a visited settings document and its search state across category switches', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    const search = await screen.findByRole('searchbox', { name: 'Search models…' });
    fireEvent.change(search, { target: { value: 'sonnet' } });

    fireEvent.click(screen.getByRole('radio', { name: 'Autopilot' }));
    await waitFor(() => expect(search).not.toBeVisible());

    fireEvent.click(screen.getByRole('radio', { name: 'Models' }));
    await waitFor(() => expect(search).toBeVisible());
    expect(screen.getByRole('searchbox', { name: 'Search models…' })).toBe(search);
    expect(search).toHaveValue('sonnet');
  });

  it('add-model modal opens on click and sends customModels with the new entry on save', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    // Modal: fill label, pick the "Other" provider, type a raw exec string.
    fireEvent.change(screen.getByPlaceholderText('My Model'), { target: { value: 'My Custom Model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    fireEvent.change(screen.getByPlaceholderText('provider/model-name'), { target: { value: 'my/custom' } });
    putBody = null;
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // The new model card should now be in the DOM (Toggle is labelled by the model label).
    await waitFor(() => expect(screen.getByLabelText('My Custom Model')).toBeTruthy());

    // Adding the model auto-persists — no separate "Save models" click needed.
    await waitFor(() => {
      const body = putBody as { customModels: { label: string; exec: string }[] };
      expect(body.customModels).toContainEqual({ label: 'My Custom Model', exec: 'my/custom' });
    });
  });

  it('renders the section selected by the persisted category key', async () => {
    // The category picker now lives in the main sidebar; the page reads the active section from the
    // persisted `elowen.settings.category` key (and the `?cat=` deep-link). Setting it selects the section.
    localStorage.setItem('elowen.settings.category', 'autopilot');
    const { wrapper: Wrapper } = createWrapper();
    const { unmount } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('How autopilot reasons')).toBeTruthy());
    unmount();

    // The default executor / autonomy / max-sessions cards moved under Autopilot (they are the
    // pilot's run defaults), so the Executor card now renders in the autopilot section.
    localStorage.setItem('elowen.settings.category', 'autopilot');
    const { wrapper: Wrapper2 } = createWrapper();
    render(<Wrapper2><ToastProvider><SettingsPage /></ToastProvider></Wrapper2>);
    await waitFor(() => expect(screen.getByText('Executor')).toBeTruthy());
  });

  it('defaults to Relay mode and saves relay fields (execs cleared)', async () => {
    localStorage.setItem('elowen.settings.category', 'autopilot');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('How autopilot reasons')).toBeTruthy());
    expect(screen.getByText('How autopilot reasons')).toBeTruthy();
    expect(screen.getByText('Planner model')).toBeTruthy(); // same role labels in both modes

    // Auto-persist: nudging any autopilot field saves shortly after (no Save button exists).
    // The free-text planner model edits in the shared Autopilot drawer — open it via the pod first.
    putBody = null;
    fireEvent.click(screen.getAllByRole('button', { name: 'Planner model' })[0]);
    fireEvent.change(await screen.findByPlaceholderText('claude-opus-4-8'), { target: { value: 'relay-model-x' } });
    await waitFor(() => {
      const ap = (putBody as { autopilot: { pilotExec: string; overseerExec: string } }).autopilot;
      expect(ap.pilotExec).toBe(''); // relay mode clears the agent execs
      expect(ap.overseerExec).toBe('');
    });
  });

  it('switching to CLI Tools saves agent execs (same role labels in both modes)', async () => {
    localStorage.setItem('elowen.settings.category', 'autopilot');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('How autopilot reasons')).toBeTruthy());

    putBody = null;
    fireEvent.click(screen.getByText('CLI Tools')); // mode toggle — auto-persists the agent execs
    expect(screen.getByText('Planner model')).toBeTruthy(); // unified label, not a separate "Pilot backend"

    await waitFor(() => {
      const ap = (putBody as { autopilot: { pilotExec: string; overseerExec: string; reviewOnDone: boolean } }).autopilot;
      expect(ap.pilotExec).not.toBe(''); // seeded with a default model on switch
      expect(ap.overseerExec).not.toBe('');
      expect(ap.reviewOnDone).toBe(false);
    });
  });

  it('toggles TDD mission mode and persists autopilot.tddMode in both reasoning modes', async () => {
    localStorage.setItem('elowen.settings.category', 'autopilot');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('How autopilot reasons')).toBeTruthy());

    // The toggle lives with the run defaults (visible in the default relay mode) and starts off.
    // The pod's orb shares the row's accessible name, so target the switch role explicitly.
    const toggle = screen.getByRole('switch', { name: 'TDD mission mode' });
    expect(toggle).not.toBeChecked();

    putBody = null;
    fireEvent.click(toggle);
    await waitFor(() => {
      const ap = (putBody as { autopilot: { tddMode: boolean } }).autopilot;
      expect(ap.tddMode).toBe(true);
    });
  });

  it('keeps only the shared GitHub keys in the core section (the PR knobs moved to the agents plugin)', async () => {
    localStorage.setItem('elowen.settings.category', 'github');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByRole('switch', { name: /PR workflow/ })).toBeInTheDocument());

    // Base branch / auto-open / verify command are plugin-owned config (plugins.config.agents) and
    // edit in the agents plugin's settings deck now — core must not render or save them.
    expect(screen.queryByText('Verify command')).toBeNull();
    expect(screen.queryByText('Base branch')).toBeNull();

    putBody = null;
    fireEvent.click(screen.getByRole('switch', { name: /PR workflow/ }));
    await waitFor(() => {
      const ap = (putBody as { autopilot: Record<string, unknown> }).autopilot;
      expect(ap.prEnabled).toBe(true);
      expect('prVerifyCommand' in ap).toBe(false);
      expect('prBaseBranch' in ap).toBe(false);
      expect('prAutoOpen' in ap).toBe(false);
    });
  });


  it('opens the ConfirmDialog when deleting a custom model', async () => {
    server.use(http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'my/custom'], customModels: [{ label: 'My Custom Model', exec: 'my/custom' }], autopilot: { model: 'm', apiUrl: 'u', apiKeySet: false, notes: '' }, defaults: { exec: 'sonnet', autonomy: 'L1', maxSessions: 1 }, security: { tokenTtlDays: 30 } })));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('My Custom Model')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Delete my/custom' }));
    expect(await screen.findByText(/Remove My Custom Model/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByLabelText('My Custom Model')).toBeNull());
  });

  it('toggles conversation auto-cleanup from the System section and persists sessionRetention', async () => {
    server.use(http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], autopilot: { model: 'm', apiUrl: 'u', apiKeySet: false, notes: '' }, defaults: { exec: 'sonnet', autonomy: 'L1', maxSessions: 1 }, security: { tokenTtlDays: 30 }, sessionRetention: { enabled: false, days: 90 } })));
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });

    // Off by default → flipping the switch persists just the enabled flag (its own PUT, not bundled
    // with the token-TTL defaults autosave).
    putBody = null;
    fireEvent.click(screen.getByRole('switch', { name: en.settings.retention.label }));
    await waitFor(() => expect((putBody as { sessionRetention: { enabled: boolean } }).sessionRetention).toEqual({ enabled: true }));
  });

  it('commits the retention days field on blur from the System section, clamped to >= 1', async () => {
    server.use(http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], autopilot: { model: 'm', apiUrl: 'u', apiKeySet: false, notes: '' }, defaults: { exec: 'sonnet', autonomy: 'L1', maxSessions: 1 }, security: { tokenTtlDays: 30 }, sessionRetention: { enabled: true, days: 30 } })));
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });

    // The days field lives in the retention drawer — open it via the pod's orb first.
    fireEvent.click(screen.getAllByRole('button', { name: en.settings.retention.label })[0]);
    const days = await screen.findByLabelText(en.settings.retention.olderThan);
    await waitFor(() => expect(days).toHaveValue(30));

    putBody = null;
    fireEvent.change(days, { target: { value: '45' } });
    fireEvent.blur(days);
    await waitFor(() => expect((putBody as { sessionRetention: { days: number } }).sessionRetention).toEqual({ days: 45 }));

    putBody = null;
    fireEvent.change(days, { target: { value: '0' } });
    fireEvent.blur(days);
    // Invalid draft (< 1) reverts silently and never PUTs.
    expect(putBody).toBeNull();
  });
});

const config = { allowedExecs: ['sonnet'], customModels: [], autopilot: { model: 'm', apiUrl: 'u', apiKeySet: false, notes: 'mind the guardrails' }, defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 2 }, security: { tokenTtlDays: 30 } };

describe('Settings depth', () => {
  it('renders model toggles and a defaults segmented control', async () => {
    server.use(http.get('*/api/config', () => HttpResponse.json(config)));
    const { wrapper: Wrapper } = createWrapper();
    const { unmount } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);

    // Models category is active by default
    await waitFor(() => expect(screen.getAllByRole('switch').length).toBeGreaterThan(0)); // model toggle rows
    unmount();

    // Autopilot section — the notes pod shows the saved text; the textarea edits in the drawer.
    localStorage.setItem('elowen.settings.category', 'autopilot');
    const { wrapper: WrapperAp } = createWrapper();
    const ap = render(<WrapperAp><ToastProvider><SettingsPage /></ToastProvider></WrapperAp>);
    await waitFor(() => expect(screen.getAllByText('mind the guardrails').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: en.settings.notes })[0]);
    await waitFor(() => expect(screen.getByDisplayValue('mind the guardrails')).toBeTruthy()); // notes textarea
    ap.unmount();

    // Autopilot section — the backend-mode + autonomy segmented controls (run defaults moved here).
    localStorage.setItem('elowen.settings.category', 'autopilot');
    const { wrapper: WrapperDef } = createWrapper();
    render(<WrapperDef><ToastProvider><SettingsPage /></ToastProvider></WrapperDef>);
    await waitFor(() => expect(screen.getAllByRole('radiogroup').length).toBeGreaterThan(0)); // autonomy/backend segmented
  });
});

describe('SkillsEditor (optimistic disclosure toggle)', () => {
  const skillRow = (name: string, disableModelInvocation: boolean) => ({ name, description: `${name} desc`, source: 'user', disableModelInvocation, version: null, content: `Body ${name}.` });
  const list = [skillRow('alpha', false), skillRow('beta', false)];
  const toggles = () => screen.getAllByRole('switch', { name: en.skills.disableModelInvocation });

  it('flips the clicked row immediately and disables only that row while the PATCH is in flight', async () => {
    let alphaDisabled = false;
    let resolvePatch!: () => void;
    const patchDone = new Promise<void>((r) => { resolvePatch = r; });
    server.use(
      http.get('*/api/plugins/skills/list', () => HttpResponse.json([skillRow('alpha', alphaDisabled), skillRow('beta', false)])),
      http.patch('*/api/plugins/skills/alpha', async () => { await patchDone; alphaDisabled = true; return HttpResponse.json({ ok: true }); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SkillsEditor /></ToastProvider></Wrapper>);

    await waitFor(() => expect(toggles()).toHaveLength(2));
    const [alpha, beta] = toggles();
    expect(alpha).not.toBeChecked();
    expect(beta).not.toBeChecked();

    fireEvent.click(alpha);
    // Optimistic: alpha flips before the PATCH resolves, and only alpha is greyed out.
    await waitFor(() => expect(alpha).toBeChecked());
    expect(alpha).toBeDisabled();
    expect(beta).not.toBeDisabled();
    expect(beta).not.toBeChecked();

    // Once the server confirms (and the refetch lands the updated list), alpha stays on and re-enables.
    resolvePatch();
    await waitFor(() => expect(alpha).toBeEnabled());
    expect(alpha).toBeChecked();
  });

  it('rolls the toggle back when the PATCH fails', async () => {
    let rejectPatch!: () => void;
    const patchFail = new Promise<void>((r) => { rejectPatch = r; });
    server.use(
      http.get('*/api/plugins/skills/list', () => HttpResponse.json(list)),
      http.patch('*/api/plugins/skills/alpha', async () => { await patchFail; return HttpResponse.json({ error: 'boom' }, { status: 500 }); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SkillsEditor /></ToastProvider></Wrapper>);

    await waitFor(() => expect(toggles()).toHaveLength(2));
    const [alpha] = toggles();
    fireEvent.click(alpha);
    await waitFor(() => expect(alpha).toBeChecked()); // optimistic flip, held while the PATCH is pending
    rejectPatch();
    await waitFor(() => expect(alpha).not.toBeChecked()); // rolled back on error
  });
});
