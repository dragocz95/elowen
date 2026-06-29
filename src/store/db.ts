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
  // Per-task frozen change list captured at close: the files THIS task committed (JSON CommitFileChange[]),
  // plus the base/head SHAs the diff was taken between so a single file's diff can be regenerated lazily.
  // Never the live working tree (shared per project) — see TaskSnapshot. Old DBs default empty/NULL.
  addColumn(db, 'tasks', 'changed_files', 'TEXT');
  addColumn(db, 'tasks', 'base_sha', 'TEXT');
  addColumn(db, 'tasks', 'head_sha', 'TEXT');
  // Transient input for a task's NEXT run — a review-reject rationale, or a stuck/manual relaunch
  // reason — kept as a first-class field instead of being concatenated into the description, so it's
  // set and read without parsing. Surfaces in the re-spawned agent's prompt. Old DBs default NULL.
  addColumn(db, 'tasks', 'resume_note', 'TEXT');
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
  // The aggregated PR-review feedback the planner is currently fixing — surfaced in the UI so a fix
  // round is explained ("these phases address PR review X"). Cleared on merge/close. Old DBs default null.
  addColumn(db, 'mission_pr', 'last_feedback', 'TEXT');
  // Per-project override of the GitHub PR-native workflow. NULL = inherit the global autopilot default;
  // 1/0 = force on/off for this project (each project can run a different flow). Old DBs default NULL.
  addColumn(db, 'projects', 'pr_enabled', 'INTEGER');
  // Who started the mission — drives per-mission push-notification routing (owner + admins). Nullable:
  // legacy/system missions have no owner and fall back to notifying admins only. Old DBs default NULL.
  addColumn(db, 'missions', 'created_by', 'INTEGER');
  // Who created the task — used to attribute a spawned agent to a user so its prompts resolve to that
  // user's overrides (else admin fallback). Nullable: legacy/system tasks have no owner. Old DBs NULL.
  addColumn(db, 'tasks', 'created_by', 'INTEGER');
  // Seed the bootstrap admin on existing DBs: the lowest-id user, if none is flagged yet.
  db.exec("UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)");
  return db;
}
