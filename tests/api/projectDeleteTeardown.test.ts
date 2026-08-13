import { describe, it, expect } from 'vitest';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import type { AgentsMissionGit } from '../../src/plugins/api.js';

/** DELETE /projects/:id must free every mission's on-disk worktree BEFORE the cascade erases the rows
 *  that point at it — the epic task row is how missionGit resolves the worktree, so once it is gone the
 *  directory can no longer be found by anything. The teardown loop used to walk the plugin's task store
 *  only, so with the work plugin disabled it walked NOTHING while the cascade still deleted the rows:
 *  a silent disk leak plus an unstoppable live mission. Core keeps its own tolerant view of exactly the
 *  fields this needs (TaskRefs, which already carries `type`), so the teardown works with or without an
 *  owner for the task domain. */
function makeApp(opts: { missionGit?: AgentsMissionGit; engine?: undefined } = {}) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'victim','/v')").run();
  const bus = new EventBus();
  const app = createServer({
    taskRefs: new TaskRefs(db),
    missions: new MissionStore(db), bus, tmux: new FakeTmuxDriver(),
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), projects: new ProjectStore(db),
    ...(opts.missionGit ? { missionGit: opts.missionGit } : {}),
  });
  return { app, db };
}

/** Records which missions were freed; every other member throws — this route must touch nothing else. */
function fakeMissionGit(): AgentsMissionGit & { freed: string[] } {
  const unused = () => { throw new Error('not part of the project-delete teardown'); };
  const freed: string[] = [];
  return {
    freed,
    cleanup: async (missionId: string) => { freed.push(missionId); },
    worktreeFor: unused, prInfo: unused, pendingPrMissionIds: unused, openPr: unused,
    mergePr: unused, appendFixPhase: unused, commitPhase: unused,
  } as AgentsMissionGit & { freed: string[] };
}

describe('deleting a project with the task domain unowned', () => {
  it('still frees the worktree of every mission it is about to erase', async () => {
    const missionGit = fakeMissionGit();
    const { app, db } = makeApp({ missionGit });
    try {
      db.prepare("INSERT INTO tasks (id,project_id,title,type) VALUES ('e-9',2,'Epic','epic')").run();
      db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-e-9','e-9','low','disengaged')").run();
      db.prepare("INSERT INTO mission_pr (mission_id,branch,worktree) VALUES ('m-e-9','b','/v/wt')").run();

      const res = await app.request('/projects/2', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(missionGit.freed).toEqual(['m-e-9']);
      expect((db.prepare("SELECT COUNT(*) c FROM tasks WHERE project_id = 2").get() as { c: number }).c).toBe(0);
    } finally { db.close(); }
  });

  // The same blindness hid a LIVE mission: with no engine to stop it, the delete must refuse rather than
  // erase the only rows by which the running agent could still be found.
  it('refuses when a live mission cannot be stopped', async () => {
    const { app, db } = makeApp({ missionGit: fakeMissionGit() });
    try {
      db.prepare("INSERT INTO tasks (id,project_id,title,type) VALUES ('e-8',2,'Epic','epic')").run();
      db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-e-8','e-8','low','active')").run();

      const res = await app.request('/projects/2', { method: 'DELETE' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'agents plugin is disabled' });
      // Nothing was erased — the project and its epic are still there to act on.
      expect((db.prepare("SELECT COUNT(*) c FROM tasks WHERE project_id = 2").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) c FROM projects WHERE id = 2").get() as { c: number }).c).toBe(1);
    } finally { db.close(); }
  });

  // A project with no task rows at all must still delete cleanly (and free nothing).
  it('deletes a project that never had tasks', async () => {
    const missionGit = fakeMissionGit();
    const { app, db } = makeApp({ missionGit });
    try {
      expect((await app.request('/projects/2', { method: 'DELETE' })).status).toBe(200);
      expect(missionGit.freed).toEqual([]);
      expect((db.prepare("SELECT COUNT(*) c FROM projects WHERE id = 2").get() as { c: number }).c).toBe(0);
    } finally { db.close(); }
  });
});
