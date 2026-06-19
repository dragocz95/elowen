import type { Task } from './types.js';
import type { TaskStore } from './taskStore.js';
import type { Mission, MissionStore } from './missionStore.js';

interface MissionProgress {
  total: number; open: number; inProgress: number; blocked: number; closed: number; cancelled: number;
}
export interface MissionDetail {
  mission: Mission;
  epic: Task | null;
  tasks: Task[];
  deps: { taskId: string; dependsOnId: string }[];
  progress: MissionProgress;
}

export function assembleMissionDetail(
  stores: { missions: MissionStore; tasks: TaskStore },
  missionId: string,
): MissionDetail | null {
  const mission = stores.missions.get(missionId);
  if (!mission) return null;
  const epic = stores.tasks.get(mission.epic_id);
  const tasks = stores.tasks.descendants(mission.epic_id);
  const ids = [mission.epic_id, ...tasks.map((t) => t.id)];
  const deps = stores.tasks
    .depsAmong(ids)
    .map((d) => ({ taskId: d.task_id, dependsOnId: d.depends_on_id }));
  const progress: MissionProgress = {
    total: tasks.length,
    open: tasks.filter((t) => t.status === 'open').length,
    inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    closed: tasks.filter((t) => t.status === 'closed').length,
    cancelled: tasks.filter((t) => t.status === 'cancelled').length,
  };
  return { mission, epic, tasks, deps, progress };
}
