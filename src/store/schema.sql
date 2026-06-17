CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task', status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'P2', parent_id TEXT, labels TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_deps (task_id TEXT NOT NULL, depends_on_id TEXT NOT NULL, PRIMARY KEY (task_id, depends_on_id));
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL,
  program TEXT NOT NULL, model TEXT NOT NULL, last_active_ts TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, autonomy TEXT NOT NULL,
  max_sessions INTEGER NOT NULL DEFAULT 1, cleared_guardrails TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
