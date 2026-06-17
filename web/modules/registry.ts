import type { ModuleMeta, ModuleGroup } from './types';
import { meta as dashboard } from './dashboard/meta';
import { meta as tasks } from './tasks/meta';
import { meta as sessions } from './sessions/meta';
import { meta as missions } from './missions/meta';
import { meta as settings } from './settings/meta';

export const MODULES: ModuleMeta[] = [dashboard, tasks, sessions, missions, settings];

const GROUP_ORDER: ModuleGroup[] = ['Operate', 'Config'];

export function modulesByGroup(): { group: ModuleGroup; items: ModuleMeta[] }[] {
  return GROUP_ORDER.map((group) => ({ group, items: MODULES.filter((m) => m.group === group) }));
}
