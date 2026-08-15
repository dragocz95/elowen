import { deleteAllTaskRows } from './cascade.js';
import { tolerateMissingPluginTables } from './db.js';
import type { Db } from './db.js';

/** The few task fields the daemon's own tenancy decisions read. Deliberately NOT the full task: this is
 *  a reference view, not a store. */
export interface TaskRef {
  id: string;
  project_id: number;
  parent_id: string | null;
  labels: string[];
  status: string;
  type: string;
}

type Row = Omit<TaskRef, 'labels'> & { labels: string };
const toRef = (r: Row): TaskRef => ({ ...r, labels: r.labels ? r.labels.split(',').filter(Boolean) : [] });

/** Read-only, tolerant view of the task rows FOR THE TENANCY BOUNDARY — which projects an agent-scoped
 *  token may touch, which project an event belongs to, which task a bound token was minted for.
 *
 *  It stays in the daemon on purpose even though the task domain itself is plugin-owned: the boundary
 *  that decides what a plugin's callers may reach must not be served by a plugin, and the answer has to
 *  exist before any plugin is loaded (the auth middleware runs on the first request of a boot). With no
 *  task table at all — a fresh install whose task plugin is disabled — every read answers empty, which
 *  fails CLOSED: an agent token then sees no project rather than all of them. */
export class TaskRefs {
  private static readonly COLUMNS = 'SELECT id, project_id, parent_id, labels, status, type FROM tasks';
  // Statements are prepared on FIRST USE, not in the constructor, and memoized after: preparing eagerly
  // would throw at construction on an install whose task table does not exist — the exact shape this
  // class exists to survive — and re-preparing per call would pay the parse on every request.
  private stmts: { all: ReturnType<Db['prepare']>; get: ReturnType<Db['prepare']> } | undefined;
  constructor(private db: Db) {}
  private prepared() {
    this.stmts ??= { all: this.db.prepare(TaskRefs.COLUMNS), get: this.db.prepare(`${TaskRefs.COLUMNS} WHERE id = ?`) };
    return this.stmts;
  }
  all(): TaskRef[] {
    return tolerateMissingPluginTables(() => (this.prepared().all.all([]) as Row[]).map(toRef), []);
  }
  get(id: string): TaskRef | null {
    return tolerateMissingPluginTables(() => {
      const r = this.prepared().get.get(id) as Row | undefined;
      return r ? toRef(r) : null;
    }, null);
  }

  /** What core's DESTRUCTIVE paths need to know about the mission driving an epic, read straight from the
   *  rows instead of through the agents plugin's read seam.
   *
   *  The seam answers null for every mission while the plugin is absent, which is indistinguishable from
   *  "this epic never had one" — but the ROWS outlive the plugin and the cascade deletes them regardless.
   *  A teardown that trusted the seam therefore erased a live mission's only records, and erased the
   *  `mission_pr` row that is the ONLY thing naming the worktree on disk, leaving the directory (possibly
   *  holding uncommitted work, possibly with an agent still writing into it) unreachable by anything.
   *
   *  `worktree` is null when the mission never opened one. No table at all — a fresh install whose agents
   *  plugin was never here — answers null, the honest "there is no mission", the same fail-closed
   *  direction as the reads above. */
  missionTeardown(missionId: string): { state: string; worktree: string | null } | null {
    // Two tolerant reads rather than a join: a database may hold one of these tables without the other
    // (a partially applied plugin migration), and losing the mission STATE because the PR table is
    // missing would silently re-open the live-mission hole this method exists to close.
    const state = tolerateMissingPluginTables(
      () => (this.db.prepare('SELECT state FROM missions WHERE id = ?').get(missionId) as { state: string } | undefined)?.state ?? null,
      null);
    if (state === null) return null;
    const worktree = tolerateMissingPluginTables(
      () => (this.db.prepare('SELECT worktree FROM mission_pr WHERE mission_id = ?').get(missionId) as { worktree: string | null } | undefined)?.worktree ?? null,
      null);
    return { state, worktree };
  }

  /** Every mission id, for the instance-wide teardown that has to free their worktrees before the wipe.
   *  The owner's own `listMissionIds()` is used when there is one; this is the same answer for an install
   *  where no plugin owns the task domain, in which case that call reports zero over rows that are still
   *  there. */
  missionIds(): string[] {
    return tolerateMissingPluginTables(
      () => (this.db.prepare('SELECT id FROM missions').all() as { id: string }[]).map((r) => r.id), []);
  }

  /** The instance-wide task wipe behind the admin cleanup, for the case where NO plugin owns the domain.
   *  It is here rather than in a store of its own because this class is already the core's tolerant
   *  handle on these grandfathered tables — the one place core keeps a Db on them across every install
   *  shape (ProjectStore holds the other, for its own cascade). Reads stay the tenancy view; this is the
   *  single WRITE, and only the maintenance route calls it. When the domain HAS an owner the route uses
   *  the owner's own deleteAll instead, so this never runs behind a live store. */
  sweepAll(): { tasks: number; missions: number } {
    return deleteAllTaskRows(this.db);
  }

  /** The same tolerant WRITE for the usage snapshots alone, behind the stats reset. Disabling the owning
   *  plugin drops no table, so without this the reset would report a cheerful zero over rows that come
   *  straight back when the plugin returns — the dishonest success `sweepAll` exists to prevent, just on
   *  a different table. */
  sweepUsage(): number {
    return tolerateMissingPluginTables(() => this.db.prepare('DELETE FROM task_usage').run().changes, 0);
  }
}
