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

/** POST /admin/cleanup wipes every mission row, so it must free every mission's on-disk worktree on the
 *  way past: `mission_pr` is the only place the directory is named, and once that row is gone nothing can
 *  find it again. The loop that frees them walked the WORK plugin's store only, which answers empty on an
 *  install where no plugin owns the task domain — while the wipe nine lines below deletes the same rows
 *  through core's own tolerant handle. The two halves have to agree about which install shapes they run
 *  in, and this pins both cells the asymmetry left open. */
function makeApp(opts: { missionGit?: AgentsMissionGit; agentsAbsent?: boolean } = {}) {
  const db = openPluginTablesDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const app = createServer({
    // No `tasks`: the work plugin is not installed, so the task domain has no owner. The ROWS are still
    // here — disabling or removing a plugin drops no table.
    taskRefs: new TaskRefs(db),
    missions: opts.agentsAbsent ? absentMissions() : new RefMissions(db),
    bus: new EventBus(), tmux: new FakeTmuxDriver(),
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), projects: new ProjectStore(db),
    ...(opts.missionGit ? { missionGit: opts.missionGit } : {}),
  });
  return { app, db };
}

/** The `missions` seam as the daemon builds it with the agents plugin absent (daemon/bootstrap.ts):
 *  the control is undefined and every read degrades to empty. */
function absentMissions(): AgentsMissions {
  return { get: () => null, active: () => [], live: () => [], activeForEpic: () => null };
}

function recordingMissionGit(): AgentsMissionGit & { freed: string[] } {
  const unused = () => { throw new Error('not part of the admin cleanup'); };
  const freed: string[] = [];
  return {
    freed,
    cleanup: async (missionId: string) => { freed.push(missionId); },
    worktreeFor: unused, prInfo: unused, pendingPrMissionIds: unused, openPr: unused,
    mergePr: unused, appendFixPhase: unused, commitPhase: unused,
  } as AgentsMissionGit & { freed: string[] };
}

/** Seed one settled mission holding a worktree. 'disengaged' so the live-mission gate — a different
 *  refusal — is never what these tests measure. */
function seedMissionWithWorktree(db: ReturnType<typeof openPluginTablesDb>, id: string): void {
  db.prepare(`INSERT INTO tasks (id,project_id,title,type) VALUES ('e-${id}',1,'Epic','epic')`).run();
  db.prepare(`INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-${id}','e-${id}','low','disengaged')`).run();
  db.prepare(`INSERT INTO mission_pr (mission_id,branch,worktree) VALUES ('m-${id}','b','/wt/${id}')`).run();
}

describe('admin cleanup with the task domain unowned', () => {
  // The agents plugin IS here, so the worktrees have an owner that can free them — but the ids were read
  // from the absent work plugin, so the loop had nothing to iterate and every directory was left on disk
  // while the wipe erased the rows naming them.
  it('frees the worktree of every mission it is about to erase', async () => {
    const missionGit = recordingMissionGit();
    const { app, db } = makeApp({ missionGit });
    try {
      seedMissionWithWorktree(db, 'a');
      seedMissionWithWorktree(db, 'b');

      const res = await app.request('/admin/cleanup', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(missionGit.freed.sort()).toEqual(['m-a', 'm-b']);
      expect((db.prepare('SELECT COUNT(*) c FROM mission_pr').get() as { c: number }).c).toBe(0);
    } finally { db.close(); }
  });

  // With NEITHER owner present nothing can free the directories, so the wipe must refuse rather than
  // delete the last record of them. The remedy is recoverable: re-enable the agents plugin and run it
  // again. Losing the directories is not.
  it('refuses when a worktree exists and nothing owns it', async () => {
    const { app, db } = makeApp({ agentsAbsent: true });
    try {
      seedMissionWithWorktree(db, 'c');

      const res = await app.request('/admin/cleanup', { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'agents plugin is disabled' });
      // Everything the operator needs to recover is still on record.
      expect((db.prepare("SELECT worktree FROM mission_pr WHERE mission_id = 'm-c'").get() as { worktree: string } | undefined)?.worktree).toBe('/wt/c');
      expect((db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c).toBe(1);
    } finally { db.close(); }
  });

  // The refusal has to stay narrow, or an instance that never had the agents plugin could never run
  // maintenance at all: a mission with no worktree strands nothing, and the wipe proceeds.
  it('still wipes when the missions hold no worktree', async () => {
    const { app, db } = makeApp({ agentsAbsent: true });
    try {
      db.prepare("INSERT INTO tasks (id,project_id,title,type) VALUES ('e-d',1,'Epic','epic')").run();
      db.prepare("INSERT INTO missions (id,epic_id,autonomy,state) VALUES ('m-d','e-d','low','disengaged')").run();

      const res = await app.request('/admin/cleanup', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, tasks: 1, missions: 1 });
      expect((db.prepare('SELECT COUNT(*) c FROM missions').get() as { c: number }).c).toBe(0);
    } finally { db.close(); }
  });
});
