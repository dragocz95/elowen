import type { PluginDbHandle, PluginDbMigrationStep } from '../../../../src/plugins/api.js';

/** Add a column only if it isn't already present (same shape as the daemon's db.ts addColumn): checks
 *  the actual table shape, so a genuine ALTER failure (lock, disk full) is not swallowed. */
const addColumn = (db: PluginDbHandle, table: string, column: string, decl: string): void => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
};

/** The work plugin's schema — the task domain's tables — applied through ctx.db().migrate() and
 *  bookkept in plugin_migrations.
 *
 *  v1 is an ADOPTION, not a creation: the table names are GRANDFATHERED from the core era (tasks,
 *  task_deps, task_usage — not p_work_*) and the DDL is byte-matched to what src/store/schema.sql
 *  creates, so on every existing install the IF NOT EXISTS forms find the tables already there and the
 *  step is a no-op that moves, renames and copies nothing. Not one row is touched by the extraction; a
 *  rollback to a daemon whose core still owns these tables is lossless in both directions. On a FRESH
 *  install the same DDL is what brings the tables into existence — which is what makes the ownership
 *  real rather than nominal, and is proven by dropping the tables and migrating them back.
 *
 *  v2 is the safety net for an ANCIENT database: the columns that only ever existed as core additive
 *  migrations (never in schema.sql's CREATE). Any install that booted a daemon carrying those steps
 *  already has them, so addColumn no-ops; v1's CREATE forms carry them too, so a fresh install never
 *  needs it either. It exists for the database that skips from a pre-column era straight to a daemon
 *  whose core no longer alters these tables. */
export const WORK_MIGRATIONS: PluginDbMigrationStep[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task', status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'P2', parent_id TEXT, labels TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', scheduled_at TEXT,
  autostart INTEGER NOT NULL DEFAULT 0,
  result_summary TEXT, outcome TEXT, closed_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  changed_files TEXT, base_sha TEXT, head_sha TEXT, resume_note TEXT
);
CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id != depends_on_id)
);
CREATE TABLE IF NOT EXISTS task_usage (
  task_id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  exec TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  currency TEXT,
  cost_source TEXT,
  raw_usage_metadata TEXT,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_usage_project ON task_usage(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
`);
    },
  },
  {
    version: 2,
    up: (db) => {
      addColumn(db, 'tasks', 'description', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'tasks', 'scheduled_at', 'TEXT');
      addColumn(db, 'tasks', 'autostart', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'tasks', 'result_summary', 'TEXT');
      addColumn(db, 'tasks', 'outcome', 'TEXT');
      addColumn(db, 'tasks', 'closed_at', 'TEXT');
      addColumn(db, 'tasks', 'changed_files', 'TEXT');
      addColumn(db, 'tasks', 'base_sha', 'TEXT');
      addColumn(db, 'tasks', 'head_sha', 'TEXT');
      addColumn(db, 'tasks', 'resume_note', 'TEXT');
      addColumn(db, 'tasks', 'created_by', 'INTEGER');
      addColumn(db, 'task_usage', 'reasoning', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'task_usage', 'cost_source', 'TEXT');
      addColumn(db, 'task_usage', 'currency', 'TEXT');
      addColumn(db, 'task_usage', 'raw_usage_metadata', 'TEXT');
    },
  },
];
