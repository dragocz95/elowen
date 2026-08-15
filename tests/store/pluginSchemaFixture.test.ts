import { describe, it, expect } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { applyWorkMigrations, openWorkDb } from '../helpers/workDb.js';
import { AGENTS_TABLES, WORK_TABLES } from '../fixtures/pluginSchema.js';

/** The pin that keeps tests/fixtures/pluginSchema.ts honest.
 *
 *  The task tables moved OUT of core's schema.sql into the work plugin's migration v1, and the daemon's
 *  own suite can no longer import that plugin — so dozens of suites (project deletion cascades, user
 *  teardown, event timelines, tenancy) run against a FROZEN COPY of its DDL instead. A copy nothing
 *  checks is worse than no copy: every one of those suites would keep passing against a fiction.
 *
 *  The baseline below was CAPTURED from the daemon as it was immediately before the removal (core
 *  schema.sql + db.ts additive migrations, commit 027843b8). It is frozen on purpose: an edit to the
 *  fixture that changes a column, a type, a default, a primary key, a CHECK or an index makes this file
 *  fail, which is exactly the point — these tables hold live data and their shape is not a test
 *  fixture's to drift. That the PLUGIN still produces this same shape, in every install state a
 *  database can be in, is pinned on the other side: tests/work-schemaParity.test.ts in the plugin
 *  registry, against a copy of this same baseline.
 *
 *  `sql` is the statement SQLite itself stored (comments stripped, whitespace collapsed), so it carries
 *  what no pragma reports: the composite PRIMARY KEY and task_deps' CHECK constraint.
 *
 *  The table names come from the fixture's own ownership lists rather than being spelled again here: a
 *  table added to the DDL and named there is pinned by this file automatically, where a second hand-
 *  written copy would simply not mention it and the new table would go unpinned. */
const TASK_TABLES = WORK_TABLES;

interface TableShape { sql: string | null; cols: string[]; idx: string[] }

function normalizeDdl(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
}

/** The full observable shape of the task tables: stored DDL, every column (name/type/notnull/default/pk
 *  position, IN ORDER — column order is part of the on-disk format), and every index with its columns. */
function taskSchemaShape(db: Db): Record<string, TableShape> {
  const out: Record<string, TableShape> = {};
  for (const t of TASK_TABLES) {
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(t) as { sql: string } | undefined)?.sql;
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[])
      .map((c) => `${c.name}|${c.type}|${c.notnull}|${c.dflt_value ?? 'NULL'}|${c.pk}`);
    const idx = (db.prepare(`PRAGMA index_list(${t})`).all() as { name: string; unique: number; origin: string }[])
      .map((i) => `${i.name}|${i.unique}|${i.origin}|${(db.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map((c) => c.name).join(',')}`)
      .sort();
    out[t] = { sql: sql ? normalizeDdl(sql) : null, cols, idx };
  }
  return out;
}

/** What core's schema.sql + db.ts additive migrations produced on a FRESH install, i.e. the shape every
 *  up-to-date database (including the production one) is in today. */
