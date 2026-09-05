import { describe, expect, it } from 'vitest';
import { Home, Settings2 } from 'lucide-react';
import { hrefMatchScore, resolveSidebarRoute } from '../../../components/shell/useSidebarRoute';
import type { NavEntry } from '../../../components/shell/navEntry';

/** The column asks the route two different questions and must not confuse them: which SECTION the
 *  reader is inside (the row that paints as the current place and the sub-menu that has to be open) and
 *  which exact PAGE they are standing on (the single row carrying `aria-current`). A configuration deck
 *  addresses its pages as `?cat=<section>`, so the pathname alone cannot answer the second one. */

const entries: NavEntry[] = [
  { id: 'home', href: '/dash', label: 'Home', icon: Home },
  {
    id: 'settings',
    href: '/settings',
    label: 'Settings',
    icon: Settings2,
    subItems: [
      { id: 'settings-brain', href: '/settings?cat=brain', label: 'Assistant' },
      { id: 'settings-models', href: '/settings?cat=models', label: 'Models' },
    ],
  },
];

describe('hrefMatchScore', () => {
  it('rejects a different path outright', () => {
    expect(hrefMatchScore('/settings', '/dash', '')).toBe(0);
  });

  it('matches a nested page against its section', () => {
    expect(hrefMatchScore('/projects', '/projects/42', '')).toBeGreaterThan(0);
  });

  it('prefers the exact address over the section that contains it', () => {
    const exact = hrefMatchScore('/projects', '/projects', '');
    const nested = hrefMatchScore('/projects', '/projects/42', '');
    expect(exact).toBeGreaterThan(nested);
  });

  it('requires the deck section to agree when the href names one', () => {
    expect(hrefMatchScore('/settings?cat=models', '/settings', '?cat=models')).toBeGreaterThan(0);
    expect(hrefMatchScore('/settings?cat=models', '/settings', '?cat=brain')).toBe(0);
    expect(hrefMatchScore('/settings?cat=models', '/settings', '')).toBe(0);
  });

  it('beats the bare path once the section agrees, so the sub-item wins over its parent', () => {
    expect(hrefMatchScore('/settings?cat=models', '/settings', '?cat=models'))
      .toBeGreaterThan(hrefMatchScore('/settings', '/settings', '?cat=models'));
  });

  it('ignores parameters that are state within a page rather than an address', () => {
    // `?row=` scrolls to a record; it must not split one destination into two rows.
    expect(hrefMatchScore('/settings?cat=models', '/settings', '?cat=models&row=default'))
      .toBeGreaterThan(0);
  });

  it('answers for a fragment the same way it answers for a section', () => {
    expect(hrefMatchScore('/docs#api', '/docs', '', '#api')).toBeGreaterThan(0);
    expect(hrefMatchScore('/docs#api', '/docs', '', '#cli')).toBe(0);
  });
});

describe('resolveSidebarRoute', () => {
  it('reports nothing when no entry owns the route', () => {
    expect(resolveSidebarRoute(entries, '/nowhere')).toEqual({});
  });

  it('names the active entry and the page inside it', () => {
    expect(resolveSidebarRoute(entries, '/dash')).toEqual({ activeId: 'home', currentHref: '/dash' });
  });

  it('opens the sub-menu of the section the reader is in', () => {
    const route = resolveSidebarRoute(entries, '/settings', '?cat=models');
    expect(route.activeId).toBe('settings');
    expect(route.openId).toBe('settings');
    expect(route.currentHref).toBe('/settings?cat=models');
  });

  it('falls back to the section itself when no sub-item names the page', () => {
    const route = resolveSidebarRoute(entries, '/settings');
    expect(route.activeId).toBe('settings');
    expect(route.currentHref).toBe('/settings');
  });

  it('leaves a plain destination with no sub-menu to open', () => {
    expect(resolveSidebarRoute(entries, '/dash').openId).toBeUndefined();
  });
});
