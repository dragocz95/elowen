import type { ElowenApp, RouteContext } from '../context.js';

/** Instance-wide maintenance the operator drives from Settings. Core-owned: it must run on an instance
 *  with no task-tracking plugin at all (it also wipes the activity feed and stops stray agent sessions),
 *  so the task half goes through the optional store seam and simply reports zero when its owner is gone. */
export function registerAdminRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, log, notAdmin } = ctx;
  // Admin maintenance: wipe ALL operational data — tasks (+deps), missions, the activity feed — and
  // stop every live agent session. Projects, users and config are kept. Irreversible; admin-only.
  app.post('/admin/cleanup', async c => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    // Stop missions cleanly first (kills their agents + drains overseers), then sweep any remaining
    // elowen- sessions (manual launches / zombies) so no agent keeps running against deleted tasks.
    // A teardown that FAILS aborts the wipe: erasing every task and mission row while an agent is
    // still live leaves it editing checkouts with nothing left in the DB to find or stop it by.
    const liveMissions = d.missions.live();
    // Same teardown-first invariant as the epic delete: a live mission with no engine (agents plugin
    // disabled) cannot be stopped, so the wipe must refuse instead of erasing rows under live agents.
    if (liveMissions.length > 0 && !d.engine) return c.json({ error: 'agents plugin is disabled' }, 503);
    try {
      for (const m of liveMissions) await d.engine?.disengage(m.id);
    } catch (e) {
      log.error('cleanup aborted — mission disengage failed', e);
      return c.json({ error: 'mission teardown failed' }, 500);
    }
    const sessions = (await d.tmux.list()).filter((s) => s.startsWith('elowen-'));
    for (const s of sessions) await d.tmux.kill(s).catch(() => { /* verified below */ });
    // A kill fails routinely for a session that exited on its own, so the kill itself proves nothing —
    // re-read the live list and judge by what actually survived. Sessions spawned after the sweep
    // started are not ours to account for, so only the ones we tried to kill are checked.
    const surviving = (await d.tmux.list()).filter((s) => sessions.includes(s));
    if (surviving.length > 0) {
      log.error(`cleanup aborted — agent sessions survived teardown: ${surviving.join(', ')}`);
      return c.json({ error: 'agent teardown failed' }, 500);
    }
    // Free every mission's on-disk worktree (and its mission_pr row) before deleteAll() wipes the DB —
    // the disengage sweep above only reaches 'active'/'stalled' missions, but a paused or naturally-
    // completed one still holds a worktree for the pause/PR-feedback path. cleanup() is a no-op for a
    // mission with no PR record, so calling it for every mission id here is safe.
    try {
      for (const missionId of d.tasks?.listMissionIds() ?? []) await d.missionGit?.cleanup(missionId);
    } catch (e) {
      log.error('cleanup aborted — worktree cleanup failed', e);
      return c.json({ error: 'mission teardown failed' }, 500);
    }
    // With an owner the wipe goes through its store; with none it goes through core's own tolerant
    // handle on the same tables. It must NOT report zero and stop there: disabling a plugin drops no
    // table, so the rows are still present, and "wiped" over a register that comes back on re-enable is
    // exactly the dishonest success the cascade doctrine (store/db.ts) exists to prevent.
    const removed = d.tasks?.deleteAll() ?? d.taskRefs?.sweepAll() ?? { tasks: 0, missions: 0 };
    const events = d.events?.deleteAll() ?? 0;
    return c.json({ ok: true, tasks: removed.tasks, missions: removed.missions, events });
  });
}
