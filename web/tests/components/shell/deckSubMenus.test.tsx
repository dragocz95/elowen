import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
const location = vi.hoisted(() => ({ pathname: '/dash', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => location.pathname,
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(location.search),
}));
import { SidebarNav } from '../../../components/shell/SidebarNav';
import { resolveSidebarRoute } from '../../../components/shell/useSidebarRoute';
import { SETTINGS_SECTIONS, settingsSectionHref } from '../../../modules/settings/categories';
import { accountSectionHref, accountSections } from '../../../modules/account/sections';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { NavEntry } from '../../../components/shell/navEntry';
import { createWrapper } from '../../test-utils';

/** THE DECKS' SECTIONS ARE MENU ROWS NOW.
 *
 *  Settings and Account used to carry a navigation of their own — a rail beside the content, a tab strip
 *  on a phone — so the app had two menus and one of them only appeared once you had already arrived. The
 *  sections are addresses (`?cat=`), so they are rows of the sidebar's sub-menu like a plugin's pages,
 *  and the deck pages draw no navigation at all.
 *
 *  What has to hold for that to be a replacement rather than a removal: every section is reachable from
 *  the menu, the address of a section opens its parent and marks its row, and the sheet a phone gets is
 *  the same menu with the same sub-menus. */

const server = setupServer(
  http.get('*/api/health', () => HttpResponse.json({ ok: true, version: '0.26.0' })),
);
beforeAll(() => server.listen());
afterAll(() => server.close());
beforeEach(() => {
  localStorage.clear();
  location.pathname = '/dash';
  location.search = '';
  // The column reads the address bar for what the router cannot see, so each case starts from a clean one.
  window.history.replaceState(null, '', '/');
});

const PLUGIN_UI = [
  {
    name: 'notes',
    title: 'Notes',
    label: 'Notes',
    nav: [],
    // Two settings sections: a plugin's own configuration pages are sub-items of its world exactly the
    // way a core deck's sections are sub-items of theirs.
    settings: [
      { id: 'general', label: 'General', icon: 'Settings2' },
      { id: 'sync', label: 'Sync', icon: 'RefreshCw' },
    ],
    account: [{ id: 'identity', label: 'Notes account', icon: 'UserRound' }],
  },
];

const USER_PLUGIN_CONFIGS = [
  { name: 'raynet', label: 'Raynet CRM', description: 'Your CRM credentials.', schema: [], values: {} },
];

function mount(props: Parameters<typeof SidebarNav>[0] = {}) {
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
  client.setQueryData(['health'], { ok: true, version: '0.26.0' });
  client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });
  client.setQueryData(['plugin-ui', 'en'], PLUGIN_UI);
  client.setQueryData(['user-plugin-configs'], USER_PLUGIN_CONFIGS);
  return render(<Wrapper><SidebarNav {...props} /></Wrapper>);
}

/** The nav model as the column builds it, reached through the column itself: the sub-items are derived
 *  from three live queries, so asserting the rendered rows is what proves the derivation. */
const subItemHrefs = (parentName: string): string[] => {
  fireEvent.click(screen.getByRole('button', { name: parentName }));
  return screen.getAllByRole('link')
    .filter((link) => link.closest('[data-sidebar="menu-sub"]') !== null)
    .map((link) => link.getAttribute('href')!);
};

