'use client';

import { useEffect, useMemo, useState } from 'react';
import { CircleUserRound } from 'lucide-react';
import { NAVIGATION_WORLDS, SYSTEM_MODULES } from '../../modules/registry';
import { useMe, useMyNavSettings, usePluginUi } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { pluginNavEntries } from '../../lib/pluginNav';
import { EMPTY_NAV_LAYOUT, applyNavLayout, parseNavLayout } from '../../lib/navLayout';

/** Where this browser remembers the last layout the server confirmed, so the menu never paints in the
 *  wrong order first. It is a cache, never the source of truth.
 *
 *  Keyed per account, because the arrangement is per account and a browser is not. On a shared machine a
 *  single key means the next person to sign in paints with the previous one's order and hidden entries —
 *  and if their own read then fails, keeps them. */
const navLayoutCacheKey = (userId: number) => `elowen.nav.layout.${userId}`;
import type { NavLayout } from '../../lib/types';
import type { NavEntry } from './navEntry';

/** One registry-driven navigation model shared by the orbital desktop shell and mobile drawer.
 *
 *  `worlds` is what the menu shows: the registry order with the user's own arrangement applied.
 *  `allWorlds` is the unfiltered set, which the menu needs in order to offer hidden entries back.
 *
 *  Account, Settings and Users are ordinary entries in that same set. They used to be a fixed section
 *  the layout could not touch, which meant half the menu could be arranged and half could not — and the
 *  half you could not move sat in the middle of the other half. */
export function useShellNavigation(): { worlds: NavEntry[]; allWorlds: NavEntry[]; layout: NavLayout; layoutReady: boolean } {
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
  //  The cached layout carries the account it was read for. Until that matches the account currently
  //  signed in, there is no trusted cache and the menu falls back to registry order — one render in the
  //  wrong order beats one render of somebody else's menu.
  const userId = me.data?.user?.id ?? null;
  const [cache, setCache] = useState<{ userId: number; layout: NavLayout } | null>(null);
  useEffect(() => {
    if (userId === null) { setCache(null); return; }
    try {
      // The pre-per-account key. Left alone it would sit in the browser forever holding whichever
      // account happened to write it last, which is the whole problem this key change exists to fix.
      localStorage.removeItem('elowen.nav.layout');
      const raw = localStorage.getItem(navLayoutCacheKey(userId));
      const parsed = raw === null ? null : parseNavLayout(JSON.parse(raw) as unknown);
      setCache(parsed === null ? null : { userId, layout: parsed });
    } catch { setCache(null); /* private mode or malformed cache — registry order is a fine fallback */ }
  }, [userId]);
  const cachedLayout = cache !== null && cache.userId === userId ? cache.layout : null;
  useEffect(() => {
    if (userId === null || !navSettings.data) return;
    try { localStorage.setItem(navLayoutCacheKey(userId), JSON.stringify(navSettings.data)); } catch { /* quota */ }
  }, [userId, navSettings.data]);
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
    { id: 'account', href: '/account', label: t.nav.account, icon: CircleUserRound },
    ...(isAdmin ? SYSTEM_MODULES.map<NavEntry>((module) => ({
      id: module.id,
      href: module.route,
      label: t.nav[module.id as keyof typeof t.nav] ?? module.label,
      icon: module.icon,
    })) : []),
  ], [t, pluginUi.data, isAdmin]);

  const worlds = useMemo<NavEntry[]>(() => applyNavLayout(allWorlds, layout), [allWorlds, layout]);

  return { worlds, allWorlds, layout, layoutReady };
}
