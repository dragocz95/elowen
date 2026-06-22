import type { Db } from './db.js';

/** Delete tasks and everything scoped to them — the missions they drove and their dependency edges
 *  (in FK-safe order) — for either a whole project or an epic's subtree. The schema has no FK
 *  cascade, so this is the single source of truth for that teardown, shared by project removal and
 *  epic/mission deletion. Caller is responsible for its own transaction and for any non-task rows
 *  (a project also drops agents and access grants). Returns how many task rows were removed.
 *
 *  - 'project': every task with `project_id = id`.
 *  - 'epic': the task `id` and its whole descendant subtree. */
export function deleteTasksAndDeps(db: Db, scope: 'project' | 'epic', id: string | number): number {
  const ids: string[] = scope === 'project'
    ? (db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(id) as { id: string }[]).map((r) => r.id)
    : [String(id), ...(db.prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM tasks WHERE parent_id = @root
           UNION
           SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id
         )
         SELECT id FROM sub`
      ).all({ root: id }) as { id: string }[]).map((r) => r.id)];
  if (ids.length === 0) return 0;
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM missions WHERE epic_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM task_deps WHERE task_id IN (${ph}) OR depends_on_id IN (${ph})`).run(...ids, ...ids);
  return db.prepare(`DELETE FROM tasks WHERE id IN (${ph})`).run(...ids).changes;
}