describe('the Settings deck as a sub-menu', () => {
  it('offers every section of the deck as a row, in the deck\'s own order', () => {
    mount();
    expect(subItemHrefs('Settings')).toEqual(SETTINGS_SECTIONS.map((section) => settingsSectionHref(section.id)));
  });

  it('names the assistant\'s section after the assistant rather than after the product', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    // `t.settings.brain` is a template; a row still holding the placeholder means the brand never reached it.
    const assistant = screen.getAllByRole('link').find((link) => link.getAttribute('href') === '/settings?cat=brain');
    expect(assistant?.textContent).not.toContain('{agentName}');
    expect(assistant?.textContent?.length).toBeGreaterThan(0);
  });

  it('opens the parent and marks the row the address names', () => {
    location.pathname = '/settings';
    location.search = '?cat=data';
    mount();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-expanded', 'true');
    const current = screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', '/settings?cat=data');
  });

  /** A deck page switches section from inside itself too — a cross-link from the assistant's section to
   *  the model catalog — and it does that by rewriting the address and firing a `popstate`, because the
   *  router never learns about a history entry it did not write. Without following that announcement the
   *  menu keeps pointing at the section the reader has just left, which is the whole failure the deck's
   *  own rail used to hide by highlighting itself. */
  it('follows a section the page switches to on its own', () => {
    location.pathname = '/settings';
    location.search = '?cat=brain';
    mount();
    const marked = () => screen.getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page')
      ?.getAttribute('href');
    expect(marked()).toBe('/settings?cat=brain');

    act(() => {
      window.history.replaceState(null, '', '/settings?cat=models');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(marked()).toBe('/settings?cat=models');
  });
});

describe('the Account deck as a sub-menu', () => {
  it('offers its own sections and everything the installed plugins contribute', () => {
    mount();
    const hrefs = subItemHrefs('Account');
    // The core sections, in the page's order, with the plugin blocks after the profile.
    expect(hrefs).toContain(accountSectionHref('profile'));
    expect(hrefs).toContain(accountSectionHref('cli'));
    expect(hrefs).toContain(accountSectionHref('terminal'));
    // A plugin's account panel and a per-account plugin configuration are sections of this page too, and
    // the menu is now the only way to either.
    expect(hrefs).toContain('/account?cat=plugin-account%3Anotes%3Aidentity');
    expect(hrefs).toContain('/account?cat=plugin-user-config%3Araynet');
    // Both plugin blocks sit between the profile and the rest, exactly as the page mounts them.
    expect(hrefs.indexOf('/account?cat=plugin-account%3Anotes%3Aidentity'))
      .toBeGreaterThan(hrefs.indexOf(accountSectionHref('profile')));
    expect(hrefs.indexOf('/account?cat=plugin-user-config%3Araynet'))
      .toBeLessThan(hrefs.indexOf(accountSectionHref('cli')));
  });

  it('opens the parent and marks the row the address names', () => {
    location.pathname = '/account';
    location.search = '?cat=cli';
    mount();
    expect(screen.getByRole('button', { name: 'Account' })).toHaveAttribute('aria-expanded', 'true');
    const current = screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', '/account?cat=cli');
  });

  it('names a per-account plugin configuration by the plugin, not by its sentence', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('link', { name: 'Raynet CRM' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Your CRM credentials.' })).toBeNull();
  });
});

describe('a plugin\'s settings sections as a sub-menu', () => {
  it('lists them under the plugin\'s own world, at the addresses the host route serves', () => {
    mount();
    expect(subItemHrefs('Notes')).toEqual(['/p/notes/settings/general', '/p/notes/settings/sync']);
  });

  it('opens the parent and marks the section the reader is standing on', () => {
    location.pathname = '/p/notes/settings/sync';
    mount();
    expect(screen.getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Sync' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('the phone sheet', () => {
  it('carries the same sub-menus, because it is the same menu', () => {
    location.pathname = '/settings';
    location.search = '?cat=plugins';
    mount({ drawer: true, drawerOpen: true, onDrawerClose: vi.fn() });

    const sheet = screen.getByRole('dialog', { name: 'Primary' });
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(sheet).toContainElement(settings);
    // The address opened it, so the reader arrives with the section they are in already showing.
    expect(settings).toHaveAttribute('aria-expanded', 'true');
    const current = screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current[0]).toHaveAttribute('href', '/settings?cat=plugins');
    expect(sheet).toContainElement(current[0]!);

    // And a section the reader is not in still discloses on demand, inside the sheet.
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('button', { name: 'Account' })).toHaveAttribute('aria-expanded', 'true');
  });
});

/** The route rule, checked against every section rather than against a sample. A pure function, so the
 *  whole set is cheap to walk — and it is the set that would silently lose a row when a section is added
 *  to a deck and nowhere else. */
describe('every deck section resolves to its own row', () => {
  const settingsEntry: NavEntry = {
    id: 'settings',
    href: '/settings',
    label: 'Settings',
    icon: SETTINGS_SECTIONS[0]!.icon,
    subItems: SETTINGS_SECTIONS.map((section) => ({
      id: `settings-${section.id}`,
      href: settingsSectionHref(section.id),
      label: section.id,
    })),
  };
  const accountDescriptors = accountSections(en, []);
  const accountEntry: NavEntry = {
    id: 'account',
    href: '/account',
    label: 'Account',
    icon: accountDescriptors[0]!.icon,
    subItems: accountDescriptors.map((section) => ({
      id: `account-${section.id}`,
      href: accountSectionHref(section.id),
      label: section.label,
    })),
  };
  const entries = [settingsEntry, accountEntry];

  it.each(SETTINGS_SECTIONS.map((section) => section.id))('settings ?cat=%s', (id) => {
    const route = resolveSidebarRoute(entries, '/settings', `?cat=${id}`);
    expect(route).toEqual({ activeId: 'settings', currentHref: settingsSectionHref(id), openId: 'settings' });
  });

  it.each(accountDescriptors.map((section) => section.id))('account ?cat=%s', (id) => {
    const route = resolveSidebarRoute(entries, '/account', `?cat=${id}`);
    expect(route).toEqual({ activeId: 'account', currentHref: accountSectionHref(id), openId: 'account' });
  });

  it('keeps a record anchor from splitting a section into two rows', () => {
    const route = resolveSidebarRoute(entries, '/settings', '?cat=models&row=settings.modelRoles.digest');
    expect(route.currentHref).toBe(settingsSectionHref('models'));
  });
});
