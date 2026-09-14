import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';

const state = vi.hoisted(() => ({ back: vi.fn() }));
// The overlay closes through history and the view reads `?cat=` from the address; both come from the
// router in the app and from here in the suite.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: state.back, replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
// Monaco is browser-only and never mounts under jsdom; stub the personality body editor.
vi.mock('../../../lib/monaco/monacoLoader', () => ({
  MonacoEditor: () => null,
  MonacoDiffEditor: () => null,
}));

import { AccountOverlay } from '../../../modules/account/AccountOverlay';
import { AccountView } from '../../../modules/account/AccountView';
import { ToastProvider } from '../../../components/ui/Toast';
import { UiScaleProvider } from '../../../lib/useUiScale';
import { EffectsProvider } from '../../../lib/useEffects';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';

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
afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
  state.back.mockReset();
  window.history.replaceState(null, '', '/account');
});
afterAll(() => server.close());

function renderOverlaySurface() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>,
  );
}

function renderInterceptedAccount() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountOverlay /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>,
  );
}

/** A navigation record's control is a button STRETCHED over the row, with the name beside it rather than
 *  inside it (see components/ui/SectionDeck.tsx), so the label is read the way a screen reader reads it. */
function getAccessibleLabel(node: Element): string {
  const id = node.getAttribute('aria-labelledby');
  return (id ? document.getElementById(id)?.textContent : node.textContent) ?? '';
}

describe('AccountView overlay surface', () => {
  /** The shell's menu is inert while an overlay is up, so this presentation — and only this one — carries
   *  the way between the account's own sections: a secondary column where there is width for it, one line
   *  of tabs on a phone. The canonical page still has neither (see AccountView.test.tsx). */
  it('carries its own section navigation in both shapes and drops the page wrapper', async () => {
    const { container } = renderOverlaySurface();
    expect(await screen.findByRole('heading', { level: 1, name: en.account.tabProfile })).toBeInTheDocument();

    expect(container.querySelector('[data-testid="account-deck-layout"]')).toBeInTheDocument();
    expect(container.querySelector('[data-module="account"]')).toBeNull();

    const sidebar = screen.getByTestId('account-navigation-sidebar');
    const tabs = screen.getByTestId('account-navigation-tabs');
    // One list, two shapes: the column belongs to the width, the tab strip to the phone.
    expect(container.querySelector('[data-testid="account-deck-layout"] > aside')).toContainElement(sidebar);
    expect(tabs).toHaveClass('md:hidden');
    expect(tabs.className).toContain('overflow-x-auto');
    for (const nav of [sidebar, tabs]) {
      expect(nav).toHaveAttribute('aria-label', en.account.navigationLabel);
      const labels = within(nav).getAllByRole('button').map((button) => button.textContent || getAccessibleLabel(button));
      expect(labels).toContain(en.account.tabProfile);
      expect(labels).toContain(en.account.tabSecurity);
    }
    // The column is searchable, exactly as the settings one is: same field, same shared index. The strip
    // is not — it is a way between places, and a filter box belongs with the column that can show what it
    // filtered.
    expect(within(sidebar.parentElement!).getByRole('searchbox', { name: en.account.navigationSearch })).toBeInTheDocument();
    expect(within(tabs).queryByRole('searchbox')).toBeNull();
  });

  it('marks the section on screen and switches without stacking history entries', async () => {
    const { container } = renderOverlaySurface();
    await screen.findByRole('heading', { level: 1, name: en.account.tabProfile });
    await waitFor(() => expect(window.location.search).toBe('?cat=profile'));

    const sidebar = screen.getByTestId('account-navigation-sidebar');
    const current = () => Array.from(sidebar.querySelectorAll('[aria-current="page"]')).map(getAccessibleLabel);
    expect(current()).toEqual([en.account.tabProfile]);

    const entriesBefore = window.history.length;
    fireEvent.click(within(sidebar).getByRole('button', { name: en.account.tabSecurity }));

    expect(await screen.findByRole('heading', { level: 1, name: en.account.tabSecurity })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/account');
    expect(window.location.search).toBe('?cat=security');
    // A section is not a step in the reader's history: Back has to return to the surface the overlay was
    // opened from, not walk back through every section visited inside it.
    expect(window.history.length).toBe(entriesBefore);
    expect(current()).toEqual([en.account.tabSecurity]);
    // The region is named for what it holds, so the content pane announces the section it switched to.
    expect(container.querySelector('[data-testid="account-deck-layout"] > section'))
      .toHaveAttribute('aria-label', en.account.tabSecurity);
  });

  it('opens the section a deep link names', async () => {
    window.history.replaceState(null, '', '/account?cat=cli');
    renderOverlaySurface();
    expect(await screen.findByRole('heading', { level: 1, name: en.account.tabCli })).toBeInTheDocument();
    expect(window.location.search).toBe('?cat=cli');
  });
});

describe('intercepted Account overlay', () => {
  /** The editors Account opens have to resolve exactly as they do on the canonical page — the first one
   *  is a right-hand drawer, not a centered dialog — which is what `standsInForPage` on the shared frame
   *  buys. Asserted through the real password editor rather than a stub, because the regression this
   *  guards is the overlay counting as a level of depth. */
  it('resolves a nested account editor as a drawer under the page stand-in', async () => {
    window.history.replaceState(null, '', '/account?cat=security');
    renderInterceptedAccount();

    const page = await screen.findByTestId('account-overlay');
    expect(page.parentElement).toHaveClass('overlay-layer-page');

    fireEvent.click(await screen.findByRole('button', { name: en.account.changePassword }));

    const surfaces = Array.from(document.querySelectorAll('[data-elowen-modal]'));
    expect(surfaces).toHaveLength(2);
    const editor = surfaces[1]!;
    expect(editor).toHaveAttribute('data-presentation', 'drawer');
    // And the drawer ranks ABOVE the page that opened it.
    expect(editor.parentElement).toHaveClass('overlay-layer-drawer');
  });
});
