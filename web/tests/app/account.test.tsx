import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';

vi.mock('next/navigation', () => ({
  usePathname: () => '/account',
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock('../../lib/monaco/monacoLoader', () => ({ MonacoEditor: () => null, MonacoDiffEditor: () => null }));

import AccountPage from '../../app/account/page';
import { ToastProvider } from '../../components/ui/Toast';
import { UiScaleProvider } from '../../lib/useUiScale';
import { EffectsProvider } from '../../lib/useEffects';
import { createWrapper } from '../test-utils';
import { en } from '../../lib/i18n/dictionaries/en';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest }));
beforeEach(() => {
  server.use(
    http.get('*/api/plugins/ui', () => HttpResponse.json([])),
    http.get('*/api/auth/me', () => HttpResponse.json({
      user: { id: 2, username: 'bob', name: 'Bob', email: 'bob@example.com', avatar: '', default_exec: '', is_admin: false, allowed_execs: [], created_at: '2026-01-01' },
    })),
    http.get('*/api/config', () => HttpResponse.json({ allowedExecs: [], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
    http.get('*/api/brain/models', () => HttpResponse.json([])),
    http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({ model: '', modelProvider: '', discordUserId: '', whatsappNumber: '' })),
  );
});
afterEach(() => { server.resetHandlers(); localStorage.clear(); window.history.replaceState(null, '', '/account'); });
afterAll(() => server.close());

const renderPage = () => {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountPage /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>,
  );
};

/** A hard load, an external link and a refresh of `/account` all reach THIS page: the intercepting route
 *  under `app/@pageOverlay` is only mounted on a client navigation. So the canonical surface has to keep
 *  being the whole page — no dialog, no overlay layout, and no second navigation inside it. */
describe('AccountPage (canonical)', () => {
  it('renders the full page with no overlay frame of its own', async () => {
    const { container } = renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: en.account.tabProfile })).toBeInTheDocument();

    expect(container.querySelector('[data-module="account"]')).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-elowen-modal]')).toBeNull();
    // The deck layout is the SAME here as in the overlay: the menu holds one row for Account, so the way
    // between its sections has to be in the deck itself on every surface that draws it.
    expect(container.querySelector('[data-testid="account-deck-layout"]')).not.toBeNull();
    expect(screen.queryByTestId('account-navigation-sidebar')).not.toBeNull();
    expect(screen.queryByTestId('account-navigation-tabs')).not.toBeNull();
  });

  it('keeps the section a deep link names and writes back the one it opened on', async () => {
    window.history.replaceState(null, '', '/account?cat=security');
    const { unmount } = renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: en.account.tabSecurity })).toBeInTheDocument();
    expect(window.location.search).toBe('?cat=security');
    unmount();

    // A bare `/account` names no section, so the page writes the one it opened on — the menu outside it
    // can only mark the section the address names.
    localStorage.clear();
    window.history.replaceState(null, '', '/account');
    renderPage();
    await waitFor(() => expect(window.location.search).toBe('?cat=profile'));
  });
});
