import { describe, it, expect } from 'vitest';
import { TaskRefs } from '../../src/store/taskRefs.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { openPluginTablesDb } from '../helpers/pluginTablesDb.js';
import type { AgentsMissionGit, AgentsMissions } from '../../src/plugins/api.js';
import { RefMissions } from '../helpers/refStores.js';

/** DELETE /projects/:id must free every mission's on-disk worktree BEFORE the cascade erases the rows
 *  that point at it — the epic task row is how missionGit resolves the worktree, so once it is gone the
 *  directory can no longer be found by anything. The teardown loop used to walk the plugin's task store
 *  only, so with the work plugin disabled it walked NOTHING while the cascade still deleted the rows:
 *  a silent disk leak plus an unstoppable live mission. Core keeps its own tolerant view of exactly the
 *  fields this needs (TaskRefs, which already carries `type`), so the teardown works with or without an
 *  owner for the task domain. */
function makeApp(opts: { missionGit?: AgentsMissionGit; engine?: undefined; agentsAbsent?: boolean } = {}) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (2,'victim','/v')").run();
  const bus = new EventBus();
  const app = createServer({
    taskRefs: new TaskRefs(db),
    missions: opts.agentsAbsent ? absentMissions() : new RefMissions(db), bus, tmux: new FakeTmuxDriver(),
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), projects: new ProjectStore(db),
    ...(opts.missionGit ? { missionGit: opts.missionGit } : {}),
  });
  return { app, db };
}

/** The `missions` seam EXACTLY as the daemon builds it when the agents plugin is not loaded
 *  (daemon/bootstrap.ts): the control resolves to undefined and every read degrades to empty. Wiring
 *  a working store here — which is all this file used to do — made the mission guards look reachable
 *  in a shape where production could never reach them, and that is how the leak below survived review.
 *  The mission ROWS still exist in the database, because disabling a plugin drops no table. */
function absentMissions(): AgentsMissions {
  return { get: () => null, active: () => [], live: () => [], activeForEpic: () => null };
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

});

/** The cell nothing covered: the agents plugin is not merely disabled, it is NOT INSTALLED — the state an
 *  upgrade can now land in on its own, because the plugin moved out of the npm package. Its rows and its
 *  worktrees are still on disk; only the code that owns them is gone. */
describe('deleting a project with the agents plugin absent', () => {
  it('refuses rather than erasing the only record naming an on-disk worktree', async () => {
    const { app, db } = makeApp({ agentsAbsent: true }); // no missionGit either — nothing owns worktrees
    try {
      db.prepare("INSERT INTO tasks (id,project_id,title,type) VALUES ('e-7',2,'Epic','epic')").run();
      db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-e-7','e-7','low','disengaged')").run();
      db.prepare("INSERT INTO mission_pr (mission_id,branch,worktree) VALUES ('m-e-7','b','/v/wt')").run();

      const res = await app.request('/projects/2', { method: 'DELETE' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'agents plugin is disabled' });
      // The worktree is still resolvable: the row that names it, the mission and the epic all survive,
      // so re-enabling the plugin and deleting again frees the directory properly.
      expect((db.prepare("SELECT worktree FROM mission_pr WHERE mission_id = 'm-e-7'").get() as { worktree: string } | undefined)?.worktree).toBe('/v/wt');
      expect((db.prepare("SELECT COUNT(*) c FROM projects WHERE id = 2").get() as { c: number }).c).toBe(1);
    } finally { db.close(); }
  });

  // The live-mission guard reads the same seam, so it was unreachable for the same reason: a running
  // agent's rows went while nothing existed that could stop it.
  it('refuses when a live mission cannot be stopped, even though the seam reports none', async () => {
    const { app, db } = makeApp({ agentsAbsent: true, missionGit: fakeMissionGit() });
    try {
      db.prepare("INSERT INTO tasks (id,project_id,title,type) VALUES ('e-6',2,'Epic','epic')").run();
      db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-e-6','e-6','low','active')").run();

      const res = await app.request('/projects/2', { method: 'DELETE' });
      expect(res.status).toBe(503);
      expect((db.prepare("SELECT COUNT(*) c FROM missions WHERE id = 'm-e-6'").get() as { c: number }).c).toBe(1);
    } finally { db.close(); }
  });

  // The refusal must stay narrow: a settled mission that never opened a worktree strands nothing, so the
  // delete proceeds exactly as before.
  it('still deletes when the settled mission holds no worktree', async () => {
    const { app, db } = makeApp({ agentsAbsent: true });
    try {
      db.prepare("INSERT INTO tasks (id,project_id,title,type) VALUES ('e-5',2,'Epic','epic')").run();
      db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-e-5','e-5','low','disengaged')").run();

      expect((await app.request('/projects/2', { method: 'DELETE' })).status).toBe(200);
      expect((db.prepare("SELECT COUNT(*) c FROM projects WHERE id = 2").get() as { c: number }).c).toBe(0);
    } finally { db.close(); }
  });
});

describe('deleting a project with the task domain unowned (continued)', () => {
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
