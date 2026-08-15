// Builds a realistic OLD-schema SQLite fixture for the migration E2E test.
//
// The source-tree tests all run against a FRESH schema (openDb on an empty file), so they never exercise
// the migration path that a real user's DB takes on upgrade. This fixture reconstructs a database as it
// looked BEFORE the versioned migrations in src/store/db.ts ran: `PRAGMA user_version = 0`, the migration-
// touched tables at their OLD shape (missing the columns later added by addColumn, the pre-'cwd' CHECK on
// brain_session_events, the since-retired personality tables), and rows written with the OLD tool names.
//
// Booting the real daemon against this file must upgrade it in place: advance user_version to CURRENT,
// rewrite every stored snake_case tool name to its TitleCase form, rename the advisor prompt keys, rebuild
// brain_session_events, drop the personality tables — all WITHOUT dropping or re-seeding user data (a
// pre-existing admin must still authenticate; setup must NOT re-trigger). The assertions in run.mjs pin the
// exact post-migration values so a silently-skipped or no-op migration fails loudly.
//
// Password hashing MUST match src/store/userStore.ts exactly (`scryptSync(pw, salt, 64)`, stored as
// `${saltHex}:${hashHex}`) so the seeded admin authenticates through the real /auth/login route.

import Database from 'better-sqlite3';
import { scryptSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The schema version a migrated DB must end on: the highest migration db.ts declares.
 *
 *  DERIVED, not written down. A literal here means "whatever CURRENT was when someone last edited this
 *  file", so every release that adds a migration breaks this test for a reason that has nothing to do
 *  with migrations being broken — which is exactly what happened at v0.27.79, where three new migrations
 *  left the fixture still demanding 6. The assertion is worth keeping (a skipped migration must fail
 *  loudly), so it reads the source of truth instead of duplicating it. */
function currentSchemaVersion() {
  const source = readFileSync(new URL('../../../src/store/db.ts', import.meta.url), 'utf-8');
  const versions = [...source.matchAll(/runOnce\(\s*db\s*,\s*(\d+)/g)].map((m) => Number(m[1]));
  if (versions.length === 0) {
    throw new Error('migration-e2e: found no `runOnce(db, N)` migrations in src/store/db.ts — the version probe needs updating');
  }
  return Math.max(...versions);
}

/** Mirror of hashPassword in src/store/userStore.ts — kept in lockstep so the seeded user is a real login. */
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

// The credentials the fixture's pre-existing admin was created with, long before this upgrade. The test
// proves this user still logs in after migration (data intact) and that passing DIFFERENT bootstrap
// credentials to the daemon does NOT create a second admin (setup is not re-triggered on a populated DB).
export const OLD_ADMIN = { username: 'admin', password: 'oldpass123' };

// Bootstrap creds handed to the daemon at boot. Deliberately different from OLD_ADMIN: because a user
// already exists, the daemon must skip creation, so after boot there must be NO 'freshadmin' user and a
// login with these must be rejected.
export const BOOTSTRAP = { username: 'freshadmin', password: 'freshpass456' };

// --- The fixture PLUGIN: a stand-in for a subsystem that was extracted out of the core ---------------
//
// The scenario this suite carries ("a pre-plugin database is upgraded and the vertical that used to be
// core keeps working") needs a plugin that GRANDFATHERS an existing table. The real one — `agents`, which
// adopted `missions` — now lives in the plugin registry and is not in this package, so the SUBJECT here is
// a fixture while the MECHANISM stays the daemon's: ctx.db().migrate() running at boot on a
// just-upgraded legacy database, its bookkeeping in plugin_migrations, and a root-mounted route serving
// rows the core migration was never allowed to touch.
//
// It records, inside its own migration, how many `missions` rows it could see. That number is the teeth
// of the adoption claim: a CREATE TABLE IF NOT EXISTS that ADOPTS the legacy table sees the pre-existing
// row, while a plugin that created a fresh table (or a core migration that had dropped the old one) would
// record 0 and the run goes red.
export const ADOPTER_PLUGIN = {
  name: 'e2e-legacy-adopter',
  manifest: {
    provides: { apiRoutes: ['/e2e-missions'] },
    capabilities: { reads: ['db'] },
  },
  register: `
  const db = ctx.db();
  db.migrate([{
    version: 1,
    up: (h) => {
      // The GRANDFATHERED table, in the shape the core era left it: on this upgraded database the form
      // is a no-op that adopts the existing table and its rows; on a fresh one it is what creates it.
      h.exec(\`CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, autonomy TEXT NOT NULL,
        max_sessions INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_by INTEGER,
        pilot_exec TEXT NOT NULL DEFAULT '', overseer_exec TEXT NOT NULL DEFAULT ''
      )\`);
      // The plugin's OWN namespaced table (the p_<plugin>_* convention), holding the adoption evidence.
      h.exec('CREATE TABLE IF NOT EXISTS p_e2e_legacy_adopter_adoption (id INTEGER PRIMARY KEY CHECK (id = 1), missions_seen INTEGER NOT NULL)');
      const seen = h.prepare('SELECT COUNT(*) AS n FROM missions').get().n;
      h.prepare('INSERT OR REPLACE INTO p_e2e_legacy_adopter_adoption (id, missions_seen) VALUES (1, ?)').run(seen);
    },
  }]);
  ctx.registerApiRoute({
    rootMount: '/e2e-missions', path: '', method: 'GET', access: 'user',
    handler: async () => ({ body: {
      missions: db.prepare('SELECT id, epic_id, state, autonomy FROM missions ORDER BY id').all(),
      missionsSeenAtMigration: db.prepare('SELECT missions_seen AS n FROM p_e2e_legacy_adopter_adoption WHERE id = 1').get()?.n ?? null,
    } }),
  });`,
};

/** Lay the fixture plugin down in the daemon's writable plugin dir — `<dirname(dbPath)>/plugins/<name>`,
 *  the path brainCore.ts derives from the DB location and the marketplace installs into. Written before
 *  the first boot: a folder that appears later is not discovered until something forces a rescan. */
export function writeAdopterPlugin(dataDir) {
  const dir = join(dataDir, 'plugins', ADOPTER_PLUGIN.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name: ADOPTER_PLUGIN.name, version: '1.0.0', apiVersion: '1',
    description: 'migration-e2e fixture: adopts a grandfathered core table', entry: 'index.mjs',
    ...ADOPTER_PLUGIN.manifest,
  }, null, 2));
  writeFileSync(join(dir, 'index.mjs'), `export function register(ctx){\n${ADOPTER_PLUGIN.register}\n}\n`);
}

