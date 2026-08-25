import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './dbTypes.js';
import { renameDocsTool, renameRegistryTool, renameTool, repairImageTool } from './toolRenames.js';
import { execRefSpec, parseExecRef, PROGRAM_PREFIXES } from '../shared/execs.js';
import { PLATFORM_IDENTITIES } from '../shared/platformIdentity.js';
import { installBrainUsageRollup } from './brainUsageRollup.js';

export type { Db } from './dbTypes.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Add a column only if it isn't already present. Unlike a try/catch around ALTER TABLE, this
 *  checks the actual table shape, so a genuine ALTER failure (lock, disk full) is not swallowed. */
function addColumn(db: Db, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** Add the normalized profile-email uniqueness guard when legacy data permits it. Some live databases
 *  predate the guard and may already contain duplicates; refusing to boot would be worse than keeping the
 *  old data. In that degraded shape writes still preflight conflicts and Teams matching requires exactly
 *  one row, so identity resolution remains fail-closed without deleting or rewriting anyone's profile. */
function ensureUniqueUserEmailIndex(db: Db): void {
  const duplicate = db.prepare(`SELECT lower(trim(email)) AS email
    FROM users WHERE trim(email) <> '' GROUP BY lower(trim(email)) HAVING COUNT(*) > 1 LIMIT 1`).get();
  if (duplicate) {
    console.warn('database migration: normalized user e-mail index not created because duplicate profile e-mails exist; Teams e-mail matching stays fail-closed');
    return;
  }
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized ON users(lower(trim(email))) WHERE trim(email) <> ''");
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      console.warn('database migration: normalized user e-mail index not created because duplicate profile e-mails appeared; Teams e-mail matching stays fail-closed');
      return;
    }
    throw error;
  }
}

/** Run a statement that touches a PLUGIN-OWNED table from core cleanup code, tolerating the table's
 *  absence. A fresh install with the owning plugin disabled never creates it (its DDL lives in that
 *  plugin's migrations), yet core's destructive paths — epic/project/user delete, admin cleanup — must
 *  still run there AND must still purge the plugin's rows when the tables DO exist (cleanup routed
 *  through the plugin control would silently skip while it is off, stranding orphans that resurface on
 *  re-enable). Only "no such table/column" is treated as the not-installed shape; any other failure
 *  propagates. Today's callers cover the agents tables (missions/mission_pr/agents/notes); the task
 *  tables join them as their domain moves out of core. */
export function tolerateMissingPluginTables<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (e) {
    if (e instanceof Error && /no such (table|column)/i.test(e.message)) return fallback;
    throw e;
  }
}

export interface OpenDbOptions {
  /** Create the schema and run migrations (default true). A process that is NOT the migrator — a pooled
   *  sub-agent runner, forked only after the daemon's own openDb returned — passes false: it then opens a
   *  database whose shape is already final, so it neither races the migrator nor needs the write lock. */
  migrate?: boolean;
}

export function openDb(path: string, opts: OpenDbOptions = {}): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // BEFORE journal_mode: switching a database into WAL takes an exclusive lock, so when two processes
  // open a fresh file at the same moment the loser throws SQLITE_BUSY instantly unless the timeout is
  // already armed. Setting it first is what makes that race wait a few milliseconds instead of failing.
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  // better-sqlite3 is synchronous, so every commit's fsync happens ON the event loop — and at SQLite's
  // default FULL that is a disk round-trip per stored message, with every other session and the whole
  // HTTP API waiting behind it. NORMAL is the setting WAL is designed around: a process crash still
  // cannot corrupt or lose committed data, only a power cut or kernel panic can drop the most recent
  // commits, which for a conversation transcript is the right trade for keeping the loop free.
  db.pragma('synchronous = NORMAL');
  // Enforce foreign keys so any REFERENCES added to the schema actually cascade/reject.
  // Must stay OUTSIDE the migration transaction below — SQLite ignores this pragma inside one.
  db.pragma('foreign_keys = ON');
  if (opts.migrate === false) return db;
  migrate(db);
  return db;
}

/** Bring the schema up to date. Split out of {@link openDb} so a non-migrating process can skip it.
 *
 *  The additive block runs as ONE `BEGIN IMMEDIATE` transaction because `addColumn` reads the table shape
 *  and then ALTERs it: outside a transaction two processes opening a fresh database both see the column
 *  missing and the loser dies on "duplicate column name". IMMEDIATE takes the write lock up front, so the
 *  check and the ALTER are atomic and the loser simply waits and then finds the column already there.
 *
 *  The versioned `runOnce` migrations stay OUTSIDE it — each already opens its own IMMEDIATE transaction
 *  (nesting would demote them to savepoints and lose that fencing). */
function migrate(db: Db): void {
  withWriteLock(db, () => { applyAdditiveMigrations(db); });
  migrateToolNames(db);
  migrateMcpToolNames(db);
  migrateRegistryToolNames(db);
  repairImageToolNames(db);
  widenSessionEventKinds(db);
  dropPersonalityTables(db);
  makeUserIdsMonotonic(db);
  repairUserSequenceBelowReferences(db);
  widenSessionEventKindsForSubagent(db);
  widenSessionEventKindsForWorkflow(db);
  keyToolResultSpillsByOccurrence(db);
  migrateExecIdentity(db);
  migrateExecIdentityDropPrefix(db);
  migrateDocsToolName(db);
  // LAST, and it must stay last: these run in call order but share ONE `user_version` counter, so a
  // migration with the highest number placed earlier would raise the counter past every migration
  // below it and skip them all in silence.
  backfillActivityBuckets(db);
}

/** Run `apply` in an IMMEDIATE transaction, retrying while another process holds the write lock.
 *
 *  `busy_timeout` covers a lock held by a writer that is making progress, but not SQLITE_BUSY_SNAPSHOT —
 *  raised when our read snapshot cannot be upgraded — which no timeout resolves and only a fresh attempt
 *  can clear. Bounded: a lock still held after this many tries is a genuine fault and must surface. */
export function withWriteLock<T>(db: Db, apply: () => T): T {
  const attempts = 5;
  for (let i = 1; ; i++) {
    try {
      return db.transaction(apply).immediate();
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (i >= attempts || !code.startsWith('SQLITE_BUSY')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * i);
    }
  }
}

