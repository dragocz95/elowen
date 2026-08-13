import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/settings', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
// The bundle loader injects real <script type=module> tags — stubbed for determinism (jsdom cannot
// execute module scripts); the mapping and deck behavior are what this file is about.
vi.mock('../../lib/pluginUi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pluginUi')>();
  return { ...actual, loadPluginUi: vi.fn() };
});
import { useEffect } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import SettingsPage from '../../app/settings/page';
import { loadPluginUi } from '../../lib/pluginUi';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';
import { en } from '../../lib/i18n/dictionaries/en';

const CORE_RAIL = ['System', 'Elowen AI', 'Models', 'Plugins', 'Memory', 'Data'];

const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], autopilot: { model: 'mimo-v2.5', apiUrl: '', apiKeySet: false, notes: '' }, providers: { 'claude-code': { bin: 'claude', args: '' } }, defaults: { exec: 'sonnet', autonomy: 'L1', maxSessions: 1 }, security: { tokenTtlDays: 30 } })),
  http.get('*/api/system', () => HttpResponse.json({ version: '0.26.0', latest: '0.26.0', updateAvailable: false, autoUpdate: false, lastUpdatedAt: '2026-07-11T12:00:00.000Z' })),
  http.get('*/api/system/skills', () => HttpResponse.json({ skills: [] })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([
    { name: 'demo', url: '/plugins/demo/web/abc.js', apiVersion: 1, nav: [], settings: [{ id: 'general', label: 'Demo plugin' }] },
  ])),
);
beforeEach(() => {
  localStorage.setItem('elowen.settings.category', 'system');
  vi.mocked(loadPluginUi).mockReset();
});
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
  window.history.replaceState(null, '', '/settings');
});
afterAll(() => server.close());

const mountPage = () => {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
};

describe('SettingsPage plugin sections', () => {
  it('appends plugin sections AFTER the untouched core order and renders the registered panel', async () => {
    vi.mocked(loadPluginUi).mockResolvedValue({
      requiresApiVersion: 1,
      settings: { general: () => <div data-testid="demo-settings">from the plugin bundle</div> },
    });
    mountPage();
    await screen.findByRole('heading', { level: 1, name: 'System' });
    const railFor = () => screen.getByRole('radiogroup', { name: 'Settings sections' });
    await screen.findByRole('radio', { name: 'Demo plugin' });
    expect(Array.from(railFor().querySelectorAll('[role="radio"]')).map((node) => node.textContent))
      .toEqual([...CORE_RAIL, 'Demo plugin']);

    fireEvent.click(screen.getByRole('radio', { name: 'Demo plugin' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Demo plugin' })).toBeInTheDocument();
    expect(await screen.findByTestId('demo-settings')).toBeInTheDocument();
  });

  it('a bundle that registers no component for a declared section gets the placeholder', async () => {
    vi.mocked(loadPluginUi).mockResolvedValue({ requiresApiVersion: 1 });
    mountPage();
    fireEvent.click(await screen.findByRole('radio', { name: 'Demo plugin' }));
    expect(await screen.findByText(en.pluginUi.settingsUnavailable)).toBeInTheDocument();
  });

  it('a remembered section of a since-disabled plugin falls back to System', async () => {
    localStorage.setItem('elowen.settings.category', 'plugin:gone:x');
    mountPage();
    // The listing has no `gone` plugin → the stale remembered id resets to the first core section.
    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
    expect(await screen.findByText('System diagnostics')).toBeInTheDocument();
  });

  it('a section declaring layout:orbital gets the constellation panel the core sections use', async () => {
    // The GitHub section moved into the agents plugin and must keep the orbital rendering it had as a
    // core category. The layout lives on the PANEL, so the manifest declaration has to reach it — a
    // section that declares nothing stays classic, which is the second half of this assertion.
    server.use(http.get('*/api/plugins/ui', () => HttpResponse.json([
      { name: 'demo', url: '/plugins/demo/web/abc.js', apiVersion: 1, nav: [], settings: [
        { id: 'general', label: 'Demo plugin' },
        { id: 'orbit', label: 'Demo orbit', layout: 'orbital' },
      ] },
    ])));
    vi.mocked(loadPluginUi).mockResolvedValue({
      requiresApiVersion: 1,
      settings: {
        general: () => <div data-testid="demo-settings">classic</div>,
        orbit: () => <div data-testid="demo-orbit">orbital</div>,
      },
    });
    const { container } = mountPage();

    fireEvent.click(await screen.findByRole('radio', { name: 'Demo orbit' }));
    await screen.findByTestId('demo-orbit');
    expect(container.querySelector('[data-settings-panel="plugin:demo:orbit"]')).toHaveAttribute('data-constellation');

    fireEvent.click(screen.getByRole('radio', { name: 'Demo plugin' }));
    await screen.findByTestId('demo-settings');
    expect(container.querySelector('[data-settings-panel="plugin:demo:general"]')).not.toHaveAttribute('data-constellation');
  });

  it('renders a plugin section\'s save state in the deck header, retry included', async () => {
    // An orbital section has no header of its own to hold an autosave indicator, so the deck's shared
    // one is where it belongs — the same slot the core sections report into. Without this wiring a
    // failed save in a plugin section is invisible and unretryable.
    const retry = vi.fn();
    const FailingSection = ({ onSaveState }: { onSaveState?: (s: 'error', r?: () => void) => void }) => {
      useEffect(() => { onSaveState?.('error', retry); }, [onSaveState]);
      return <div data-testid="demo-settings">reports upward</div>;
    };
    vi.mocked(loadPluginUi).mockResolvedValue({ requiresApiVersion: 1, settings: { general: FailingSection } });
    mountPage();
    fireEvent.click(await screen.findByRole('radio', { name: 'Demo plugin' }));
    await screen.findByTestId('demo-settings');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.common.saveFailed);
    fireEvent.click(screen.getByRole('button', { name: en.common.retry }));
    expect(retry).toHaveBeenCalled();
  });

  it('with the agents plugin disabled the GitHub section is absent, not empty', async () => {
    // Production shape on this instance: agents is off, so /plugins/ui lists no agents entry at all.
    // A user who was last on the GitHub section must land on a real section, and nothing GitHub-shaped
    // may render — neither a rail entry nor a headerless panel.
    localStorage.setItem('elowen.settings.category', 'plugin:agents:github');
    server.use(http.get('*/api/plugins/ui', () => HttpResponse.json([])));
    mountPage();
    // A real section is on screen (the System PANEL, not just its rail label), so the user is not left
    // staring at an empty document where their GitHub settings used to be.
    expect(await screen.findByText('System diagnostics')).toBeInTheDocument();
    const rail = screen.getByRole('radiogroup', { name: 'Settings sections' });
    expect(Array.from(rail.querySelectorAll('[role="radio"]')).map((n) => n.textContent)).toEqual(CORE_RAIL);
    expect(screen.queryByText('GitHub token')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'PR workflow' })).toBeNull();
  });
});
