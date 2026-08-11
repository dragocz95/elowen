'use client';

import { useMemo } from 'react';
import { CircleUserRound, Settings2 } from 'lucide-react';
import { NAVIGATION_WORLDS, SYSTEM_MODULES } from '../../modules/registry';
import { useMe, usePluginUi } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { pluginNavEntries } from '../../lib/pluginNav';
import type { NavEntry } from './NavItem';

/** One registry-driven navigation model shared by the orbital desktop shell and mobile drawer. */
export function useShellNavigation(): { worlds: NavEntry[]; systemItems: NavEntry[] } {
  const me = useMe();
  const { t, locale } = useTranslation();
  const isAdmin = me.data?.user?.is_admin ?? false;
  // Plugin worlds ride the same live query cache as the rest of the chrome: a plugin toggle
  // invalidates the listing and the sidebar updates without a reload.
  const pluginUi = usePluginUi(locale);

  const worlds = useMemo<NavEntry[]>(() => [
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

  return { worlds, systemItems };
}
