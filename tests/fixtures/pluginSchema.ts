import type { Db } from '../../src/store/db.js';

/** The DDL the `agents` and `work` plugins apply through ctx.db().migrate(), FROZEN here as a fixture.
 *
 *  Both plugins live in the plugin registry (github.com/dragocz95/elowen-plugins) and are installed from
 *  there, so the daemon's own tests cannot import their migrations any more. They still need a database
 *  shaped like a real installation: dozens of suites assert daemon behaviour — project deletion cascades,
 *  user teardown, event timelines, tenancy — over tables these plugins own. Re-deriving which plugin owns
 *  what, in every one of those suites, is how a test ends up asserting against a shape nobody ships.
 *
 *  WHAT THIS IS NOT. It is not the source of truth. The plugins are, and this is a copy that can drift
 *  from them. The drift is caught on the OTHER side: the registry pins its own copy against the shape the
 *  published daemon expects, the same arrangement `tests/contract/pluginCoreCopyParity.test.ts` describes
 *  for the small helpers a plugin copies out of core. A fixture whose divergence nothing notices would be
 *  worse than no fixture, because every suite above it would keep passing against a fiction.
 *
 *  Table names are GRANDFATHERED from the era when core owned these tables (tasks, missions, notes — not
 *  p_work_* / p_agents_*), which is why nothing here is namespaced. The CREATE forms carry the columns
 *  core had ARRIVED at: schema.sql's original CREATE plus every additive ALTER applied on top of it.
 *
 *  The plugins' own v2 migrations — additive columns for a database upgrading from a pre-column era — are
 *  deliberately NOT reproduced. They no-op against these CREATE forms, which already carry those columns,
 *  so a test opening a fresh database would not observe them. A suite that specifically exercises the
 *  ancient-upgrade path builds its own older shape and must not use this fixture. */

const AGENTS_DDL = `
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL,
  program TEXT NOT NULL, model TEXT NOT NULL, last_active_ts TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, autonomy TEXT NOT NULL,
  max_sessions INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  pilot_exec TEXT NOT NULL DEFAULT '', overseer_exec TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS mission_pr (
  mission_id TEXT PRIMARY KEY, branch TEXT NOT NULL, worktree TEXT NOT NULL,
  pr_number INTEGER, pr_url TEXT, pr_state TEXT, last_review_ts TEXT,
  fix_rounds INTEGER NOT NULL DEFAULT 0, last_feedback TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  target TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_scope_target ON notes(scope, target, id);
CREATE INDEX IF NOT EXISTS idx_missions_epic ON missions(epic_id);
CREATE INDEX IF NOT EXISTS idx_missions_state ON missions(state);
`;

const WORK_DDL = `
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
`;

/** The tables each plugin owns, in the order the DDL above creates them. Exported so a suite can assert
 *  on ownership — and so a table added to the DDL without being named here is visible. */
export const AGENTS_TABLES = ['agents', 'missions', 'mission_pr', 'notes'] as const;
export const WORK_TABLES = ['tasks', 'task_deps', 'task_usage'] as const;

export function applyAgentsSchema(db: Db): void {
  db.exec(AGENTS_DDL);
}

export function applyWorkSchema(db: Db): void {
  db.exec(WORK_DDL);
}