function applyAdditiveMigrations(db: Db): void {
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf-8'));
  installBrainUsageRollup(db);
  // Additive migrations for DBs created before a column existed. Idempotent: a column that already
  // exists is skipped via PRAGMA table_info, so we never rely on swallowing arbitrary ALTER errors
  // (a real failure — disk full, lock — now surfaces instead of being silently caught).
  addColumn(db, 'projects', 'notes', "TEXT NOT NULL DEFAULT ''");
  // Project icon: a project-relative path to an image file already in the repo (e.g. assets/logo.png).
  // Empty = the default folder glyph. Never an uploaded copy — it references a file in the project.
  addColumn(db, 'projects', 'icon', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'allowed_execs', "TEXT NOT NULL DEFAULT ''");
  // Per-user tool deny-list (CSV of plugin tool names disabled for this user's own brain sessions).
  addColumn(db, 'users', 'disabled_tools', "TEXT NOT NULL DEFAULT ''");
  // Per-user tool ALLOW-list (CSV of plugin tool names). This is the authority a turn runs under: a plugin
  // tool the writer's account does not name is neither offered to the model nor executable, so a newly
  // installed plugin or MCP server stays invisible until an admin grants it.
  //
  // The default is the `*` wildcard, NOT the empty string, and that is deliberate: ALTER TABLE writes the
  // default into every existing row, so migrating an instance cannot silently strip its accounts of every
  // plugin tool. Existing accounts therefore stay unrestricted until an admin narrows them (or
  // scripts/migrate-tool-allowlist.mjs converts the wildcard into the explicit catalogue-minus-deny list,
  // which is what actually starts the fail-closed behaviour for newly installed tools).
  // A NEWLY created account is inserted with an empty list instead — see UserStore.create.
  addColumn(db, 'users', 'allowed_tools', "TEXT NOT NULL DEFAULT '*'");
  // Per-user plugin grant-list (CSV of plugin names). Empty on every migrated row, which is the
  // deny-by-default this feature wants: a `userGrantable` plugin stays admin-only until an admin hands
  // it out. Plugins that do not opt in are unaffected, so an upgrade changes nothing on its own.
  addColumn(db, 'users', 'granted_plugins', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'name', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'email', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'avatar', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'default_exec', "TEXT NOT NULL DEFAULT ''");
  // Per-user advisor: the remembered agent exec (empty = not set up yet) and whether it auto-starts
  // on login. Additive so existing DBs gain them with sensible defaults (autostart on once chosen).
  addColumn(db, 'users', 'advisor_exec', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'users', 'advisor_autostart', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'auth_tokens', 'scope', "TEXT NOT NULL DEFAULT 'full'");
  // Timeline drill-down: events carry the project they belong to (derived from the task at write
  // time) so the UI can scope/link an event to its repo. Nullable — mission/signal events have none.
  // The index is created here (not in schema.sql) so it runs *after* the column exists on migrated DBs.
  addColumn(db, 'events', 'project_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id)');
  // Timeline labels: snapshot the task/epic title at write time so an event still reads as a name
  // after its task is deleted (events outlive tasks). Empty for signal/plan and unknown tasks.
  addColumn(db, 'events', 'label', "TEXT NOT NULL DEFAULT ''");
  // Team activity feed: who acted, from where, and how many times within one bucket. Existing rows
  // keep actor NULL and surface '' — an event recorded before attribution existed cannot be
  // attributed retroactively, and guessing an actor for it would be a lie in an audit trail.
  addColumn(db, 'events', 'actor_user_id', 'INTEGER');
  addColumn(db, 'events', 'surface', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'events', 'count', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'events', 'last_ts', 'TEXT');
  // Created HERE, not in schema.sql: that file is applied first, so on a pre-existing database the
  // index would reference columns the ALTERs above have not added yet and abort the whole migration.
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_actor_bucket ON events(actor_user_id, type, last_ts DESC)');
  // Retired agents/work tables may still be present on an upgraded database, but core no longer owns or
  // migrates their columns. Leaving those physical rows untouched preserves recoverability without
  // reintroducing either domain into the platform schema.
  // Memory categories: a memory's assigned category (nullable, id-addressed — a rename never re-tags).
  // Index created here (not schema.sql) so it runs after the column exists on migrated DBs.
  addColumn(db, 'memories', 'category_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_user_category ON memories(user_id, category_id)');
  // Memory category icon: a lucide name from the server ICON_ALLOWLIST. Empty on migrated rows → the UI
  // falls back to 'Folder'. The store clamps unknown names to 'Folder' on every create/update.
  addColumn(db, 'memory_categories', 'icon', "TEXT NOT NULL DEFAULT ''");
  // NULL categories are global; a non-null project binding scopes recall to exactly one project.
  addColumn(db, 'memory_categories', 'project_id', 'INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_categories_user_project ON memory_categories(user_id, project_id) WHERE project_id IS NOT NULL');
  // Which model performed a memory mutation (curator/categorizer). Nullable — human/API events have none.
  addColumn(db, 'memory_events', 'model', 'TEXT');
  // The provider entry a conversation last ran on, kept beside `model` so a respawn can restore the
  // exact provider+model pair it was running. A model id alone is ambiguous (two entries can expose the
  // same one), so an empty value here means "unknown" and the caller falls back to preference order.
  addColumn(db, 'brain_sessions', 'provider', "TEXT NOT NULL DEFAULT ''");
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
  // Fork provenance (see brain_sessions in schema.sql). NULL on every existing row — nothing was forked
  // before this column existed — and deliberately separate from parent_session_id, which means "delegated
  // child" to the usage roll-up, the retention janitor and the sub-agent listing.
  addColumn(db, 'brain_sessions', 'forked_from_session_id', 'TEXT');
  // Immutable spill namespace (see schema.sql). The backfill FREEZES every pre-existing conversation's
  // namespace at its current id — exactly the directory its spill files and already-sent placeholders
  // point at today — so nothing on disk moves. It must stay idempotent and re-run every boot: a row
  // minted by an older build during a rolling update lands with '' and is frozen at the next start,
  // before any runtime re-key could change what "current id" means.
  addColumn(db, 'brain_sessions', 'spill_ns', "TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE brain_sessions SET spill_ns = id WHERE spill_ns = ''");
  // When this conversation was last emptied by /clear (see brain_sessions in schema.sql). NULL on every
  // existing row — nothing had been cleared before the command existed.
  addColumn(db, 'brain_sessions', 'cleared_at', 'TEXT');
  // Direct 1:1 platform chat (see brain_sessions in schema.sql). 0 on every existing row, so nothing
  // changes until an adapter marks a conversation — a shared room keeps behaving exactly as it does now.
  addColumn(db, 'brain_sessions', 'direct', 'INTEGER NOT NULL DEFAULT 0');
  // Who last wrote in a conversation (see brain_sessions in schema.sql). NULL on every existing row and
  // filled from the next message onwards — the register simply shows no writer until then, rather than
  // this needing a backfill that would have to scan brain_messages to invent one.
  addColumn(db, 'brain_sessions', 'last_writer_user_id', 'INTEGER');
  // Shutdown park marker + resume attempt counter (see brain_sessions in schema.sql). NULL/0 on every
  // pre-upgrade row — nothing was parked before these columns existed, so the boot resume sweep sees
  // exactly nothing to do on an upgraded database.
  addColumn(db, 'brain_sessions', 'parked_at', 'TEXT');
  addColumn(db, 'brain_sessions', 'park_attempts', 'INTEGER NOT NULL DEFAULT 0');
  // The delegated-result inbox now serves two producers (see brain_subagent_results in schema.sql):
  // `kind` discriminates them and `workflow_id` links a workflow row to its brain_workflows DAG. Old
  // rows are all sub-agent completions, so the 'subagent' default reads the whole back catalogue right.
  addColumn(db, 'brain_subagent_results', 'kind', "TEXT NOT NULL DEFAULT 'subagent'");
  addColumn(db, 'brain_subagent_results', 'workflow_id', 'TEXT');
  // Boot owner wake failures are bounded independently from transport delivery retries. Existing pending
  // rows start at zero and are counted only when a whole boot cannot produce a settled owner answer.
  addColumn(db, 'brain_subagent_results', 'wake_attempts', 'INTEGER NOT NULL DEFAULT 0');
  // Host-owned recovery lifecycle for delegated runs (see brain_subagent_runs in schema.sql). All
  // nullable/zero-default so a row written before these columns existed reads as legacy: a later data
  // migration backfills `lifecycle` from the JSON `state`, and boot recovery only ever claims rows an
  // owner_boot_id stamped — never a NULL one — so a NULL here can never be mistaken for live work.
  // job_id lets a `dlg-` handle resolve after the in-memory job map is gone; lifecycle drives boot
  // recovery; attempt bounds respawn retries; owner_boot_id + lease_until are the compare-and-swap claim.
  addColumn(db, 'brain_subagent_runs', 'job_id', 'TEXT');
  addColumn(db, 'brain_subagent_runs', 'lifecycle', 'TEXT');
  addColumn(db, 'brain_subagent_runs', 'attempt', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'brain_subagent_runs', 'owner_boot_id', 'TEXT');
  addColumn(db, 'brain_subagent_runs', 'lease_until', 'INTEGER');
  // Restart-safe workflow resume (see brain_workflows in schema.sql): owner_boot_id marks which boot
  // wrote the last running snapshot, attempt bounds resume retries. Rows written before these columns
  // read as NULL-owner: a running NULL row is by definition from a dead pre-upgrade boot, so the boot
  // reconcile may claim it — its resume then fails on the missing recovery journal and terminalizes,
  // which is exactly the pre-upgrade behaviour for those rows.
  addColumn(db, 'brain_workflows', 'owner_boot_id', 'TEXT');
  addColumn(db, 'brain_workflows', 'attempt', 'INTEGER NOT NULL DEFAULT 0');
  // Backfill lifecycle from the legacy JSON state exactly once per row, then leave it to the store. A
  // terminal state maps straight through; a legacy `running` row becomes `legacy_interrupted`, NOT a
  // recovery candidate — it predates the owner_boot_id claim, so respawning it could repeat a mutation
  // from weeks ago. Runs every boot but is idempotent (WHERE lifecycle IS NULL), so a row minted by the
  // new code (which always writes lifecycle) is never touched, and only genuinely legacy NULLs are filled.
  // The json_valid guard is load-bearing: json_extract THROWS on a malformed row, which would fail the
  // UPDATE for every row; a malformed legacy row simply keeps NULL and boot recovery never claims it.
  db.exec(
    `UPDATE brain_subagent_runs
        SET lifecycle = CASE json_extract(state, '$.status')
                          WHEN 'done'  THEN 'done'
                          WHEN 'error' THEN 'error'
                          ELSE 'legacy_interrupted'
                        END
      WHERE lifecycle IS NULL AND json_valid(state)`
  );
  // Mid-turn (provisional) message rows — see brain_messages in schema.sql. Every existing row was written
  // by a settled agent_end, so the 0 default correctly reads the whole back catalogue as durable history.
  addColumn(db, 'brain_messages', 'pending', 'INTEGER NOT NULL DEFAULT 0');
  // Display-only whole-turn timing lives outside message JSON: rehydration reads `content` only, so this
  // additive column cannot alter a provider payload or invalidate the cached transcript prefix.
  addColumn(db, 'brain_messages', 'turn_duration_ms', 'INTEGER');
  // Provider request rows are opened before the network call and terminally accounted exactly once. Any
  // pending row surviving process startup belongs to a request whose in-memory correlator died; mark it
  // interrupted before sessions can respawn, and never fold it into the summary a second time.
  db.exec(
    `INSERT INTO brain_request_session_summary
       (session_id, capture_started_at, request_count, error_count, first_request_at, last_request_at)
     SELECT session_id, MIN(started_at), COUNT(*), COUNT(*), MIN(started_at), unixepoch('now') * 1000
       FROM brain_provider_requests WHERE status = 'pending' GROUP BY session_id
     ON CONFLICT(session_id) DO UPDATE SET
       request_count = request_count + excluded.request_count,
       error_count = error_count + excluded.error_count,
       first_request_at = MIN(first_request_at, excluded.first_request_at),
       last_request_at = MAX(last_request_at, excluded.last_request_at);
     UPDATE brain_provider_requests
        SET status = 'interrupted', finished_at = COALESCE(finished_at, unixepoch('now') * 1000),
            duration_ms = COALESCE(duration_ms, MAX(0, unixepoch('now') * 1000 - started_at)),
            error_code = COALESCE(error_code, 'daemon_restart'),
            error_message = COALESCE(error_message, 'Provider request interrupted by daemon restart')
      WHERE status = 'pending'`
  );
  // A linked platform id is an identity key — enforce one-owner-per-id with a partial UNIQUE index so a
  // squatter can't claim another user's id (see schema.sql). Created here too for pre-existing DBs, and
  // derived per identity descriptor: the index NAME and the key are pinned in the descriptor, so this
  // recreates exactly the indexes live databases already carry and needs no data migration.
  for (const d of PLATFORM_IDENTITIES) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${d.indexName} ON user_settings(value) WHERE key = '${d.linkSettingKey}'`);
  }
  ensureUniqueUserEmailIndex(db);
  // Seed the bootstrap admin on existing DBs: the lowest-id user, if none is flagged yet.
  db.exec("UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)");
  // Rename prompt template keys to match the elowen/elowen-platform rename (advisor → elowen, advisor-channel → elowen-platform).
  db.exec("UPDATE user_prompts SET name = 'elowen' WHERE name = 'advisor'");
  db.exec("UPDATE user_prompts SET name = 'elowen-platform' WHERE name = 'advisor-channel'");
}

/** v8 — re-seed `sqlite_sequence` for `users` on a database that already ran v7.
 *
 *  v7 originally rebuilt the table without raising the counter past ids whose user had ALREADY been
 *  deleted, so a database migrated by that version sits with the counter below a still-referenced id and
 *  would hand the next account someone else's rows. v7 now seeds correctly, but it never runs twice, so
 *  a database that took the earlier version can only be repaired by a new version — hence v8.
 *
 *  Idempotent and harmless where nothing is wrong: the seed only ever raises the counter. */
function repairUserSequenceBelowReferences(db: Db): void {
  runOnce(db, 8, () => { seedUserSequenceAboveEveryReference(db); });
}

/** v15 — seed the activity heatmap from the history that already exists.
 *
 *  The rollup is filled at write time from here on, but an instance that has been running for weeks
 *  would show an empty tile for a month before it filled in. One grouped pass over `brain_messages`
 *  produces the whole backlog: measured at 743ms over 186672 rows, which is acceptable exactly once at
 *  boot and would not be acceptable per request — which is why the read path never does it.
 *
 *  Scoped to 90 days: further back the tile does not show it, and the pass stays bounded on an old
 *  instance. `INSERT OR IGNORE` keeps a re-run (a restored database taking v15 again) from double
 *  counting rows the live path has since written.
 *
 *  The number must be HIGHER than every other runOnce in this file, not merely unused-looking: runOnce
 *  compares against a single `user_version` counter, so a number at or below the database's current
 *  value is skipped in silence. This shipped as v9 first -- a number already taken by another migration
 *  -- and did nothing on a live database sitting at 14. `migrationVersionsAreUnique` now fails the build
 *  on a repeat. */
function backfillActivityBuckets(db: Db): void {
  runOnce(db, 15, () => {
    db.prepare(
      `INSERT OR IGNORE INTO activity_buckets (day, hour, user_id, count)
       SELECT strftime('%Y-%m-%d', m.created_at),
              CAST(strftime('%H', m.created_at) AS INTEGER),
              COALESCE(s.user_id, 0),
              COUNT(*)
         FROM brain_messages m
         JOIN brain_sessions s ON s.id = m.session_id
        WHERE m.role = 'user'
          AND m.created_at > datetime('now', '-90 days')
        GROUP BY 1, 2, 3`
    ).run();
  });
}

/** v7 — rebuild `users` with `id INTEGER PRIMARY KEY AUTOINCREMENT`.
 *
 *  Without AUTOINCREMENT the id is a bare rowid, which SQLite assigns as max(id)+1 — so deleting the
 *  HIGHEST-numbered user frees that id and hands it to the next account created. Ownership columns
 *  (`tasks.created_by`, `missions.created_by`) reference users by id, so the new account would inherit
 *  the deleted user's task attribution and mission notifications. UserStore.delete now nulls those
 *  columns, which fixes the data already written; this fixes the id reuse itself, so nothing added
 *  later can walk into the same trap.
 *
 *  A table rebuild, because AUTOINCREMENT is part of the PRIMARY KEY declaration and SQLite cannot add
 *  it with ALTER TABLE — the same reason v5 had to rebuild brain_session_events.
 *
 *  Every existing id is preserved as-is (the INSERT carries `id` explicitly), so every reference from
 *  every other table stays valid — this renumbers nobody. SQLite sets sqlite_sequence to the largest
 *  id inserted, so the counter resumes above the current maximum rather than restarting at 1.
 *
 *  Safe under `foreign_keys = ON` (set in openDb): the whole schema declares exactly one foreign key,
 *  and it is memory_embeddings → memories. Nothing REFERENCES users, so dropping the old table cannot
 *  cascade or be rejected.
 *
 *  Column list written out in full rather than `SELECT *` so a column added to schema.sql later fails
 *  loudly here instead of being silently dropped on every migrating database. It runs AFTER the
 *  addColumn block above, so a database that predates any of these columns already has them by now.
 *
 *  NUMBERED 7: versions 1-6 are all spent (see the runners above) — a migration numbered ≤6 would be
 *  skipped in silence on exactly the databases that need it. */
function makeUserIdsMonotonic(db: Db): void {
  runOnce(db, 7, () => {
    const alreadyMonotonic = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users' AND sql LIKE '%AUTOINCREMENT%'",
    ).get();
    if (alreadyMonotonic) return; // a database created fresh off the current schema.sql needs no rebuild
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        is_admin INTEGER NOT NULL DEFAULT 0,
        allowed_execs TEXT NOT NULL DEFAULT '',
        disabled_tools TEXT NOT NULL DEFAULT '',
        allowed_tools TEXT NOT NULL DEFAULT '*',
        granted_plugins TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        avatar TEXT NOT NULL DEFAULT '',
        default_exec TEXT NOT NULL DEFAULT '',
        advisor_exec TEXT NOT NULL DEFAULT '',
        advisor_autostart INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO users_new (
        id, username, password_hash, created_at, is_admin, allowed_execs, disabled_tools,
        allowed_tools, granted_plugins,
        name, email, avatar, default_exec, advisor_exec, advisor_autostart
      ) SELECT
        id, username, password_hash, created_at, is_admin, allowed_execs, disabled_tools,
        allowed_tools, granted_plugins,
        name, email, avatar, default_exec, advisor_exec, advisor_autostart
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    seedUserSequenceAboveEveryReference(db);
  });
}

/** Every column that names a user. A value here belonging to no live user is a DANGLING reference left
 *  by a deletion, and it is exactly what a recycled id would silently inherit — someone else's
 *  conversations, memories, devices or settings. */
const USER_REFERENCE_COLUMNS: readonly (readonly [table: string, column: string])[] = [
  // Temporary physical-table ownership: keep retired work/agents references in the anti-reuse ceiling
  // until a separately-authorized migration drops those tables. This reads ids only and deletes no rows.
  ['tasks', 'created_by'], ['missions', 'created_by'],
  ['user_settings', 'user_id'], ['user_push_subscriptions', 'user_id'],
  ['brain_sessions', 'user_id'], ['brain_goals', 'user_id'],
  ['memories', 'user_id'], ['memory_events', 'user_id'], ['memory_categories', 'user_id'],
  ['user_projects', 'user_id'], ['user_prompts', 'user_id'], ['auth_tokens', 'user_id'],
  ['brain_terminals', 'user_id'], ['user_plugin_config', 'user_id'],
  ['user_external_identities', 'user_id'],
  ['usage_by_origin', 'user_id'], ['brain_session_origins', 'user_id'],
];

/** AUTOINCREMENT alone does NOT make an id safe to hand out: SQLite seeds `sqlite_sequence` from the
 *  rows actually present, so an id whose user was deleted BEFORE this migration is below the counter and
 *  gets issued again — while rows elsewhere still reference it. This is not hypothetical: the live
 *  database has `brain_sessions.user_id = 4` with no user 4, so a plain rebuild would seed the counter
 *  at 3 and hand the next account someone's deleted conversations.
 *
 *  So push the counter above every id still referenced ANYWHERE, not merely above the surviving users.
 *  Orphaned rows are deliberately left alone — this makes them unreachable, and deleting a departed
 *  user's data is a separate, destructive decision that a schema migration has no business taking. */
function seedUserSequenceAboveEveryReference(db: Db): void {
  const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  let highest = (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM users').get() as { m: number }).m;
  for (const [table, column] of USER_REFERENCE_COLUMNS) {
    if (!tableExists.get(table)) continue; // a database predating this table simply has nothing to contribute
    // A retired plugin table may exist at an older physical schema version without this column; then no
    // row ever referenced a user through it, so the tolerant read correctly contributes zero.
    const m = tolerateMissingPluginTables(
      () => (db.prepare(`SELECT COALESCE(MAX(${column}), 0) AS m FROM ${table}`).get() as { m: number }).m, 0);
    if (m > highest) highest = m;
  }
  if (highest <= 0) return; // nothing has ever referenced a user — the counter may start from scratch
  // The row exists only once an AUTOINCREMENT insert has happened, so upsert rather than assuming it.
  db.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT 'users', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'users')").run(highest);
  db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'users' AND seq < ?").run(highest, highest);
}

/** v6 — drop the retired per-user/per-platform personality tables. The personality subsystem collapsed
 *  into a single global body stored in user_settings (key 'personalityBody'), so both profile tables are
 *  dead. Their CREATE statements are gone from schema.sql, so a fresh DB never makes them; this drops them
 *  on every DB that predates the collapse. DROP TABLE IF EXISTS is idempotent (no-op on a fresh DB) and
 *  takes each table's indexes with it, so no explicit DROP INDEX is needed. Nobody had profiles, so there
 *  is no data to preserve.
 *
 *  NUMBERED 6: versions 4 and 5 are spent (see widenSessionEventKinds) — a runner numbered ≤5 would be
 *  skipped in silence on prod and every install already at user_version 5. */
function dropPersonalityTables(db: Db): void {
  runOnce(db, 6, () => {
    db.exec('DROP TABLE IF EXISTS personality_active_profiles; DROP TABLE IF EXISTS personality_profiles;');
  });
}

/** v5 — let `brain_session_events.kind` also carry 'cwd' (see sessionEvents.ts).
 *
 *  A table rebuild, because SQLite cannot alter a CHECK constraint, and `CREATE TABLE IF NOT EXISTS` in
 *  schema.sql leaves an existing DB on the old one — so without this an inserted 'cwd' marker raises on
 *  every database that predates it while passing on a fresh one.
 *
 *  NUMBERED 5, AND THE NEXT ONE MUST BE 6: version 4 is spent. It shipped in 0.27.6 as the image-tool
 *  repair, so prod and every install of that release already record `user_version = 4` — a migration
 *  numbered 4 would be skipped in silence on exactly the databases that need it. */
function widenSessionEventKinds(db: Db): void {
  runOnce(db, 5, () => {
    db.exec(`
      CREATE TABLE brain_session_events_new (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('model', 'mode', 'rename', 'reasoning', 'cwd')),
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, event_id)
      );
      INSERT INTO brain_session_events_new (session_id, event_id, kind, detail, created_at)
        SELECT session_id, event_id, kind, detail, created_at FROM brain_session_events;
      DROP TABLE brain_session_events;
      ALTER TABLE brain_session_events_new RENAME TO brain_session_events;
      CREATE INDEX IF NOT EXISTS idx_brain_session_events_session ON brain_session_events(session_id);
    `);
  });
}

/** v9 — let `brain_session_events.kind` also carry 'subagent' (a display-only "sub-agent finished"
 *  marker, see sessionEvents.ts / recordSubagentFinishMarker).
 *
 *  Same rebuild rationale as v5 (widenSessionEventKinds): SQLite cannot alter a CHECK constraint and
 *  `CREATE TABLE IF NOT EXISTS` in schema.sql leaves an existing DB on the old one, so an inserted
 *  'subagent' marker would raise on every database that predates this while passing on a fresh one.
 *
 *  NUMBERED 9: versions 1-8 are all spent (see the runners above) — a migration numbered ≤8 would be
 *  skipped in silence on exactly the databases that need it. */
function widenSessionEventKindsForSubagent(db: Db): void {
  runOnce(db, 9, () => {
    db.exec(`
      CREATE TABLE brain_session_events_new (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('model', 'mode', 'rename', 'reasoning', 'cwd', 'subagent')),
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, event_id)
      );
      INSERT INTO brain_session_events_new (session_id, event_id, kind, detail, created_at)
        SELECT session_id, event_id, kind, detail, created_at FROM brain_session_events;
      DROP TABLE brain_session_events;
      ALTER TABLE brain_session_events_new RENAME TO brain_session_events;
      CREATE INDEX IF NOT EXISTS idx_brain_session_events_session ON brain_session_events(session_id);
    `);
  });
}

/** v10 — let `brain_session_events.kind` also carry 'workflow' (a display-only "workflow finished"
 *  marker, see sessionEvents.ts / recordWorkflowFinishMarker).
 *
 *  Same rebuild rationale as v5/v9 (widenSessionEventKinds): SQLite cannot alter a CHECK constraint and
 *  `CREATE TABLE IF NOT EXISTS` in schema.sql leaves an existing DB on the old one, so an inserted
 *  'workflow' marker would raise on every database that predates this while passing on a fresh one.
 *
 *  NUMBERED 10: versions 1-9 are all spent (see the runners above) — a migration numbered ≤9 would be
 *  skipped in silence on exactly the databases that need it. */
function widenSessionEventKindsForWorkflow(db: Db): void {
  runOnce(db, 10, () => {
    db.exec(`
      CREATE TABLE brain_session_events_new (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('model', 'mode', 'rename', 'reasoning', 'cwd', 'subagent', 'workflow')),
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, event_id)
      );
      INSERT INTO brain_session_events_new (session_id, event_id, kind, detail, created_at)
        SELECT session_id, event_id, kind, detail, created_at FROM brain_session_events;
      DROP TABLE brain_session_events;
      ALTER TABLE brain_session_events_new RENAME TO brain_session_events;
      CREATE INDEX IF NOT EXISTS idx_brain_session_events_session ON brain_session_events(session_id);
    `);
  });
}

/** v11 — re-key `brain_tool_result_spills` by OCCURRENCE: (session_id, tool_call_id, occurred_at), plus
 *  the verbatim `placeholder` column (see schema.sql for why both exist).
 *
 *  A table rebuild, because the primary key widens and SQLite cannot alter one in place — same
 *  rationale as v5/v7. Existing rows are carried over with occurred_at = 0 ("legacy row, occurrence
 *  unknown") and placeholder = NULL ("render with the current renderer"); toolResultClearing restores
 *  those through a created_at heuristic that refuses any occurrence stamped AFTER the row was written —
 *  ending the deployed defect where a row whose occurrence a compaction had removed would capture a
 *  brand-new result reusing the same tool call id.
 *
 *  Guarded by shape, not just version: a database created fresh off the current schema.sql already has
 *  the new table (and nothing to migrate), so the rebuild only runs where `occurred_at` is missing.
 *
 *  NUMBERED 11: versions 1-10 are all spent (see the runners above) — a migration numbered ≤10 would be
 *  skipped in silence on exactly the databases that need it. */
function keyToolResultSpillsByOccurrence(db: Db): void {
  runOnce(db, 11, () => {
    const cols = db.prepare('PRAGMA table_info(brain_tool_result_spills)').all() as { name: string }[];
    if (cols.some((c) => c.name === 'occurred_at')) return;
    db.exec(`
      CREATE TABLE brain_tool_result_spills_new (
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        preview TEXT,
        path TEXT NOT NULL,
        placeholder TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, tool_call_id, occurred_at)
      );
      INSERT INTO brain_tool_result_spills_new (session_id, tool_call_id, mode, bytes, preview, path, created_at)
        SELECT session_id, tool_call_id, mode, bytes, preview, path, created_at FROM brain_tool_result_spills;
      DROP TABLE brain_tool_result_spills;
      ALTER TABLE brain_tool_result_spills_new RENAME TO brain_tool_result_spills;
    `);
  });
}

/**
 * v12 — replace the legacy `elowen:` prefix with the interim `elowen|provider|model` composite.
 *
 * The spelling is written out longhand instead of calling `execRefSpec`, because a migration must
 * produce the exact bytes it produced the day it shipped. Sharing the live formatter means a later
 * change to the canonical spelling silently rewrites history: v13 assumes every value v12 touched
 * carries the composite marker, and when v12 started emitting v13's own output instead, v13 read those
 * values as unclaimed OpenCode execs and prefixed them. Migrations are frozen by definition.
 */
function migrateExecIdentity(db: Db): void {
  runOnce(db, 12, () => rewriteStoredExecs(db, (value) => {
    if (typeof value !== 'string' || !value.startsWith('elowen:')) return value;
    const ref = parseExecRef(value);
    if (!ref || ref.program !== 'elowen') return value;
    return `elowen|${encodeURIComponent(ref.provider)}|${encodeURIComponent(ref.model)}`;
  }));
}

/**
 * v13 — drop the prefix from the brain's identity for good.
 *
 * The canonical spelling is now bare `<provider>/<model>`, so exactly one program may own the
 * unprefixed slash shape and it is the brain. OpenCode held that shape historically and is therefore
 * rewritten to its explicit `opencode:` prefix FIRST — every bare-slash value still in the database at
 * this point predates the switch and belongs to OpenCode, because v12 wrote every brain exec as the
 * `elowen|…` composite. Reading a leftover OpenCode value after the switch would route it into the
 * embedded brain, which is the silent breakage this whole migration exists to avoid.
 *
 * Ordering inside one pass matters: the decision is made on the value as it was READ, so a brain exec
 * unwrapped to `provider/model` here is never re-examined and mistaken for an OpenCode leftover.
 */
function migrateExecIdentityDropPrefix(db: Db): void {
  runOnce(db, 13, () => rewriteStoredExecs(db, (value) => {
    if (typeof value !== 'string' || !value) return value;
    if (value.startsWith('elowen:') || value.startsWith('elowen|')) {
      const ref = parseExecRef(value);
      return ref ? execRefSpec(ref) : value;
    }
    const prefixed = Object.keys(PROGRAM_PREFIXES).some(p => value.startsWith(p));
    return !prefixed && value.includes('/') ? `opencode:${value}` : value;
  }));
}

/** Apply `canonical` to every exec value this database stores. The identity migrations differ only in
 *  the spelling they produce — never in WHERE execs live — so the column walk belongs here, once. */
function rewriteStoredExecs(db: Db, canonical: (value: unknown) => unknown): void {
  {
    const rewriteList = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value;

    const settings = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
    if (settings) {
      const next = rewriteJson(settings.data, (blob) => {
        const root = blob as Record<string, unknown>;
        root.allowedExecs = rewriteList(root.allowedExecs);
        root.hiddenPresets = rewriteList(root.hiddenPresets);
        if (Array.isArray(root.customModels)) {
          for (const item of root.customModels as Record<string, unknown>[]) if (item && typeof item === 'object') item.exec = canonical(item.exec);
        }
        if (root.modelNotes && typeof root.modelNotes === 'object' && !Array.isArray(root.modelNotes)) {
          root.modelNotes = Object.fromEntries(Object.entries(root.modelNotes as Record<string, unknown>).map(([k, v]) => [canonical(k) as string, v]));
        }
        const defaults = root.defaults as Record<string, unknown> | undefined;
        if (defaults) defaults.exec = canonical(defaults.exec);
        const configs = (root.plugins as { config?: Record<string, Record<string, unknown>> } | undefined)?.config;
        for (const name of ['discord', 'whatsapp']) if (configs?.[name]) configs[name].visionModel = canonical(configs[name].visionModel);
        for (const name of ['image-gen', 'image-edit']) if (configs?.[name]) configs[name].model = canonical(configs[name].model);
      });
      if (next && next !== settings.data) db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(next);
    }

    const users = db.prepare('SELECT id, allowed_execs, default_exec, advisor_exec FROM users').all() as Array<{ id: number; allowed_execs: string; default_exec: string; advisor_exec: string }>;
    for (const user of users) {
      const allowed = user.allowed_execs.split(',').map(v => canonical(v) as string).join(',');
      const defaultExec = canonical(user.default_exec) as string;
      const advisorExec = canonical(user.advisor_exec) as string;
      if (allowed !== user.allowed_execs || defaultExec !== user.default_exec || advisorExec !== user.advisor_exec) {
        db.prepare('UPDATE users SET allowed_execs = ?, default_exec = ?, advisor_exec = ? WHERE id = ?').run(allowed, defaultExec, advisorExec, user.id);
      }
    }
  }
}

/** Apply `rename` to every tool name this DB stores. Four surfaces, and every one of them matches by
 *  exact string, so a name the code no longer uses does not raise — it stops matching. A stale DENY
 *  silently RE-ENABLES its tool and the `write_file`/`edit_file` "ask" defaults stop prompting (fail
 *  open); a stale ALLOW-list leaves a platform role with no tools at all (fail closed). `rename` returns
 *  its input unchanged for anything it does not own. */
function renameStoredToolNames(db: Db, rename: (name: string) => string): void {
  // The two per-user tool lists, each a CSV of exact names. Both must be rewritten: a stale entry in the
  // DENY list silently re-enables its tool, and a stale entry in the ALLOW list silently removes one.
  for (const column of ['disabled_tools', 'allowed_tools'] as const) {
    // A rename gate can fire BEFORE the column is added: the one-shot migrations run near the top of
    // `migrate`, the `addColumn` calls further down. A column that does not exist yet also holds no stale
    // name — it is about to be created carrying only its default — so skipping it loses nothing.
    const columns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) continue;
    const users = db.prepare(`SELECT id, ${column} AS names FROM users WHERE ${column} != ''`)
      .all() as { id: number; names: string }[];
    for (const u of users) {
      const next = u.names.split(',').map(rename).join(',');
      if (next !== u.names) db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(next, u.id);
    }
  }
  // Saved permission rules. Only the `tools` scope holds tool names — `bash` patterns are shell commands
  // ("git status*") and must not be touched. Rebuilding the map preserves JSON key order, which is
  // load-bearing: rule precedence is last-match-wins (see resolveToolPermission).
  const userPerms = db.prepare("SELECT user_id, value FROM user_settings WHERE key = 'permissions'")
    .all() as { user_id: number; value: string }[];
  for (const s of userPerms) {
    const next = rewriteJson(s.value, (blob) => {
      const tools = (blob as { tools?: unknown }).tools;
      if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return;
      (blob as { tools: Record<string, unknown> }).tools = renameKeys(tools as Record<string, unknown>, rename);
    });
    if (next && next !== s.value) {
      db.prepare("UPDATE user_settings SET value = ? WHERE user_id = ? AND key = 'permissions'").run(next, s.user_id);
    }
  }
  // A delegated child's frozen boundary. Deliberately never re-read from current settings, so nothing
  // else would ever repair it; rewriting names preserves its meaning exactly rather than re-deriving it.
  const scopes = db.prepare('SELECT id, delegated_access FROM brain_sessions WHERE delegated_access IS NOT NULL')
    .all() as { id: string; delegated_access: string }[];
  for (const s of scopes) {
    const next = rewriteJson(s.delegated_access, (blob) => {
      const tp = (blob as { toolPolicy?: { allow?: unknown; deny?: unknown } }).toolPolicy;
      if (tp) for (const k of ['allow', 'deny'] as const) {
        if (Array.isArray(tp[k])) tp[k] = (tp[k] as unknown[]).map((n) => typeof n === 'string' ? rename(n) : n);
      }
      const rules = (blob as { permissionBoundary?: { rules?: unknown } }).permissionBoundary?.rules;
      if (Array.isArray(rules)) {
        for (const r of rules as { scope?: unknown; pattern?: unknown }[]) {
          if (r?.scope === 'tools' && typeof r.pattern === 'string') r.pattern = rename(r.pattern);
        }
      }
    });
    if (next && next !== s.delegated_access) {
      db.prepare('UPDATE brain_sessions SET delegated_access = ? WHERE id = ?').run(next, s.id);
    }
  }
  // A platform role's tool allow-list used to be rewritten here too. It is gone: the host never read it,
  // so it could only ever promise a restriction nothing enforced. Any such key left in an old settings
  // blob is inert — unknown config keys are preserved but never projected back to the UI — so there is
  // nothing to rename and nothing to clean up.
}

/** Run a one-shot data migration behind `PRAGMA user_version`.
 *
 *  Every other migration in this file is idempotent by construction — `addColumn` checks the table shape,
 *  and `WHERE name = 'advisor'` can never re-match. A tool RENAME is not: the freed names are generic
 *  enough that a third-party plugin could later legitimately register `read_file`, and a second run would
 *  then rewrite a user's rule for THAT tool. So each runs exactly once, ever.
 *
 *  IMMEDIATE, and the gate is re-read and set INSIDE the transaction. Several processes call openDb on the
 *  same file — the daemon, `elowen update --auto` (which runs alongside it by design), missionGate — so a
 *  deferred transaction lets two of them both pass the check and then collide when the second tries to
 *  upgrade its read snapshot to a write (SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot resolve). Setting
 *  the gate inside also means a crash between commit and the pragma cannot leave migrated data with the
 *  gate still armed. */
function runOnce(db: Db, version: number, apply: () => void): void {
  if ((db.pragma('user_version', { simple: true }) as number) >= version) return;
  db.transaction(() => {
    if ((db.pragma('user_version', { simple: true }) as number) >= version) return;
    apply();
    db.pragma(`user_version = ${version}`);
  }).immediate();
}

/** v1 — snake_case → TitleCase (see toolRenames.ts). */
function migrateToolNames(db: Db): void {
  runOnce(db, 1, () => renameStoredToolNames(db, renameTool));
}

/** v2 — MCP bridged names gain double separators: `mcp_<server>_<tool>` → `mcp__<server>__<tool>`.
 *
 *  The single-underscore form was ambiguous. A server name and a tool name may each contain `_` after
 *  sanitizing, so `mcp_chrome_devtools_click` splits as either (chrome, devtools_click) or
 *  (chrome_devtools, click) and the string cannot tell you which — which is the whole reason for the
 *  change, and also why this cannot be a name map: an old name is only splittable against the CONFIGURED
 *  server list, read here from the mcp plugin's own config.
 *
 *  `sanitize` is duplicated rather than imported: plugins/mcp is loaded dynamically and this must stay
 *  frozen at what shipped when these names were written — a migration encodes history, not the live rule.
 *  A server since removed from config cannot be split, so its tools keep their old names and their rules
 *  go stale; nothing re-derives an mcp name, so there is no other source to recover it from. */
function migrateMcpToolNames(db: Db): void {
  runOnce(db, 2, () => {
    const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';
    const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
    if (!row) return;
    let servers: string[] = [];
    try {
      const cfg = (JSON.parse(row.data) as { plugins?: { config?: { mcp?: { servers?: unknown } } } }).plugins?.config?.mcp?.servers;
      if (Array.isArray(cfg)) {
        servers = cfg
          .map((s) => (s as { name?: unknown } | null)?.name)
          .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
          .map(sanitize);
      }
    } catch { return; } // a corrupt settings blob is not this migration's to repair
    if (servers.length === 0) return;
    // Longest first: one server's sanitized token can prefix another's ("gh" vs "gh_enterprise").
    servers.sort((a, b) => b.length - a.length);
    renameStoredToolNames(db, (name) => {
      for (const s of servers) {
        const old = `mcp_${s}_`;
        if (name.startsWith(old)) return `mcp__${s}__${name.slice(old.length)}`;
      }
      return name;
    });
  });
}

/** v3 — the marketplace registry's plugin tools → TitleCase (see REGISTRY_TOOL_RENAMES).
 *
 *  Those plugins install from the registry on versions of their own, so they renamed one release after the
 *  built-ins did — by which time v1 had run and marked itself done, and a map grown after the fact would
 *  never be applied to anyone. Hence a version of its own.
 *
 *  Safe to run against a database that never had these plugins, and against one already carrying the new
 *  names: the map is keyed on the old names alone, so anything else passes through untouched.
 *
 *  A rule survives the rename; the WINDOW between the two updates does not. Until the plugin itself is
 *  updated it still offers `todo_write` while the rule now says `TodoWrite`, and the rule matches nothing
 *  in the meantime — which for a DENY means the tool is briefly back on. Unavoidable from this side: the
 *  daemon cannot rename a tool inside a plugin it does not ship. */
function migrateRegistryToolNames(db: Db): void {
  runOnce(db, 3, () => renameStoredToolNames(db, renameRegistryTool));
}

/** v4 — repair the two image tools 0.27.5 spelled prefix-first (see IMAGE_TOOL_REPAIR).
 *
 *  A database that skipped 0.27.5 gets the corrected names from v3 and finds nothing to do here; one that
 *  ran it is carrying names no plugin has ever registered, and only this can reach them — v3 is marked
 *  done and will not re-read its map. */
function repairImageToolNames(db: Db): void {
  runOnce(db, 4, () => renameStoredToolNames(db, repairImageTool));
}

/** v14 — `ElowenDocs` → `DocsSearch` (see DOCS_TOOL_RENAMES).
 *
 *  Runs last among the tool renames because it is the newest, not because it depends on them: the name it
 *  rewrites was minted long after the snake_case era, so no earlier map can have touched it. The stored
 *  boundaries this reaches — deny-lists, permission rules, role allow-lists and every delegated
 *  sub-agent's frozen `toolPolicy` — are exact-string matches that stop matching rather than raise. */
function migrateDocsToolName(db: Db): void {
  runOnce(db, 14, () => renameStoredToolNames(db, renameDocsTool));
}

/** Apply `mutate` to a parsed JSON object and re-serialize. A blob that is corrupt or not an object is
 *  left exactly as found: this migration renames names, it is not the place to repair stored data. */
function rewriteJson(raw: string, mutate: (blob: object) => void): string | undefined {
  let blob: unknown;
  try { blob = JSON.parse(raw); } catch { return undefined; }
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return undefined;
  mutate(blob);
  return JSON.stringify(blob);
}

/** Rename a rule map's keys, preserving insertion order. A rename that collides with an existing key
 *  keeps the LAST value — matching last-match-wins — but lands it in the FIRST key's slot, which is how
 *  JS object keys work. Order is precedence, so a merged rule is promoted ahead of anything that used to
 *  outrank it. Harmless for the only collision that can realistically occur (a user holding rules for
 *  both an old and its new name), and no prod DB has one. */
function renameKeys(map: Record<string, unknown>, rename: (name: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [pattern, action] of Object.entries(map)) out[rename(pattern)] = action;
  return out;
}
