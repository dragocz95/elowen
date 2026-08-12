import type { PluginDbMigrationStep } from '../../../../src/plugins/api.js';

/** The agents plugin's schema, applied through ctx.db().migrate() (bookkept in plugin_migrations).
 *
 *  Table names are GRANDFATHERED from the core era on purpose — agents/missions/mission_pr/notes, not
 *  p_agents_* — because existing installs already hold data under these names and the extraction must
 *  never move or rename a row (plan: upgrade path is the top risk, rollback stays lossless). The DDL
 *  is byte-matched to what src/store/schema.sql creates today; core still ships those blocks (their
 *  removal is a planned cleanup), so the IF NOT EXISTS forms make both owners no-op against each
 *  other. Once core's blocks go, this is the single owner — a fresh install with the plugin enabled
 *  gets the tables from HERE. */
export const AGENTS_MIGRATIONS: PluginDbMigrationStep[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
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
`);
    },
  },
];
