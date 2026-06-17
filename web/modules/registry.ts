import type { ModuleMeta, ModuleGroup } from './types';
import { meta as dashboard } from './dashboard/meta';
import { meta as tasks } from './tasks/meta';
import { meta as kanban } from './kanban/meta';
import { meta as sessions } from './sessions/meta';
import { meta as missions } from './missions/meta';
import { meta as settings } from './settings/meta';
import { meta as users } from './users/meta';

export const MODULES: ModuleMeta[] = [dashboard, tasks, kanban, sessions, missions, settings, users];

const GROUP_ORDER: ModuleGroup[] = ['Operate', 'Config'];

export function modulesByGroup(): { group: ModuleGroup; items: ModuleMeta[] }[] {
  return GROUP_ORDER.map((group) => ({ group, items: MODULES.filter((m) => m.group === group) }));
}
