import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, type Db } from '../../src/store/db.js';
import { makePluginDb } from '../../src/store/pluginDb.js';
import { WORK_MIGRATIONS } from '../../plugins/work/src/store/migrations.js';
import { applyWorkMigrations, openWorkDb } from '../helpers/workDb.js';

/** The task tables moved OUT of core's schema.sql into the work plugin's migration v1. This file is the
 *  proof that the move changed no database, in any of the states one can be in.
 *
 *  Both baselines below were CAPTURED from the daemon as it was immediately before the removal (core
 *  schema.sql + db.ts additive migrations, commit 027843b8) and are asserted against what the plugin
 *  produces now. They are frozen on purpose: an edit to the plugin's DDL that changes a column, a type,
 *  a default, a primary key, a CHECK or an index makes this file fail, which is exactly the point —
 *  these tables hold live data and their shape is not the plugin's to drift.
 *
 *  `sql` is the statement SQLite itself stored (comments stripped, whitespace collapsed), so it carries
 *  what no pragma reports: the composite PRIMARY KEY and task_deps' CHECK constraint. */
const TASK_TABLES = ['tasks', 'task_deps', 'task_usage'] as const;

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

/** What core produced when it upgraded an ANCIENT database — one whose tables predate every additive
 *  column — through its addColumn block. The plugin's v2 must reproduce it column for column, in the
 *  same ORDER: an ALTER appends, so a different order would leave such a database in a shape no other
 *  install has. */
const ANCIENT_UPGRADED_SHAPE: Record<string, TableShape> = {
  tasks: {
    sql: "CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id INTEGER NOT NULL,title TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'task',status TEXT NOT NULL DEFAULT 'open',priority TEXT NOT NULL DEFAULT 'P2',parent_id TEXT,labels TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now')),description TEXT NOT NULL DEFAULT '',scheduled_at TEXT,autostart INTEGER NOT NULL DEFAULT 0,result_summary TEXT,outcome TEXT,closed_at TEXT,changed_files TEXT,base_sha TEXT,head_sha TEXT,resume_note TEXT,created_by INTEGER)",
    cols: [
      "id|TEXT|0|NULL|1", "project_id|INTEGER|1|NULL|0", "title|TEXT|1|NULL|0", "type|TEXT|1|'task'|0",
      "status|TEXT|1|'open'|0", "priority|TEXT|1|'P2'|0", "parent_id|TEXT|0|NULL|0", "labels|TEXT|1|''|0",
      "created_at|TEXT|1|datetime('now')|0", "description|TEXT|1|''|0", "scheduled_at|TEXT|0|NULL|0",
      "autostart|INTEGER|1|0|0", "result_summary|TEXT|0|NULL|0", "outcome|TEXT|0|NULL|0",
      "closed_at|TEXT|0|NULL|0", "changed_files|TEXT|0|NULL|0", "base_sha|TEXT|0|NULL|0",
      "head_sha|TEXT|0|NULL|0", "resume_note|TEXT|0|NULL|0", "created_by|INTEGER|0|NULL|0",
    ],
    idx: ['idx_tasks_parent|0|c|parent_id', 'idx_tasks_project_status|0|c|project_id,status', 'sqlite_autoindex_tasks_1|1|pk|id'],
  },
  task_deps: {
    sql: 'CREATE TABLE task_deps(task_id TEXT NOT NULL,depends_on_id TEXT NOT NULL,PRIMARY KEY(task_id,depends_on_id),CHECK(task_id != depends_on_id))',
    cols: ['task_id|TEXT|1|NULL|1', 'depends_on_id|TEXT|1|NULL|2'],
    idx: ['sqlite_autoindex_task_deps_1|1|pk|task_id,depends_on_id'],
  },
  task_usage: {
    sql: "CREATE TABLE task_usage(task_id TEXT PRIMARY KEY,project_id INTEGER NOT NULL,exec TEXT NOT NULL,input INTEGER NOT NULL DEFAULT 0,output INTEGER NOT NULL DEFAULT 0,cache_read INTEGER NOT NULL DEFAULT 0,cache_write INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0,cost_usd REAL,captured_at TEXT NOT NULL DEFAULT(datetime('now')),reasoning INTEGER NOT NULL DEFAULT 0,cost_source TEXT,currency TEXT,raw_usage_metadata TEXT)",
    cols: [
      'task_id|TEXT|0|NULL|1', 'project_id|INTEGER|1|NULL|0', 'exec|TEXT|1|NULL|0', 'input|INTEGER|1|0|0',
      'output|INTEGER|1|0|0', 'cache_read|INTEGER|1|0|0', 'cache_write|INTEGER|1|0|0', 'total|INTEGER|1|0|0',
      'cost_usd|REAL|0|NULL|0', "captured_at|TEXT|1|datetime('now')|0", 'reasoning|INTEGER|1|0|0',
      'cost_source|TEXT|0|NULL|0', 'currency|TEXT|0|NULL|0', 'raw_usage_metadata|TEXT|0|NULL|0',
    ],
    idx: ['idx_task_usage_project|0|c|project_id', 'sqlite_autoindex_task_usage_1|1|pk|task_id'],
  },
};

