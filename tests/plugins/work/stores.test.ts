import { describe, it, expect } from 'vitest';
import { openDb } from '../../../src/store/db.js';
import { makePluginDb } from '../../../src/store/pluginDb.js';
import { WORK_MIGRATIONS } from '../../../plugins/work/src/store/migrations.js';
import { TaskStore } from '../../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../../plugins/work/src/store/readiness.js';
import { TaskUsageStore } from '../../../plugins/work/src/store/taskUsageStore.js';
import type { WorkDb } from '../../../plugins/work/src/store/db.js';

/** A database as the work plugin sees it: the shared main database through ctx.db(). Core's schema no
 *  longer carries the task tables, so a handle is BARE until the plugin migrates it — pass `migrated`
 *  for the shape a loaded plugin works on. */
function pluginDb(migrated = false) {
  const pdb = makePluginDb(openDb(':memory:'), 'work', { canMigrate: true });
  if (migrated) pdb.migrate(WORK_MIGRATIONS);
  return pdb;
}

/** The same adaptation the plugin entry makes (plugin handle → the stores' better-sqlite3 idiom). */
const storeDb = (pdb: ReturnType<typeof pluginDb>): WorkDb =>
  ({ prepare: (sql) => pdb.prepare(sql), transaction: <T>(fn: () => T) => () => pdb.transaction(fn) });

describe('work plugin store layer (task domain extraction)', () => {
  // Ownership is only real if the plugin PRODUCES its tables — which it now must, core having stopped
  // shipping the DDL. (That the produced shape matches core's to the column is tests/store/taskSchemaParity.)
  it('migration v1 is self-sufficient: it creates the grandfathered tables core no longer ships', () => {
    const pdb = pluginDb();
    pdb.migrate(WORK_MIGRATIONS);
    expect(pdb.appliedVersion()).toBe(2);
    const names = pdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','task_deps','task_usage') ORDER BY name").all() as { name: string }[];
    expect(names.map((r) => r.name)).toEqual(['task_deps', 'task_usage', 'tasks']);
    const indexes = pdb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_task%' ORDER BY name").all() as { name: string }[];
    expect(indexes.map((r) => r.name)).toEqual(['idx_task_usage_project', 'idx_tasks_parent', 'idx_tasks_project_status']);
  });

  // The columns that never existed in core's CREATE (only as additive migrations). A fresh install must
  // get the FULL shape from v1 — otherwise the first task snapshot writes into a column that isn't there.
  it('the created table carries every column the domain writes, not just schema.sql\'s', () => {
    const pdb = pluginDb();
    pdb.migrate(WORK_MIGRATIONS);
    const cols = (pdb.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['description', 'scheduled_at', 'autostart', 'result_summary', 'outcome', 'closed_at', 'created_by', 'changed_files', 'base_sha', 'head_sha', 'resume_note']) {
      expect(cols).toContain(c);
    }
    const usage = (pdb.prepare('PRAGMA table_info(task_usage)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['reasoning', 'cost_source', 'currency', 'raw_usage_metadata']) expect(usage).toContain(c);
    // …and the store really writes them, on the tables the migration made.
    const store = new TaskStore(storeDb(pdb));
    const t = store.create({ id: 'w-1', project_id: 1, title: 'Task', description: 'body' });
    store.saveChangedFiles(t.id, [{ path: 'a.ts', added: 2, deleted: 1 }], 'abc123', 'def456');
    store.setResumeNote(t.id, 'pick it back up');
    const back = store.get('w-1')!;
    expect(back.changed_files).toEqual([{ path: 'a.ts', added: 2, deleted: 1 }]);
    expect(back.resume_note).toBe('pick it back up');
  });

  // The upgrade path of a real production database: the tables are already there, full of live rows.
  // Adoption must not move, rename or copy a single one. (The other half of that promise — that the
  // tables an OLDER core created are adopted unchanged, shape included — is tests/store/taskSchemaParity.)
  it('adopting an existing install is a no-op: not one row moves, is duplicated or is lost', () => {
    const pdb = pluginDb(true);
    const store = new TaskStore(storeDb(pdb));
    const epic = store.create({ id: 'w-ep', project_id: 1, title: 'Epic', type: 'epic' });
    const phase = store.create({ id: 'w-ph', project_id: 1, title: 'Phase', parent_id: epic.id });
    store.addDep(phase.id, epic.id);
    new TaskUsageStore(storeDb(pdb)).record(phase.id, 1, 'claude', { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, costUsd: null, currency: null, costSource: 'unavailable' });
    const counts = () => ['tasks', 'task_deps', 'task_usage'].map((t) => (pdb.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c);
    const before = counts();

    pdb.migrate(WORK_MIGRATIONS);
    expect(pdb.appliedVersion()).toBe(2);

    expect(counts()).toEqual(before);
    expect(store.get('w-ep')?.title).toBe('Epic');
    expect(store.depsFor('w-ph')).toEqual(['w-ep']);
    // Re-running (a restart, a disable→re-enable) applies nothing a second time.
    pdb.migrate(WORK_MIGRATIONS);
    expect(pdb.appliedVersion()).toBe(2);
    expect(counts()).toEqual(before);
  });

  // The stores run on the plugin's own database handle in production — a transaction there must really
  // be a transaction, or a half-written plan survives the failure that should have rolled it back.
  it('runs the domain over the plugin database handle, transactions included', () => {
    const pdb = pluginDb(true);
    const store = new TaskStore(storeDb(pdb));
    store.create({ id: 'w-a', project_id: 1, title: 'A' });
    expect(() => store.transaction(() => {
      store.create({ id: 'w-b', project_id: 1, title: 'B' });
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.get('w-b')).toBeNull();
    expect(store.list()).toHaveLength(1);
    const readiness = new Readiness(storeDb(pdb));
    expect(readiness.ready(1).map((t) => t.id)).toEqual(['w-a']);
  });
});