const FRESH_INSTALL_SHAPE: Record<string, TableShape> = {
  tasks: {
    sql: "CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id INTEGER NOT NULL,title TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'task',status TEXT NOT NULL DEFAULT 'open',priority TEXT NOT NULL DEFAULT 'P2',parent_id TEXT,labels TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',scheduled_at TEXT,autostart INTEGER NOT NULL DEFAULT 0,result_summary TEXT,outcome TEXT,closed_at TEXT,created_by INTEGER,created_at TEXT NOT NULL DEFAULT(datetime('now')),changed_files TEXT,base_sha TEXT,head_sha TEXT,resume_note TEXT)",
    cols: [
      "id|TEXT|0|NULL|1", "project_id|INTEGER|1|NULL|0", "title|TEXT|1|NULL|0", "type|TEXT|1|'task'|0",
      "status|TEXT|1|'open'|0", "priority|TEXT|1|'P2'|0", "parent_id|TEXT|0|NULL|0", "labels|TEXT|1|''|0",
      "description|TEXT|1|''|0", "scheduled_at|TEXT|0|NULL|0", "autostart|INTEGER|1|0|0",
      "result_summary|TEXT|0|NULL|0", "outcome|TEXT|0|NULL|0", "closed_at|TEXT|0|NULL|0",
      "created_by|INTEGER|0|NULL|0", "created_at|TEXT|1|datetime('now')|0", "changed_files|TEXT|0|NULL|0",
      "base_sha|TEXT|0|NULL|0", "head_sha|TEXT|0|NULL|0", "resume_note|TEXT|0|NULL|0",
    ],
    idx: ['idx_tasks_parent|0|c|parent_id', 'idx_tasks_project_status|0|c|project_id,status', 'sqlite_autoindex_tasks_1|1|pk|id'],
  },
  task_deps: {
    sql: 'CREATE TABLE task_deps(task_id TEXT NOT NULL,depends_on_id TEXT NOT NULL,PRIMARY KEY(task_id,depends_on_id),CHECK(task_id != depends_on_id))',
    cols: ['task_id|TEXT|1|NULL|1', 'depends_on_id|TEXT|1|NULL|2'],
    idx: ['sqlite_autoindex_task_deps_1|1|pk|task_id,depends_on_id'],
  },
  task_usage: {
    sql: "CREATE TABLE task_usage(task_id TEXT PRIMARY KEY,project_id INTEGER NOT NULL,exec TEXT NOT NULL,input INTEGER NOT NULL DEFAULT 0,output INTEGER NOT NULL DEFAULT 0,cache_read INTEGER NOT NULL DEFAULT 0,cache_write INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0,reasoning INTEGER NOT NULL DEFAULT 0,cost_usd REAL,currency TEXT,cost_source TEXT,raw_usage_metadata TEXT,captured_at TEXT NOT NULL DEFAULT(datetime('now')))",
    cols: [
      'task_id|TEXT|0|NULL|1', 'project_id|INTEGER|1|NULL|0', 'exec|TEXT|1|NULL|0', 'input|INTEGER|1|0|0',
      'output|INTEGER|1|0|0', 'cache_read|INTEGER|1|0|0', 'cache_write|INTEGER|1|0|0', 'total|INTEGER|1|0|0',
      'reasoning|INTEGER|1|0|0', 'cost_usd|REAL|0|NULL|0', 'currency|TEXT|0|NULL|0', 'cost_source|TEXT|0|NULL|0',
      'raw_usage_metadata|TEXT|0|NULL|0', "captured_at|TEXT|1|datetime('now')|0",
    ],
    idx: ['idx_task_usage_project|0|c|project_id', 'sqlite_autoindex_task_usage_1|1|pk|task_id'],
  },
};

describe('the frozen plugin-table fixture still equals the schema a real install has', () => {
  it('openWorkDb hands a test byte-for-byte the shape core used to create', () => {
    expect(taskSchemaShape(openWorkDb())).toEqual(FRESH_INSTALL_SHAPE);
  });

  it('applyWorkMigrations over an already-open database produces the same shape', () => {
    expect(taskSchemaShape(applyWorkMigrations(openDb(':memory:')))).toEqual(FRESH_INSTALL_SHAPE);
  });

  it('core itself ships none of them — the fixture is the only thing that creates them', () => {
    const db = openDb(':memory:');
    // Both plugins' tables, taken from the fixture's ownership lists so a table added there is checked
    // here without anybody remembering to, plus the indexes the DDL creates alongside them.
    const owned = [...AGENTS_TABLES, ...WORK_TABLES, 'idx_tasks_parent', 'idx_tasks_project_status', 'idx_task_usage_project'];
    const present = (db.prepare(
      `SELECT name FROM sqlite_master WHERE name IN (${owned.map(() => '?').join(',')})`,
    ).all(...owned) as { name: string }[]).map((r) => r.name);
    expect(present).toEqual([]);
    // …and core's own schema is complete without them.
    for (const t of ['projects', 'users', 'events', 'brain_sessions', 'plugin_migrations']) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t), t).toBeTruthy();
    }
  });
});
