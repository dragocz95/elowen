CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, path TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '', pr_enabled INTEGER);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task', status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'P2', parent_id TEXT, labels TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', scheduled_at TEXT,
  autostart INTEGER NOT NULL DEFAULT 0,
  result_summary TEXT, outcome TEXT, closed_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id != depends_on_id)
);
-- Persisted per-task token/cost usage, snapshotted once when a task settles (closed/cancelled) so the
-- stats page reads aggregates straight from the DB instead of re-scanning the CLIs' session stores.
CREATE TABLE IF NOT EXISTS task_usage (
  task_id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  exec TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_usage_project ON task_usage(project_id);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL,
  program TEXT NOT NULL, model TEXT NOT NULL, last_active_ts TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, autonomy TEXT NOT NULL,
  max_sessions INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER
);
CREATE TABLE IF NOT EXISTS mission_pr (
  mission_id TEXT PRIMARY KEY, branch TEXT NOT NULL, worktree TEXT NOT NULL,
  pr_number INTEGER, pr_url TEXT, pr_state TEXT, last_review_ts TEXT,
  fix_rounds INTEGER NOT NULL DEFAULT 0, last_feedback TEXT
);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  allowed_execs TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  default_exec TEXT NOT NULL DEFAULT '',
  advisor_exec TEXT NOT NULL DEFAULT '',
  advisor_autostart INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'full',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_projects (
  user_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
CREATE TABLE IF NOT EXISTS user_push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON user_push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS user_prompts (
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, name)
);

-- Per-user key/value settings (e.g. the CLI/brain model override, auto-compact toggle). Absence of a
-- key means "use the default", so a fresh user inherits the shipped behaviour.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  project_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts DESC);
-- Inter-agent handoff notes: free-form context an agent leaves for later agents working the same
-- scope (a mission/epic by default). Generic (scope, target) shape mirrors events; no FK so a note
-- can outlive a deleted epic and a project-scoped target stays valid.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  target TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_scope_target ON notes(scope, target, id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_missions_epic ON missions(epic_id);
CREATE INDEX IF NOT EXISTS idx_missions_state ON missions(state);
-- Embedded brain (advisor engine): per-user conversations. SQLite is the sole authoritative store —
-- the PI agent session runs in-memory (SessionManager.inMemory) and every settled turn is projected
-- here; on start the history is rehydrated back into a fresh in-memory session. No JSONL on disk.
CREATE TABLE IF NOT EXISTS brain_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_brain_sessions_user ON brain_sessions(user_id);
CREATE TABLE IF NOT EXISTS brain_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_brain_messages_session ON brain_messages(session_id);

-- Per-user, per-platform personality profiles: named prompt bodies that shape how Orca behaves on a
-- given surface ('web'/'discord'/'cli', future keys allowed). A user may keep several named profiles
-- per platform; the single active one per platform is pinned in personality_active_profiles. user_id
-- is INTEGER (joins users.id) — the spec's TEXT predates Orca's integer user ids.
CREATE TABLE IF NOT EXISTS personality_profiles (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, platform, name)
);
CREATE INDEX IF NOT EXISTS idx_personality_profiles_user_platform ON personality_profiles(user_id, platform);
CREATE TABLE IF NOT EXISTS personality_active_profiles (
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  profile_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, platform)
);

-- Orca RAW memory (v1: user-scoped only). Durable facts/preferences/instructions/corrections about a
-- user. Vectors live inline as packed Float32 BLOBs in memory_embeddings (no external vector DB).
-- Deletes are SOFT (status='deleted') so the UI can restore; every mutation is audited in memory_events.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  importance INTEGER NOT NULL DEFAULT 3,
  confidence REAL NOT NULL DEFAULT 0.8,
  source TEXT NOT NULL DEFAULT 'agent',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_user_status ON memories(user_id, status);
-- One embedding per memory. content_hash pins which body text was embedded, so a body edit can mark the
-- vector stale and enqueue a re-embed. ON DELETE CASCADE cleans vectors if a memory is ever hard-deleted.
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
-- Append-only audit of every memory mutation (add/update/merge/delete/restore). before/after are JSON
-- snapshots; actor is 'agent'|'user:<id>'|'admin:<id>'. memory_id is nullable so a purge still audits.
CREATE TABLE IF NOT EXISTS memory_events (
  id INTEGER PRIMARY KEY,
  memory_id INTEGER,
  user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_events_memory ON memory_events(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_events_user ON memory_events(user_id, id DESC);
