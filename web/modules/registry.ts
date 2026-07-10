import type { ModuleMeta, ModuleGroup } from './types';
import { meta as dashboard } from './dashboard/meta';
import { meta as stats } from './stats/meta';
import { meta as tasks } from './tasks/meta';
import { meta as kanban } from './kanban/meta';
import { meta as timeline } from './timeline/meta';
import { meta as escalations } from './escalations/meta';
import { meta as sessions } from './sessions/meta';
import { meta as settings } from './settings/meta';
import { meta as projects } from './projects/meta';
import { meta as editor } from './editor/meta';
import { meta as users } from './users/meta';
import { meta as memory } from './memory/meta';

export const MODULES: ModuleMeta[] = [dashboard, stats, tasks, kanban, timeline, escalations, sessions, settings, projects, editor, users, memory];

/**
 * Product navigation is intentionally smaller than the module registry. Modules keep their
 * independent routes (and remain discoverable in the command palette), while the shell presents
 * four stable user-facing worlds. This keeps route compatibility separate from information
 * architecture, so regrouping the UI never requires redirects or aliases.
 */
type NavigationWorldId = 'home' | 'work' | 'projects' | 'memory';

export interface NavigationWorld {
  id: NavigationWorldId;
  route: string;
  icon: ModuleMeta['icon'];
  children: readonly ModuleMeta[];
}

export const NAVIGATION_WORLDS: readonly NavigationWorld[] = [
  { id: 'home', route: dashboard.route, icon: dashboard.icon, children: [] },
  { id: 'work', route: tasks.route, icon: tasks.icon, children: [tasks, kanban, sessions, timeline, stats] },
  { id: 'projects', route: projects.route, icon: projects.icon, children: [projects, editor] },
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

const GROUP_ORDER: ModuleGroup[] = ['Operate', 'Config'];

export function modulesByGroup(): { group: ModuleGroup; items: ModuleMeta[] }[] {
  return GROUP_ORDER.map((group) => ({ group, items: MODULES.filter((m) => m.group === group) }));
}
