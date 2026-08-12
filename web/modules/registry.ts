import type { ModuleMeta } from './types';
import { meta as dashboard } from './dashboard/meta';
import { meta as settings } from './settings/meta';
import { meta as projects } from './projects/meta';
import { meta as users } from './users/meta';
import { meta as memory } from './memory/meta';
import { meta as chat } from './chat/meta';

export const MODULES: ModuleMeta[] = [dashboard, settings, projects, users, memory, chat];

/**
 * Product navigation is intentionally smaller than the module registry. Modules keep their
 * independent routes (and remain discoverable in the command palette), while the shell presents
 * a few stable user-facing worlds. This keeps route compatibility separate from information
 * architecture, so regrouping the UI never requires redirects or aliases.
 *
 * A plugin's pages are NOT listed here: they arrive at runtime from the /plugins/ui listing
 * (`lib/pluginNav.ts`), so a world exists exactly while the plugin that owns it is enabled. The work
 * world (tasks, kanban, timeline, stats) left with the work plugin, the way sessions and the editor
 * did before it.
 */
type NavigationWorldId = 'home' | 'chat' | 'projects' | 'memory';

export interface NavigationWorld {
  id: NavigationWorldId;
  route: string;
  icon: ModuleMeta['icon'];
  children: readonly ModuleMeta[];
}

export const NAVIGATION_WORLDS: readonly NavigationWorld[] = [
  { id: 'home', route: dashboard.route, icon: dashboard.icon, children: [] },
  { id: 'chat', route: chat.route, icon: chat.icon, children: [] },
  { id: 'projects', route: projects.route, icon: projects.icon, children: [projects] },
  { id: 'memory', route: memory.route, icon: memory.icon, children: [] },
] as const;

export const SYSTEM_MODULES: readonly ModuleMeta[] = [settings, users] as const;

function routeMatches(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export function navigationWorldForPath(pathname: string): NavigationWorld | undefined {
  return NAVIGATION_WORLDS.find((world) => (
    routeMatches(pathname, world.route)
    || world.children.some((module) => routeMatches(pathname, module.route))
  ));
}

