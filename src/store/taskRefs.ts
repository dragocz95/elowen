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
}