/** Seed the marketplace's registry CACHE with the manifest of a plugin that is not installed here.
 *
 *  This reproduces the state a real upgraded host lands in: the config migration switches `agents` on,
 *  the code for it lives in the plugin registry, and the boot reconciler could not fetch it. The daemon
 *  answers such a path with an explicit 503 ("enabled but not installed") instead of a bare 404 — and it
 *  learns WHICH paths belong to the absent plugin from exactly this cache
 *  (MarketplaceService.declaredRootRoutes reads `<dbdir>/marketplace/plugins/<name>/elowen-plugin.json`).
 *  Without a cache there is no claim and the 404 stands, so the seed is what makes the 503 reachable. */
export function seedRegistryCache(dataDir, name, apiRoutes) {
  const dir = join(dataDir, 'marketplace', 'plugins', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'elowen-plugin.json'), JSON.stringify({
    name, version: '0.1.0', apiVersion: '1',
    description: `registry-cache stub for ${name}`, entry: 'index.mjs',
    provides: { apiRoutes },
  }, null, 2));
}

/**
 * Create the old-schema fixture at `dbPath`. Returns the values the migration is expected to produce, so
 * the runner asserts against a single source of truth.
 */
export function buildOldFixture(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    -- OLD users: from the snake_case-tool era. Has disabled_tools (so v1 has real work to do) but PRE-dates
    -- the is_admin / allowed_execs / name / email / advisor_* columns that addColumn adds on upgrade.
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      disabled_tools TEXT NOT NULL DEFAULT ''
    );

    -- Prompt template keys, before the advisor -> elowen rename (an always-run, non-versioned UPDATE).
    CREATE TABLE user_prompts (
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, name)
    );

    -- Per-user permission rules blob — v1 rewrites the tool-name KEYS under "tools", leaving "bash" alone.
    CREATE TABLE user_settings (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key)
    );

    -- Global settings blob — v1 rewrites tool names inside plugins.config.*.rolePolicies[].tools.
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);

    -- OLD brain_sessions: PRE work_dir / parent_session_id / delegated_access columns (addColumn adds them).
    CREATE TABLE brain_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- OLD brain_messages: PRE the pending column.
    CREATE TABLE brain_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- OLD brain_session_events: CHECK constraint WITHOUT 'cwd' — the exact shape v5 must rebuild so a 'cwd'
    -- marker can be inserted. CREATE TABLE IF NOT EXISTS in schema.sql leaves this old table untouched.
    CREATE TABLE brain_session_events (
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('model', 'mode', 'rename', 'reasoning')),
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, event_id)
    );

    -- Retired personality tables — v6 must DROP both. Their CREATE statements are gone from schema.sql.
    CREATE TABLE personality_profiles (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE personality_active_profiles (
      user_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      profile_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, platform)
    );

    -- OLD agents-subsystem tables from the pre-extraction (core) era, holding a RUNNING mission. The
    -- core migration must leave every one of them exactly as it found them — these tables belong to a
    -- vertical the daemon no longer owns, and an upgrade that "tidied" them would be data loss. The
    -- fixture ADOPTER_PLUGIN then grandfathers the missions table the way the extracted plugin does,
    -- and the auto-enable migration must switch agents on for this pre-existing install (run.mjs
    -- asserts all three).
    -- projects/tasks at their OLD shape: the columns addColumn later adds (notes/icon; description/
    -- scheduled_at/autostart/result_summary/outcome/closed_at/changed_files/*_sha/resume_note) are
    -- absent so the additive block has real work to do.
    CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, path TEXT NOT NULL, pr_enabled INTEGER);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'task', status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'P2', parent_id TEXT, labels TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_deps (
      task_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on_id),
      CHECK (task_id != depends_on_id)
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL,
      program TEXT NOT NULL, model TEXT NOT NULL, last_active_ts TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (project_id, name)
    );
    CREATE TABLE missions (
      id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, autonomy TEXT NOT NULL,
      max_sessions INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER,
      pilot_exec TEXT NOT NULL DEFAULT '', overseer_exec TEXT NOT NULL DEFAULT ''
    );
  `);

  // --- Seed rows carrying OLD names / shapes ---

  // Pre-existing admin with two snake_case tools denied.
  db.prepare('INSERT INTO users (id, username, password_hash, created_at, disabled_tools) VALUES (?, ?, ?, ?, ?)')
    .run(1, OLD_ADMIN.username, hashPassword(OLD_ADMIN.password), '2025-01-01 00:00:00', 'read_file,run_command');

  // Advisor prompt keys that the non-versioned UPDATE renames on boot.
  db.prepare('INSERT INTO user_prompts (user_id, name, content) VALUES (?, ?, ?)')
    .run(1, 'advisor', 'legacy advisor prompt body');
  db.prepare('INSERT INTO user_prompts (user_id, name, content) VALUES (?, ?, ?)')
    .run(1, 'advisor-channel', 'legacy advisor-channel prompt body');

  // Permission rules: tool KEYS get renamed by v1; the bash pattern must survive verbatim.
  const permissions = JSON.stringify({
    tools: { read_file: 'deny', run_command: 'allow', edit_file: 'ask' },
    bash: { 'git status*': 'allow' },
  });
  db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
    .run(1, 'permissions', permissions);

  // A platform role's tool allow-list inside the global settings blob (v1 rewrites tools[]). The
  // autopilot block carries pre-extraction values for the keys the agents plugin now owns: the
  // one-shot config migration must COPY them into plugins.config.agents (autopilot.* keeps its
  // values — lossless rollback), and the deliberately ABSENT plugins.enabled list is what the agents
  // auto-enable migration must fix (an upgrade with running missions must not lose the subsystem).
  const settingsData = JSON.stringify({
    plugins: {
      // One plugin this install had already switched on: the fixture adopter, which stands in for the
      // extracted vertical. It must be enabled HERE and not through the API, because the whole point is
      // that its schema migration runs at BOOT, on the database the core migration has just upgraded.
      // `agents` is deliberately absent — adding it is the auto-enable migration's job.
      enabled: [ADOPTER_PLUGIN.name],
      config: { someplatform: { rolePolicies: [{ name: 'member', tools: ['read_file', 'list_dir', '*'] }] } },
    },
    // Wave 1 keys (overseerModel + the PR lifecycle) AND wave 2 keys (pilot/overseer execs,
    // reviewOnDone, tddMode, prEnabled + the top-level ghToken) — both one-shot copies must run.
    autopilot: {
      overseerModel: 'legacy-overseer-model', prBaseBranch: 'develop', prAutoOpen: true, prVerifyCommand: 'npm run verify',
      pilotExec: 'claude:opus', overseerExec: 'claude:sonnet', reviewOnDone: true, tddMode: true, prEnabled: true,
    },
    ghToken: 'legacy-gh-token',
  });
  db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(settingsData);

  // Brain conversation + messages that must survive the upgrade untouched.
  db.prepare('INSERT INTO brain_sessions (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('sess-old-1', 1, 'Legacy chat', 'old-model', '2025-02-01 00:00:00', '2025-02-01 00:05:00');
  db.prepare('INSERT INTO brain_messages (id, session_id, parent_id, role, content) VALUES (?, ?, ?, ?, ?)')
    .run('msg-1', 'sess-old-1', null, 'user', 'hello from the past');
  db.prepare('INSERT INTO brain_messages (id, session_id, parent_id, role, content) VALUES (?, ?, ?, ?, ?)')
    .run('msg-2', 'sess-old-1', 'msg-1', 'assistant', 'a durable reply');

  // A session event on the pre-'cwd' table (must survive the v5 rebuild).
  db.prepare('INSERT INTO brain_session_events (session_id, event_id, kind, detail) VALUES (?, ?, ?, ?)')
    .run('sess-old-1', 'ev-1', 'model', 'old-model');

  // Personality rows the v6 drop discards along with their tables.
  db.prepare('INSERT INTO personality_profiles (id, user_id, body) VALUES (?, ?, ?)').run(1, 1, 'retired');
  db.prepare('INSERT INTO personality_active_profiles (user_id, platform, profile_id) VALUES (?, ?, ?)')
    .run(1, 'discord', 1);

  // A RUNNING mission from the core era: an active mission over an epic with one phase mid-flight
  // (in_progress, its agent's tmux session dead with the old daemon) and one dependent phase open.
  // After the upgrade the mission must still be active and readable through the plugin that adopts the
  // table, and the dependency must be untouched. (Re-picking the zombie phase is the extracted plugin's
  // own boot reconcile — plugin behaviour, asserted in the registry repo's agents suite, not here.)
  db.prepare('INSERT INTO projects (id, slug, path) VALUES (?, ?, ?)').run(1, 'legacy', '/tmp');
  db.prepare("INSERT INTO tasks (id, project_id, title, type, status) VALUES ('epic1', 1, 'Legacy epic', 'epic', 'in_progress')").run();
  db.prepare("INSERT INTO tasks (id, project_id, title, type, status, parent_id, labels) VALUES ('ph1', 1, 'phase one', 'task', 'in_progress', 'epic1', 'agent:Nova')").run();
  db.prepare("INSERT INTO tasks (id, project_id, title, type, status, parent_id) VALUES ('ph2', 1, 'phase two', 'task', 'open', 'epic1')").run();
  db.prepare("INSERT INTO task_deps (task_id, depends_on_id) VALUES ('ph2', 'ph1')").run();
  db.prepare("INSERT INTO agents (project_id, name, program, model) VALUES (1, 'Nova', 'claude', 'opus')").run();
  db.prepare("INSERT INTO missions (id, epic_id, autonomy, max_sessions, state, created_by) VALUES ('m-epic1', 'epic1', 'L2', 1, 'active', 1)").run();

  // The whole point: this DB has NEVER run a migration.
  db.pragma('user_version = 0');
  db.close();

  // What the migration is expected to yield — the runner asserts exactly these.
  return {
    expectedUserVersion: currentSchemaVersion(),
    expectedDisabledTools: 'Read,Bash',
    expectedPromptNames: ['elowen', 'elowen-platform'],
    expectedPermTools: { Read: 'deny', Bash: 'allow', Edit: 'ask' },
    expectedRolePolicyTools: ['Read', 'ListDir', '*'],
    droppedTables: ['personality_profiles', 'personality_active_profiles'],
  };
}
