import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = Database.Database;

/** Add a column only if it isn't already present. Unlike a try/catch around ALTER TABLE, this
 *  checks the actual table shape, so a genuine ALTER failure (lock, disk full) is not swallowed. */
function addColumn(db: Db, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // Enforce foreign keys so any REFERENCES added to the schema actually cascade/reject.
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf-8'));
  // Additive migrations for DBs created before a column existed. Idempotent: a column that already
  // exists is skipped via PRAGMA table_info, so we never rely on swallowing arbitrary ALTER errors
  // (a real failure — disk full, lock — now surfaces instead of being silently caught).
  addColumn(db, 'projects', 'notes', "TEXT NOT NULL DEFAULT ''");
  // Project icon: a project-relative path to an image file already in the repo (e.g. assets/logo.png).
  // Empty = the default folder glyph. Never an uploaded copy — it references a file in the project.
  addColumn(db, 'projects', 'icon', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'tasks', 'description', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'tasks', 'scheduled_at', 'TEXT');
  addColumn(db, 'tasks', 'autostart', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'tasks', 'result_summary', 'TEXT');
  addColumn(db, 'tasks', 'outcome', 'TEXT');
  addColumn(db, 'tasks', 'closed_at', 'TEXT');
  addColumn(db, 'users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'allowed_execs', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'name', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'email', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'avatar', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'default_exec', "TEXT NOT NULL DEFAULT ''");
  // Per-user advisor: the remembered agent exec (empty = not set up yet) and whether it auto-starts
  // on login. Additive so existing DBs gain them with sensible defaults (autostart on once chosen).
  addColumn(db, 'users', 'advisor_exec', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'advisor_autostart', 'INTEGER NOT NULL DEFAULT 1');
  // Token scope: spawned agents get a 'agent'-scoped token (worker/overseer/pilot verbs only),
  // never the admin's full token. Pre-existing rows default to 'full' (interactive user sessions).
  addColumn(db, 'auth_tokens', 'scope', "TEXT NOT NULL DEFAULT 'full'");
  // Timeline drill-down: events carry the project they belong to (derived from the task at write
  // time) so the UI can scope/link an event to its repo. Nullable — mission/signal events have none.
  // The index is created here (not in schema.sql) so it runs *after* the column exists on migrated DBs.
  addColumn(db, 'events', 'project_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id)');
  // Timeline labels: snapshot the task/epic title at write time so an event still reads as a name
  // after its task is deleted (events outlive tasks). Empty for signal/plan and unknown tasks.
  addColumn(db, 'events', 'label', "TEXT NOT NULL DEFAULT ''");
  // PR feedback loop budget: how many auto fix rounds a mission's PR has already consumed. Bounds the
  // Codex↔Orca review ping-pong before escalating to a human. Additive — old DBs default to 0.
  addColumn(db, 'mission_pr', 'fix_rounds', 'INTEGER NOT NULL DEFAULT 0');
  // Seed the bootstrap admin on existing DBs: the lowest-id user, if none is flagged yet.
  db.exec("UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)");
  return db;
}
