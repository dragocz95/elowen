import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/settings', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import SettingsPage from '../../app/settings/page';
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
  // The agents plugin is present by default: the Models section shows the CLI provider groups only
  // when it is (its spawner is what runs those execs). No `settings` entries — the plugin's own
  // settings decks are exercised in tests/pluginUi, not here.
  http.get('*/api/plugins/ui', () => HttpResponse.json([{ name: 'agents', url: '/plugins/agents/web/abc.js', apiVersion: 1, nav: [], settings: [] }])),
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
      'System', 'Elowen AI', 'Models', 'Plugins', 'GitHub', 'Memory', 'Data',
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
    for (const name of ['System', 'Elowen AI', 'Models', 'Plugins', 'GitHub', 'Memory', 'Data']) {
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

  it('hides the CLI provider groups and Add model without the agents plugin (Elowen AI stays)', async () => {
    // CLI-agent execs only run through the agents plugin's spawner — a plugin-less instance must not
    // offer Claude Code / Codex / OpenCode catalog rows or the custom-model affordance.
    server.use(http.get('*/api/plugins/ui', () => HttpResponse.json([])));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'Models' });
    await waitFor(() => expect(screen.queryByText('Claude Code')).toBeNull());
    expect(screen.queryByText('Codex')).toBeNull();
    expect(screen.queryByLabelText('Claude Sonnet 4.5')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add model' })).toBeNull();
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

    fireEvent.click(screen.getByRole('radio', { name: 'GitHub' }));
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
  it('renders model toggles and falls back to System for a stale moved-section deep-link', async () => {
    server.use(http.get('*/api/config', () => HttpResponse.json(config)));
    const { wrapper: Wrapper } = createWrapper();
    const { unmount } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);

    // Models category is active by default
    await waitFor(() => expect(screen.getAllByRole('switch').length).toBeGreaterThan(0)); // model toggle rows
    unmount();

    // The Autopilot and CLI Agents sections moved to the agents plugin's settings deck — a stale
    // remembered/linked category id fails isSectionId validation and falls back to System.
    localStorage.setItem('elowen.settings.category', 'autopilot');
    const { wrapper: WrapperAp } = createWrapper();
    render(<WrapperAp><ToastProvider><SettingsPage /></ToastProvider></WrapperAp>);
    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
    expect(screen.queryByText('mind the guardrails')).toBeNull();
  });
});

