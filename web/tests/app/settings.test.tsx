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
const config = {
  allowedExecs: ['elowen:anthropic::opus'], customModels: [], providers: {},
  defaults: { exec: 'elowen:anthropic::opus', autonomy: 'L1', maxSessions: 1 },
  security: { tokenTtlDays: 30 }, sessionRetention: { enabled: false, days: 90 },
};
const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json(config)),
  http.get('*/api/brain/models', () => HttpResponse.json([
    { provider: 'anthropic', providerLabel: 'Anthropic', model: 'Claude Opus', exec: 'elowen:anthropic::opus', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
  ])),
  http.get('*/api/system', () => HttpResponse.json({
    version: '0.26.0', latest: '0.26.0', updateAvailable: false, autoUpdate: false, lastUpdatedAt: '2026-07-11T12:00:00.000Z',
    diagnostics: { cpuPercent: 12, memoryUsedBytes: 3_200_000_000, memoryTotalBytes: 16_000_000_000, uptimeSeconds: 1_098_000 },
  })),
  http.get('*/api/system/skills', () => HttpResponse.json({ skills: [] })),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', name: 'Admin', is_admin: true } })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([])),
  http.get('*/api/brain/debug/sessions', () => HttpResponse.json({ items: [], nextCursor: null, captureStartedAt: Date.UTC(2026, 7, 1, 10, 0, 0) })),
  http.put('*/api/config', async ({ request }) => { putBody = await request.json(); return HttpResponse.json(config); }),
);
beforeEach(() => localStorage.setItem('elowen.settings.category', 'models'));
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); localStorage.clear(); window.history.replaceState(null, '', '/settings'); });
afterAll(() => server.close());

describe('SettingsPage', () => {
  it('matches the reference section order and renders real System diagnostics', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
    const rail = screen.getByRole('radiogroup', { name: 'Settings sections' });
    expect(Array.from(rail.querySelectorAll('[role="radio"]')).map((node) => node.textContent)).toEqual([
      'System', 'Elowen AI', 'Models', 'Plugins', 'Memory', 'Data',
    ]);
    expect(screen.getByText('System diagnostics')).toBeInTheDocument();
    // The dials are a lazy chunk, so the reading lands a tick after the section itself. Spaced before
    // the percent sign like every other figure in the app.
    expect(await screen.findByText('12 %')).toBeInTheDocument();
  });

  it('offers conversation diagnostics without capture controls in Data', async () => {
    localStorage.setItem('elowen.settings.category', 'data');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Conversation diagnostics')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open diagnostics' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /capture/i })).not.toBeInTheDocument();
  });

  it('renders the embedded model catalog without removed CLI-provider controls', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    expect(await screen.findByLabelText('Claude Opus')).toBeChecked();
    expect(screen.queryByText('Claude Code')).toBeNull();
    expect(screen.queryByText('Codex')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add model' })).toBeNull();
  });

  it('auto-saves an embedded model allowlist change', async () => {
    putBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    const toggle = await screen.findByLabelText('Claude Opus');
    fireEvent.click(toggle);
    await waitFor(() => expect((putBody as { allowedExecs: string[] }).allowedExecs).not.toContain('elowen:anthropic::opus'));
  });

  it('toggles conversation auto-cleanup and persists sessionRetention', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });
    putBody = null;
    fireEvent.click(screen.getByRole('switch', { name: en.settings.retention.label }));
    await waitFor(() => expect((putBody as { sessionRetention: { enabled: boolean } }).sessionRetention).toEqual({ enabled: true }));
  });

  it('falls back to System for a stale moved-section deep-link', async () => {
    localStorage.setItem('elowen.settings.category', 'retired-section');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
  });

  /** Both restart buttons must be DIRECT children of the hero's action row. The rule that stops them
   *  alternating right- then left-aligned down a narrow column — `.workspace-hero__actions >
   *  :not(.workspace-hero__status) { flex: 1 1 10rem }` — is a child selector, so wrapping the pair in a
   *  layout div would quietly bring the zig-zag back with nothing else on the page changing. */
  it('hangs both hero restart actions directly off the hero action row', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });

    const actions = container.querySelector('.workspace-hero__actions');
    expect(actions).not.toBeNull();
    for (const label of [en.settings.restartDaemon, en.settings.restartWeb]) {
      expect(screen.getByRole('button', { name: label }).parentElement).toBe(actions);
    }
  });

  /** The page's controls live in ONE row, below the section navigation — not promoted above the title and
   *  not re-declared per section. The row is mounted on every section because it carries the portal slot,
   *  so a section with nothing to put in it must leave the row genuinely empty rather than draw a band. */
  it('puts the model search in the canonical toolbar row', async () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByLabelText('Claude Opus');

    const search = screen.getByLabelText(en.settings.modelSearchPlaceholder);
    expect(container.querySelector('.page-toolbar__search')).toContainElement(search);
    // The row is under the section navigation, and the hero above it is not a control surface.
    expect(container.querySelector('.workspace-hero')!.contains(search)).toBe(false);
  });

  it('hangs the Elowen AI cross-link off the toolbar actions', async () => {
    localStorage.setItem('elowen.settings.category', 'brain');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);

    const link = await screen.findByRole('button', { name: en.settings.brainModelsLink });
    expect(container.querySelector('.page-toolbar__actions')).toContainElement(link);

    fireEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Models' })).toBeInTheDocument();
  });

  it('leaves the toolbar row empty for a section with no page-level controls', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });

    const row = container.querySelector('.page-toolbar__row');
    expect(row).not.toBeNull();
    // Only the portal slot, and nothing in it — which is what the stylesheet collapses the row on.
    expect(Array.from(row!.children).map((node) => node.className)).toEqual(['page-toolbar__slot']);
    expect(row!.querySelector('.page-toolbar__slot')!.children).toHaveLength(0);
  });
});
