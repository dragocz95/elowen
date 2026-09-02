import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/settings', useSearchParams: () => new URLSearchParams(), useRouter: () => nav }));
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import SettingsPage from '../../app/settings/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

// Settings is CORE-ONLY. A plugin's settings section is a page of that plugin's world (the main
// navigation already lists it), so the deck must not offer the same surface a second time — and the
// ids that used to name a deck section survive in localStorage and in links, which is why they are
// forwarded to that page instead of dropped.
const CORE_RAIL = ['System', 'Elowen AI', 'Models', 'Plugins', 'Recap', 'Data'];

const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], providers: { 'claude-code': { bin: 'claude', args: '' } }, defaults: { exec: 'sonnet', autonomy: 'L1', maxSessions: 1 }, security: { tokenTtlDays: 30 } })),
  http.get('*/api/system', () => HttpResponse.json({ version: '0.26.0', latest: '0.26.0', updateAvailable: false, autoUpdate: false, lastUpdatedAt: '2026-07-11T12:00:00.000Z' })),
  http.get('*/api/system/skills', () => HttpResponse.json({ skills: [] })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([
    { name: 'demo', url: '/plugins/demo/web/abc.js', apiVersion: 1, nav: [], settings: [{ id: 'general', label: 'Demo plugin' }] },
  ])),
);
beforeEach(() => {
  localStorage.setItem('elowen.settings.category', 'system');
  nav.replace.mockReset();
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

describe('SettingsPage and plugin-contributed sections', () => {
  it('keeps the rail core-only while a plugin declares a section', async () => {
    mountPage();
    await screen.findByRole('heading', { level: 1, name: 'System' });
    // Give the listing a chance to arrive — the assertion is about what it does NOT add.
    await screen.findByText('System diagnostics');
    const rail = screen.getByRole('radiogroup', { name: 'Settings sections' });
    expect(Array.from(rail.querySelectorAll('[role="radio"]')).map((node) => node.textContent)).toEqual(CORE_RAIL);
    expect(screen.queryByRole('radio', { name: 'Demo plugin' })).toBeNull();
  });

  it('forwards a remembered section of a sole-section plugin to that plugin\'s page', async () => {
    localStorage.setItem('elowen.settings.category', 'plugin:demo:general');
    mountPage();
    await screen.findByText('System diagnostics'); // the deck lands on a real section meanwhile
    expect(nav.replace).toHaveBeenCalledWith('/p/demo');
  });

  it('forwards to the explicit section address when the plugin has several', async () => {
    server.use(http.get('*/api/plugins/ui', () => HttpResponse.json([
      { name: 'demo', url: '/plugins/demo/web/abc.js', apiVersion: 1, nav: [], settings: [
        { id: 'general', label: 'Demo plugin' },
        { id: 'orbit', label: 'Demo orbit', layout: 'orbital' },
      ] },
    ])));
    localStorage.setItem('elowen.settings.category', 'plugin:demo:orbit');
    mountPage();
    await screen.findByText('System diagnostics');
    expect(nav.replace).toHaveBeenCalledWith('/p/demo/settings/orbit');
  });

  it('a remembered section of a since-disabled plugin falls back to System without navigating', async () => {
    localStorage.setItem('elowen.settings.category', 'plugin:gone:x');
    mountPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
    expect(await screen.findByText('System diagnostics')).toBeInTheDocument();
    // Forwarding to `/p/gone` would send the reader to a plugin that is not there.
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
