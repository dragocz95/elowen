import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/settings', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
// The bundle loader injects real <script type=module> tags — stubbed for determinism (jsdom cannot
// execute module scripts); the mapping and deck behavior are what this file is about.
vi.mock('../../lib/pluginUi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pluginUi')>();
  return { ...actual, loadPluginUi: vi.fn() };
});
import { render, screen, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import SettingsPage from '../../app/settings/page';
import { loadPluginUi } from '../../lib/pluginUi';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';
import { en } from '../../lib/i18n/dictionaries/en';

const CORE_RAIL = ['System', 'Elowen AI', 'Models', 'CLI Agents', 'Plugins', 'GitHub', 'Autopilot', 'Memory', 'Data'];

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
});
