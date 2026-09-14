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

import { AccountView } from '../../modules/account/AccountView';
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
    <Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>,
  );
};

/** THE DECK ITSELF, which is what every arrival at `/account` renders: the `@pageOverlay` slot mounts it
 *  for an intercepted navigation and for a hard load alike, and the canonical page under `app/` draws
 *  nothing (pinned in `tests/app/pageOverlaySlot.test.tsx`). What is asserted here is therefore the deck's
 *  own contract — its navigation and its address — rather than which route module produced it. */
describe('Account deck', () => {
  it('carries its own section navigation in both shapes, and no frame of its own', async () => {
    const { container } = renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: en.account.tabProfile })).toBeInTheDocument();

    // The frame is the page overlay's; the deck contributes the layout and nothing around it.
    expect(container.querySelector('[data-module="account"]')).toBeNull();
    expect(container.querySelector('[data-testid="account-deck-layout"]')).not.toBeNull();
    // The menu holds one row for Account, so the way between its sections is inside the deck: a column
    // where there is width for it, a strip on a phone. Both are in the DOM; the stylesheet shows one.
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
