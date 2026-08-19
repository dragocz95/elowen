'use client';

import { useMemo } from 'react';
import { CircleUserRound, Settings2 } from 'lucide-react';
import { NAVIGATION_WORLDS, SYSTEM_MODULES } from '../../modules/registry';
import { useMe, useMyNavSettings, usePluginUi } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { pluginNavEntries } from '../../lib/pluginNav';
import { EMPTY_NAV_LAYOUT, applyNavLayout } from '../../lib/navLayout';
import type { NavLayout } from '../../lib/types';
import type { NavEntry } from './NavItem';

/** One registry-driven navigation model shared by the orbital desktop shell and mobile drawer.
 *
 *  `worlds` is what the menu shows: the registry order with the user's own arrangement applied.
 *  `allWorlds` is the unfiltered set, which the customization modal needs to offer entries back.
 *  The system section is deliberately not customizable — hiding the way into settings would be a trap. */
export function useShellNavigation(): { worlds: NavEntry[]; systemItems: NavEntry[]; allWorlds: NavEntry[]; layout: NavLayout } {
  const me = useMe();
  const { t, locale } = useTranslation();
  const isAdmin = me.data?.user?.is_admin ?? false;
  // Plugin worlds ride the same live query cache as the rest of the chrome: a plugin toggle
  // invalidates the listing and the sidebar updates without a reload.
  const pluginUi = usePluginUi(locale);
  const navSettings = useMyNavSettings();
  // Until the layout has loaded the menu renders in registry order rather than empty, so a slow or
  // failed read costs the arrangement, never the navigation itself.
  const layout = navSettings.data ?? EMPTY_NAV_LAYOUT;

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

  return { worlds, systemItems, allWorlds, layout };
}
