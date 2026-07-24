import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renameRegistryTool, renameTool, repairImageTool } from './toolRenames.js';

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
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_telegram_id ON user_settings(value) WHERE key = 'telegramUserId'");
  // Seed the bootstrap admin on existing DBs: the lowest-id user, if none is flagged yet.
  db.exec("UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)");
  // Rename prompt template keys to match the elowen/elowen-platform rename (advisor → elowen, advisor-channel → elowen-platform).
  db.exec("UPDATE user_prompts SET name = 'elowen' WHERE name = 'advisor'");
  db.exec("UPDATE user_prompts SET name = 'elowen-platform' WHERE name = 'advisor-channel'");
  migrateToolNames(db);
  migrateMcpToolNames(db);
  migrateRegistryToolNames(db);
  repairImageToolNames(db);
  widenSessionEventKinds(db);
  dropPersonalityTables(db);
  return db;
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

/** Apply `rename` to every tool name this DB stores. Four surfaces, and every one of them matches by
 *  exact string, so a name the code no longer uses does not raise — it stops matching. A stale DENY
 *  silently RE-ENABLES its tool and the `write_file`/`edit_file` "ask" defaults stop prompting (fail
 *  open); a stale ALLOW-list leaves a platform role with no tools at all (fail closed). `rename` returns
 *  its input unchanged for anything it does not own. */
function renameStoredToolNames(db: Db, rename: (name: string) => string): void {
  // Per-user tool deny-list: a CSV of exact names.
  const users = db.prepare("SELECT id, disabled_tools FROM users WHERE disabled_tools != ''")
    .all() as { id: number; disabled_tools: string }[];
  for (const u of users) {
    const next = u.disabled_tools.split(',').map(rename).join(',');
    if (next !== u.disabled_tools) db.prepare('UPDATE users SET disabled_tools = ? WHERE id = ?').run(next, u.id);
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
  // A platform role's tool ALLOW-list, inside the settings blob. `rolePolicies` is a declared config
  // type, not a Discord-only field, so walk every plugin's config rather than name one.
  const settings = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
  if (!settings) return;
  const next = rewriteJson(settings.data, (blob) => {
    const configs = (blob as { plugins?: { config?: Record<string, unknown> } }).plugins?.config;
    if (!configs || typeof configs !== 'object') return;
    for (const cfg of Object.values(configs)) {
      const policies = (cfg as { rolePolicies?: unknown } | null)?.rolePolicies;
      if (!Array.isArray(policies)) continue;
      for (const p of policies as ({ tools?: unknown } | null)[]) {
        // An empty list or ['*'] means "unrestricted" — `rename` leaves '*' alone, so both survive.
        if (Array.isArray(p?.tools)) p.tools = (p.tools as unknown[]).map((n) => typeof n === 'string' ? rename(n) : n);
      }
    }
  });
  if (next && next !== settings.data) db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(next);
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
