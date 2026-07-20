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

  // A platform role's tool allow-list inside the global settings blob (v1 rewrites tools[]).
  const settingsData = JSON.stringify({
    plugins: { config: { someplatform: { rolePolicies: [{ name: 'member', tools: ['read_file', 'list_dir', '*'] }] } } },
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

  // The whole point: this DB has NEVER run a migration.
  db.pragma('user_version = 0');
  db.close();

  // What the migration is expected to yield — the runner asserts exactly these.
  return {
    expectedUserVersion: 6,
    expectedDisabledTools: 'Read,Bash',
    expectedPromptNames: ['elowen', 'elowen-platform'],
    expectedPermTools: { Read: 'deny', Bash: 'allow', Edit: 'ask' },
    expectedRolePolicyTools: ['Read', 'ListDir', '*'],
    droppedTables: ['personality_profiles', 'personality_active_profiles'],
  };
}