/** Core's CREATE statements as they stood BEFORE any additive column existed — the starting point of the
 *  ancient-upgrade cell. */
const PRE_COLUMN_ERA_DDL = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'task', status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'P2', parent_id TEXT, labels TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE task_deps (
    task_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_id),
    CHECK (task_id != depends_on_id)
  );
  CREATE TABLE task_usage (
    task_id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL,
    exec TEXT NOT NULL,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/** Seed one row in each task table, with a value in every column the domain writes. */
function seedTaskRows(db: Db): void {
  db.prepare(`INSERT INTO tasks (id, project_id, title, type, status, priority, parent_id, labels, description,
      scheduled_at, autostart, result_summary, outcome, closed_at, created_by, created_at, changed_files, base_sha, head_sha, resume_note)
    VALUES ('t-1', 1, 'Live task', 'task', 'in_progress', 'P1', 'e-1', 'claude', 'body', '2026-08-13T09:00:00Z', 1,
      'done well', 'success', '2026-08-13T10:00:00Z', 7, '2026-08-01 08:00:00', '[{"path":"a.ts","added":2,"deleted":1}]', 'abc123', 'def456', 'carry on')`).run();
  db.prepare("INSERT INTO tasks (id, project_id, title, type) VALUES ('e-1', 1, 'Live epic', 'epic')").run();
  db.prepare("INSERT INTO task_deps (task_id, depends_on_id) VALUES ('t-1', 'e-1')").run();
  db.prepare(`INSERT INTO task_usage (task_id, project_id, exec, input, output, cache_read, cache_write, total,
      reasoning, cost_usd, currency, cost_source, raw_usage_metadata, captured_at)
    VALUES ('t-1', 1, 'claude', 10, 20, 3, 4, 30, 5, 0.42, 'USD', 'provider_reported', '{"in":10}', '2026-08-02 09:00:00')`).run();
}

/** Every row of every task table, ordered — the payload half of "an existing database is untouched". */
function taskRows(db: Db): Record<string, unknown[]> {
  return {
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
    task_deps: db.prepare('SELECT * FROM task_deps ORDER BY task_id, depends_on_id').all(),
    task_usage: db.prepare('SELECT * FROM task_usage ORDER BY task_id').all(),
  };
}

/** Open a database file the way a daemon boot does, with the work plugin loaded after it. */
function bootWithWorkPlugin(path: string): Db {
  const db = openDb(path);
  makePluginDb(db, 'work', { canMigrate: true }).migrate(WORK_MIGRATIONS);
  return db;
}

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'work-schema-')), 'elowen.db');
}

