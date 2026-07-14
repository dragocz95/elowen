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
  // Per-user tool deny-list (CSV of plugin tool names disabled for this user's own brain sessions).
  addColumn(db, 'users', 'disabled_tools', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'name', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'email', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'avatar', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'default_exec', "TEXT NOT NULL DEFAULT ''");
  // Per-user advisor: the remembered agent exec (empty = not set up yet) and whether it auto-starts
  // on login. Additive so existing DBs gain them with sensible defaults (autostart on once chosen).
  addColumn(db, 'users', 'advisor_exec', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'advisor_autostart', 'INTEGER NOT NULL DEFAULT 1');
  // Which advisor engine the user runs: 'spawn' = the legacy external-CLI advisor, 'brain' = the
  // in-process embedded PI brain. Defaults to 'spawn' so existing users are unchanged (coexistence).
  addColumn(db, 'users', 'advisor_engine', "TEXT NOT NULL DEFAULT 'spawn'");
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
  // Codex↔Elowen review ping-pong before escalating to a human. Additive — old DBs default to 0.
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
  // Per-mission Autopilot identities. Empty inherits the current global Settings value, preserving
  // every legacy mission while allowing a newly planned mission to keep its explicit choices.
  addColumn(db, 'missions', 'pilot_exec', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'missions', 'overseer_exec', "TEXT NOT NULL DEFAULT ''");
  // Who created the task — used to attribute a spawned agent to a user so its prompts resolve to that
  // user's overrides (else admin fallback). Nullable: legacy/system tasks have no owner. Old DBs NULL.
  addColumn(db, 'tasks', 'created_by', 'INTEGER');
  // Memory categories: a memory's assigned category (nullable, id-addressed — a rename never re-tags).
  // Index created here (not schema.sql) so it runs after the column exists on migrated DBs.
  addColumn(db, 'memories', 'category_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_user_category ON memories(user_id, category_id)');
  // Memory category icon: a lucide name from the server ICON_ALLOWLIST. Empty on migrated rows → the UI
  // falls back to 'Folder'. The store clamps unknown names to 'Folder' on every create/update.
  addColumn(db, 'memory_categories', 'icon', "TEXT NOT NULL DEFAULT ''");
  // Which model performed a memory mutation (curator/categorizer). Nullable — human/API events have none.
  addColumn(db, 'memory_events', 'model', 'TEXT');
  // Brain conversation ↔ working directory binding (per-client CLI sessions). Empty on migrated rows =
  // a cwd-less legacy/web session; stamped from the validated client-reported cwd on start/send.
  addColumn(db, 'brain_sessions', 'work_dir', "TEXT NOT NULL DEFAULT ''");
  // Durable delegation tree. NULL keeps every existing conversation top-level. Create the index only
  // AFTER adding the column: schema.sql runs before additive migrations, so putting this index there
  // would make an old brain_sessions table fail with "no such column: parent_session_id" on startup.
  addColumn(db, 'brain_sessions', 'parent_session_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_brain_sessions_parent ON brain_sessions(parent_session_id)');
  // Immutable, JSON-serialized delegated execution scope. Legacy child rows intentionally remain NULL:
  // a continuation must reject them rather than guessing an owner-wide replacement scope.
  addColumn(db, 'brain_sessions', 'delegated_access', 'TEXT');
  // Mid-turn (provisional) message rows — see brain_messages in schema.sql. Every existing row was written
  // by a settled agent_end, so the 0 default correctly reads the whole back catalogue as durable history.
  addColumn(db, 'brain_messages', 'pending', 'INTEGER NOT NULL DEFAULT 0');
  // Extended usage/cost accounting (see task_usage in schema.sql). All nullable/zero-default so existing
  // rows read as legacy (reasoning 0, no currency, cost_source NULL treated as unknown).
  addColumn(db, 'task_usage', 'reasoning', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'task_usage', 'cost_source', 'TEXT');
  addColumn(db, 'task_usage', 'currency', 'TEXT');
  addColumn(db, 'task_usage', 'raw_usage_metadata', 'TEXT');
  // A linked Discord snowflake is an identity key — enforce one-owner-per-id with a partial UNIQUE index
  // so a squatter can't claim another user's id (see schema.sql). Created here too for pre-existing DBs.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_discord_id ON user_settings(value) WHERE key = 'discordUserId'");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_whatsapp_number ON user_settings(value) WHERE key = 'whatsappNumber'");
  // Seed the bootstrap admin on existing DBs: the lowest-id user, if none is flagged yet.
  db.exec("UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)");
  // Rename prompt template keys to match the elowen/elowen-platform rename (advisor → elowen, advisor-channel → elowen-platform).
  db.exec("UPDATE user_prompts SET name = 'elowen' WHERE name = 'advisor'");
  db.exec("UPDATE user_prompts SET name = 'elowen-platform' WHERE name = 'advisor-channel'");
  return db;
}
