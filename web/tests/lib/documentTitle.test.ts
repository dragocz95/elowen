import { describe, it, expect } from 'vitest';
import { Blocks, LayoutDashboard, SlidersHorizontal } from 'lucide-react';
import { formatDocumentTitle, navPageTitle, resolveDocumentTitle } from '../../lib/documentTitle';
import type { NavEntry } from '../../components/shell/navEntry';

/** The shape useShellNavigation produces: core worlds, then plugin worlds built from the /plugins/ui
 *  listing (label and pages are the PLUGIN's own, already translated by the daemon), then account and
 *  the admin-only system modules. */
const entries: NavEntry[] = [
  { id: 'home', href: '/dash', label: 'Domů', icon: LayoutDashboard, activeRoutes: ['/dash'] },
  { id: 'memory', href: '/memory', label: 'Paměť', icon: LayoutDashboard, activeRoutes: ['/memory'] },
  {
    id: 'plugin-work',
    href: '/p/work/tasks',
    label: 'Práce',
    icon: Blocks,
    activeRoutes: ['/p/work'],
    subItems: [
      { id: 'plugin-work-0', href: '/p/work/tasks', label: 'Úkoly', icon: Blocks },
      { id: 'plugin-work-1', href: '/p/work/kanban', label: 'Kanban', icon: Blocks },
    ],
  },
  { id: 'settings', href: '/settings', label: 'Nastavení', icon: SlidersHorizontal },
];

describe('formatDocumentTitle', () => {
  it('composes "<Product> — <Page>" and drops the separator when there is no page name', () => {
    expect(formatDocumentTitle('Elowen', 'Domů')).toBe('Elowen — Domů');
    expect(formatDocumentTitle('Elowen')).toBe('Elowen');
  });

  it('carries the white-label product name rather than a hardcoded one', () => {
    expect(formatDocumentTitle('Sarah Hair', 'Nastavení')).toBe('Sarah Hair — Nastavení');
  });
});

describe('navPageTitle — the page name comes from the navigation, not from a list', () => {
  it('names a core page with the label the menu shows for it', () => {
    expect(navPageTitle(entries, '/dash')).toBe('Domů');
    expect(navPageTitle(entries, '/memory')).toBe('Paměť');
    expect(navPageTitle(entries, '/settings')).toBe('Nastavení');
  });

  it("names a plugin page from the plugin's own declared page label", () => {
    expect(navPageTitle(entries, '/p/work/kanban')).toBe('Kanban');
    expect(navPageTitle(entries, '/p/work/tasks')).toBe('Úkoly');
  });

  it('names a plugin world by the world label on its own base route', () => {
    expect(navPageTitle(entries, '/p/work')).toBe('Práce');
  });

  // The longest match wins, so a detail view inherits the page it belongs to instead of falling all the
  // way back to the world's base — /p/work/tasks/12 is Tasks, not Work.
  it('lets a detail route inherit its page', () => {
    expect(navPageTitle(entries, '/p/work/tasks/12')).toBe('Úkoly');
    expect(navPageTitle(entries, '/p/work/unlisted')).toBe('Práce');
  });

  it('names nothing for an address the navigation does not cover', () => {
    expect(navPageTitle(entries, '/p/ghost')).toBeUndefined();
    // A prefix that is not a path boundary must not match: /dashboard is not under /dash.
    expect(navPageTitle(entries, '/dashboard')).toBeUndefined();
  });
});

describe('resolveDocumentTitle — fallbacks', () => {
  it('prefers the navigation name so the tab and the menu say the same thing', () => {
    expect(resolveDocumentTitle({ appName: 'Elowen', pathname: '/dash', entries, headerTitle: 'Přehled' }))
      .toBe('Elowen — Domů');
  });

  it('falls back to the title the page published when the navigation names the address nowhere', () => {
    // A non-admin on /settings, or a plugin missing from the listing: the entry is absent from the nav
    // model, but the page still publishes its masthead title.
    expect(resolveDocumentTitle({ appName: 'Elowen', pathname: '/p/ghost', entries, headerTitle: 'Ghost' }))
      .toBe('Elowen — Ghost');
  });

  it('falls back to the bare product name when nothing names the page', () => {
    expect(resolveDocumentTitle({ appName: 'Elowen', pathname: '/p/ghost', entries })).toBe('Elowen');
    expect(resolveDocumentTitle({ appName: 'Elowen', pathname: '/p/ghost', entries, headerTitle: '  ' }))
      .toBe('Elowen');
  });

  it('survives an empty navigation model — the menu is still loading, the tab is not blank', () => {
    expect(resolveDocumentTitle({ appName: 'Elowen', pathname: '/dash', entries: [] })).toBe('Elowen');
  });
});
