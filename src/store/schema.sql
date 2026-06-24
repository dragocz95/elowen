CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, path TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task', status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'P2', parent_id TEXT, labels TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', scheduled_at TEXT,
  autostart INTEGER NOT NULL DEFAULT 0,
  result_summary TEXT, outcome TEXT, closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT NOT NULL, depends_on_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id != depends_on_id)
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL,
  program TEXT NOT NULL, model TEXT NOT NULL, last_active_ts TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, autonomy TEXT NOT NULL,
  max_sessions INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL DEFAULT (datetime('now'))
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
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  project_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_missions_epic ON missions(epic_id);
CREATE INDEX IF NOT EXISTS idx_missions_state ON missions(state);
