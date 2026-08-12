import type { PluginDbStatement } from '../../../../src/plugins/api.js';

/** The database handle the work domain's stores run on: prepared statements plus a real transaction.
 *  Structurally satisfied by `ctx.db()` (the plugin handle over the daemon's single SQLite file), which
 *  is how the daemon hands it in; a test may build the same shape over a raw better-sqlite3 handle. */
export interface WorkDb {
  prepare(sql: string): PluginDbStatement;
  /** Wrap `fn` into a function that runs it inside ONE transaction (nested calls become savepoints) —
   *  better-sqlite3's own shape, deliberately, so the daemon handle this plugin adapts and a raw sqlite
   *  handle are interchangeable here and the store code reads exactly as it did in the core. */
  transaction<T>(fn: () => T): () => T;
}

/** Run a statement that touches ANOTHER plugin's table, tolerating its absence — the plugin-boundary
 *  twin of the daemon's `tolerateMissingPluginTables`. The task purge deliberately reaches the agents
 *  plugin's mission/note rows (see TaskStore.deleteAll / deleteEpic): a destructive path must purge them
 *  whether or not that plugin is loaded, or orphans resurface when it is re-enabled. Only the
 *  "no such table/column" shape is treated as not-installed; anything else propagates. */
export function tolerateMissingPluginTables<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (e) {
    if (e instanceof Error && /no such (table|column)/i.test(e.message)) return fallback;
    throw e;
  }
}

/** Delete a task and its whole descendant subtree — the rows, their dependency edges, and the missions
 *  (plus PR records and handoff notes) those tasks drove, in FK-safe order. Returns how many task rows
 *  went.
 *
 *  The daemon keeps its OWN teardown for the scopes it still owns (deleting a project or a user must
 *  purge task rows even with this plugin disabled — src/store/cascade.ts). The overlap in SQL is
 *  deliberate: a plugin may not import daemon code at runtime, and routing a destructive core path
 *  through a plugin that may be off would make it skip exactly when it must not. */
export function deleteTaskSubtree(db: WorkDb, rootId: string): number {
  const ids = [rootId, ...(db.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM tasks WHERE parent_id = @root
       UNION
       SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id
     )
     SELECT id FROM sub`
  ).all({ root: rootId }) as { id: string }[]).map((r) => r.id)];
  const ph = ids.map(() => '?').join(',');
  // The PR record goes FIRST, while the `missions` row still maps epic → mission id; the schema has no
  // FK cascade, so skipping it strands a mission_pr row pointing at a worktree whose mission is gone.
  tolerateMissingPluginTables(() => {
    db.prepare(`DELETE FROM mission_pr WHERE mission_id IN (SELECT id FROM missions WHERE epic_id IN (${ph}))`).run(...ids);
    db.prepare(`DELETE FROM missions WHERE epic_id IN (${ph})`).run(...ids);
  }, undefined);
  // Handoff notes are keyed by epic id across ALL scopes — purge them with the task rows or an orphaned
  // note lingers with no project gate left to guard it.
  tolerateMissingPluginTables(() => { db.prepare(`DELETE FROM notes WHERE target IN (${ph})`).run(...ids); }, undefined);
  db.prepare(`DELETE FROM task_deps WHERE task_id IN (${ph}) OR depends_on_id IN (${ph})`).run(...ids, ...ids);
  return db.prepare(`DELETE FROM tasks WHERE id IN (${ph})`).run(...ids).changes;
}
