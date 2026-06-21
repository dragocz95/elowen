import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { assembleMissionDetail } from '../../src/store/missionDetail.js';

let tasks: TaskStore; let missions: MissionStore;
beforeEach(() => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/var/www/orca')").run();
  tasks = new TaskStore(db); missions = new MissionStore(db);
});

describe('assembleMissionDetail', () => {
  it('returns null for an unknown mission', () => {
    expect(assembleMissionDetail({ missions, tasks }, 'nope')).toBeNull();
  });

  it('assembles epic, descendant tasks, deps and progress', () => {
    tasks.create({ id: 'epic', project_id: 1, title: 'Epic', type: 'epic' });
    tasks.create({ id: 'a', project_id: 1, title: 'A', parent_id: 'epic' });
    tasks.create({ id: 'b', project_id: 1, title: 'B', parent_id: 'epic' });
    tasks.addDep('b', 'a');
    tasks.setStatus('a', 'closed');
    missions.create({ id: 'm1', epic_id: 'epic', autonomy: 'low', max_sessions: 1 });
    const d = assembleMissionDetail({ missions, tasks }, 'm1')!;
    expect(d.epic?.id).toBe('epic');
    expect(d.tasks.map((t) => t.id).sort()).toEqual(['a', 'b']);
    expect(d.deps).toEqual([{ taskId: 'b', dependsOnId: 'a' }]);
    expect(d.progress).toEqual({ total: 2, open: 1, inProgress: 0, blocked: 0, closed: 1, cancelled: 0 });
  });
});
