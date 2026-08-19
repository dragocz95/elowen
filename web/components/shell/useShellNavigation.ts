'use client';

import { useEffect, useMemo, useState } from 'react';
import { CircleUserRound, Settings2 } from 'lucide-react';
import { NAVIGATION_WORLDS, SYSTEM_MODULES } from '../../modules/registry';
import { useMe, useMyNavSettings, usePluginUi } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { pluginNavEntries } from '../../lib/pluginNav';
import { EMPTY_NAV_LAYOUT, applyNavLayout, parseNavLayout } from '../../lib/navLayout';

/** Where this browser remembers the last layout the server confirmed, so the menu never paints in the
 *  wrong order first. It is a cache, never the source of truth. */
const NAV_LAYOUT_CACHE_KEY = 'elowen.nav.layout';
import type { NavLayout } from '../../lib/types';
import type { NavEntry } from './navEntry';

/** One registry-driven navigation model shared by the orbital desktop shell and mobile drawer.
 *
 *  `worlds` is what the menu shows: the registry order with the user's own arrangement applied.
 *  `allWorlds` is the unfiltered set, which the customization modal needs to offer entries back.
 *  The system section is deliberately not customizable — hiding the way into settings would be a trap. */
export function useShellNavigation(): { worlds: NavEntry[]; systemItems: NavEntry[]; allWorlds: NavEntry[]; layout: NavLayout; layoutReady: boolean } {
  const me = useMe();
  const { t, locale } = useTranslation();
  const isAdmin = me.data?.user?.is_admin ?? false;
  // Plugin worlds ride the same live query cache as the rest of the chrome: a plugin toggle
  // invalidates the listing and the sidebar updates without a reload.
  const pluginUi = usePluginUi(locale);
  const navSettings = useMyNavSettings();
  // The arrangement is the user's and the server owns it, but waiting a whole round trip for it means
  // the menu paints in registry order and visibly rearranges itself once the answer lands — on every
  // single page load. So the last known layout is mirrored into this browser and used for that first
  // paint; the server's answer overrides it the moment it arrives.
  const [cachedLayout, setCachedLayout] = useState<NavLayout | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(NAV_LAYOUT_CACHE_KEY);
      if (raw !== null) setCachedLayout(parseNavLayout(JSON.parse(raw) as unknown));
    } catch { /* private mode or malformed cache — registry order is a fine fallback */ }
  }, []);
  useEffect(() => {
    if (!navSettings.data) return;
    try { localStorage.setItem(NAV_LAYOUT_CACHE_KEY, JSON.stringify(navSettings.data)); } catch { /* quota */ }
  }, [navSettings.data]);
  // Until the layout has loaded the menu renders in registry order rather than empty, so a slow or
  // failed read costs the arrangement, never the navigation itself.
  const layout = navSettings.data ?? cachedLayout ?? EMPTY_NAV_LAYOUT;
  // Whether the menu is showing an arrangement it can trust. The shells use it to hold their entrance
  // animation until the order is final, so a late correction never plays out as sliding entries.
  const layoutReady = navSettings.data !== undefined || cachedLayout !== null || navSettings.isError;

  const allWorlds = useMemo<NavEntry[]>(() => [
    ...NAVIGATION_WORLDS.map<NavEntry>((world) => ({
      id: world.id,
      href: world.route,
      label: t.nav[world.id],
      icon: world.icon,
      activeRoutes: [world.route, ...world.children.map((module) => module.route)],
      subItems: world.children.length > 0
        ? world.children.map((module) => ({
          id: module.id,
          href: module.route,
          label: t.nav[module.id as keyof typeof t.nav] ?? module.label,
          icon: module.icon,
        }))
        : undefined,
    })),
    ...pluginNavEntries(pluginUi.data ?? []),
  ], [t, pluginUi.data]);

  const worlds = useMemo<NavEntry[]>(() => applyNavLayout(allWorlds, layout), [allWorlds, layout]);

  const systemItems = useMemo<NavEntry[]>(() => {
    const visibleModules = isAdmin ? SYSTEM_MODULES : [];
    return [{
      id: 'system',
      label: t.nav.system,
      icon: Settings2,
      activeRoutes: ['/account', ...visibleModules.map((module) => module.route)],
      subItems: [
        { id: 'account', href: '/account', label: t.nav.account, icon: CircleUserRound },
        ...visibleModules.map((module) => ({
          id: module.id,
          href: module.route,
          label: t.nav[module.id as keyof typeof t.nav] ?? module.label,
          icon: module.icon,
        })),
      ],
    }];
  }, [isAdmin, t]);

  return { worlds, systemItems, allWorlds, layout, layoutReady };
}
