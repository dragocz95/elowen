import type { Db } from './db.js';
import type { Task } from './types.js';

type Row = Omit<Task, 'labels'> & { labels: string };

const toTask = (r: Row): Task => ({ ...r, labels: r.labels ? r.labels.split(',').filter(Boolean) : [] });

// A task is "ready" when it is open, not an epic, and none of its dependencies are still pending
// (i.e. every depends-on row points to a closed/cancelled task). Both queries share this single
// `NOT EXISTS` deps check so readiness logic lives in exactly one place — change it once.
const READY_DEPS_CLEAR = `NOT EXISTS (
  SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on_id
  WHERE d.task_id = t.id AND dt.status NOT IN ('closed', 'cancelled')
)`;

export class Readiness {
  private readyStmt;
  private readyForEpicStmt;

  constructor(private db: Db) {
    // One SQL per call (no N+1): select the open, dependency-cleared tasks directly. Previously this
    // ran 1 + 2N queries per project (ids, then a blocked-count and a row fetch per id).
    this.readyStmt = this.db.prepare(
      `SELECT t.* FROM tasks t
       WHERE t.project_id = ? AND t.status = 'open' AND t.type != 'epic' AND ${READY_DEPS_CLEAR}
       ORDER BY t.created_at`
    );
    // Epic-focused readiness: only the epic's direct children, so a project running several parallel
    // missions doesn't make each one walk every ready task in the project (API finding #34 / S15).
    this.readyForEpicStmt = this.db.prepare(
      `SELECT t.* FROM tasks t
       WHERE t.parent_id = ? AND t.status = 'open' AND t.type != 'epic' AND ${READY_DEPS_CLEAR}
       ORDER BY t.created_at`
    );
  }

  ready(projectId: number): Task[] {
    return (this.readyStmt.all(projectId) as Row[]).map(toTask);
  }

  readyForEpic(epicId: string): Task[] {
    return (this.readyForEpicStmt.all(epicId) as Row[]).map(toTask);
  }
}