describe('task schema ownership: the plugin reproduces core\'s schema exactly', () => {
  it('fresh install, work ENABLED: byte-for-byte the schema core used to create', () => {
    expect(taskSchemaShape(bootWithWorkPlugin(tmpDbPath()))).toEqual(FRESH_INSTALL_SHAPE);
  });

  it('fresh install, work DISABLED: no task tables at all, and the daemon still boots', () => {
    const db = openDb(tmpDbPath());
    const present = (db.prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('tasks','task_deps','task_usage','idx_tasks_parent','idx_tasks_project_status','idx_task_usage_project')",
    ).all() as { name: string }[]).map((r) => r.name);
    expect(present).toEqual([]);
    // Core's own schema is complete without them — the tables it DOES own are all there.
    for (const t of ['projects', 'users', 'events', 'brain_sessions', 'plugin_migrations']) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t)).toBeTruthy();
    }
    // A second boot of the same file is just as clean (no half-created shape to trip over).
    expect(() => openDb(':memory:')).not.toThrow();
  });

  it('enable AFTER running disabled: the same schema, and the bookkeeping records both steps', () => {
    const path = tmpDbPath();
    openDb(path).close();   // booted once with the plugin off…
    openDb(path).close();   // …and again, still off
    const db = bootWithWorkPlugin(path);
    expect(taskSchemaShape(db)).toEqual(FRESH_INSTALL_SHAPE);
    expect(db.prepare("SELECT version FROM plugin_migrations WHERE plugin='work' ORDER BY version").all())
      .toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('disable → re-enable keeps the rows and applies nothing twice', () => {
    const path = tmpDbPath();
    const first = bootWithWorkPlugin(path);
    first.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    seedTaskRows(first);
    const rows = taskRows(first);
    first.close();
    openDb(path).close();                       // a boot with the plugin disabled: nothing runs
    const back = bootWithWorkPlugin(path);      // …and back on
    expect(taskSchemaShape(back)).toEqual(FRESH_INSTALL_SHAPE);
    expect(taskRows(back)).toEqual(rows);
    expect(back.prepare("SELECT COUNT(*) c FROM plugin_migrations WHERE plugin='work'").get()).toEqual({ c: 2 });
  });

  it('an existing (production-shaped) database is untouched: same schema, same rows', () => {
    const path = tmpDbPath();
    // Arrange the database in the shape today's daemon leaves it in, with live rows in every table.
    const before = bootWithWorkPlugin(path);
    before.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    seedTaskRows(before);
    const shapeBefore = taskSchemaShape(before);
    const rowsBefore = taskRows(before);
    before.close();
    // Upgrade: core no longer ships the DDL, the plugin adopts what is there.
    const after = bootWithWorkPlugin(path);
    expect(taskSchemaShape(after)).toEqual(shapeBefore);
    expect(shapeBefore).toEqual(FRESH_INSTALL_SHAPE);
    expect(taskRows(after)).toEqual(rowsBefore);
  });

  it('an existing database boots with work DISABLED without touching its task tables', () => {
    const path = tmpDbPath();
    const before = bootWithWorkPlugin(path);
    before.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'p','/o')").run();
    seedTaskRows(before);
    const rowsBefore = taskRows(before);
    before.close();
    const after = openDb(path); // plugin off: core must neither create, alter nor read them
    expect(taskSchemaShape(after)).toEqual(FRESH_INSTALL_SHAPE);
    expect(taskRows(after)).toEqual(rowsBefore);
  });

  it('an ancient database gains exactly the columns core used to add, in the same order', () => {
    const path = tmpDbPath();
    const raw = new Database(path);
    raw.exec(PRE_COLUMN_ERA_DDL);
    raw.prepare("INSERT INTO tasks (id, project_id, title) VALUES ('old-1', 1, 'Ancient')").run();
    raw.close();
    const db = bootWithWorkPlugin(path);
    expect(taskSchemaShape(db)).toEqual(ANCIENT_UPGRADED_SHAPE);
    expect(db.prepare("SELECT title, description, resume_note, created_by FROM tasks WHERE id='old-1'").get())
      .toEqual({ title: 'Ancient', description: '', resume_note: null, created_by: null });
  });

  it('the test helpers hand tests the same schema the daemon has', () => {
    expect(taskSchemaShape(openWorkDb())).toEqual(FRESH_INSTALL_SHAPE);
    expect(taskSchemaShape(applyWorkMigrations(openDb(':memory:')))).toEqual(FRESH_INSTALL_SHAPE);
  });
});
