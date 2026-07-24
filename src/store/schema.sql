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
  reasoning INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  currency TEXT,
  -- 'provider_reported' | 'calculated' | 'unavailable'; NULL on legacy rows (read as unknown).
  cost_source TEXT,
  -- Small non-sensitive provider usage blob (tokens + cost only) for debugging a reported figure.
  raw_usage_metadata TEXT,
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
  created_by INTEGER,
  pilot_exec TEXT NOT NULL DEFAULT '', overseer_exec TEXT NOT NULL DEFAULT ''
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
  disabled_tools TEXT NOT NULL DEFAULT '',
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
-- A linked Discord snowflake is an identity key: at most ONE Elowen user may claim a given id, else a
-- squatter could point the victim's Discord identity (and its memory namespace / admin routing) at their
-- own account. This partial UNIQUE index enforces one-owner-per-id atomically — only the discordUserId
-- rows are constrained, so every other generic key/value pair stays unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_discord_id ON user_settings(value) WHERE key = 'discordUserId';
-- Same one-owner-per-id rule for a linked WhatsApp number (digits only).
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_whatsapp_number ON user_settings(value) WHERE key = 'whatsappNumber';
-- Same one-owner-per-id rule for a linked Telegram numeric user id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_telegram_id ON user_settings(value) WHERE key = 'telegramUserId';
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
  -- The client-reported working directory the conversation belongs to (validated realpath; empty =
  -- cwd-less, e.g. web-dock sessions). Drives the CLI's default-start resolution: a CLI launched in a
  -- directory resumes the most recent unattached conversation with a matching work_dir.
  work_dir TEXT NOT NULL DEFAULT '',
  -- Delegated agents run as ordinary isolated brain sessions, but retain their durable parent so the
  -- parent conversation can include the whole nested session tree in its own usage/cost status. NULL
  -- is a top-level conversation. The index is created in db.ts after the additive migration so an old
  -- brain_sessions table can be upgraded before SQLite tries to index the new column.
  parent_session_id TEXT,
  -- Immutable, validated execution boundary for a delegated child. NULL is a legacy/non-delegated row;
  -- an idle child without this value must fail closed instead of resuming under its account owner's scope.
  delegated_access TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_brain_sessions_user ON brain_sessions(user_id);
-- `pending` marks a row written MID-TURN, straight off PI's `message_end`, before the turn settled.
-- Without those rows a daemon restart in the middle of a long turn threw away every tool call and every
-- word the agent had produced: the settled `agent_end` was the only thing that ever reached SQLite. They
-- are provisional — the authoritative `agent_end` write discards them and re-persists the run in PI's
-- real execution order (a mid-turn steer can reorder it). They only become history when a session is
-- respawned while some are still pending, which means the turn that wrote them never finished.
CREATE TABLE IF NOT EXISTS brain_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  pending INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_brain_messages_session ON brain_messages(session_id);
-- Latest durable UI state for each delegated tool call. The parent assistant message remains the
-- canonical transcript row; this sidecar supplies the child session id + rolling status that PI's
-- message format does not carry. No foreign keys here: brain sessions are re-keyed during channel
-- rollover, so BrainStore updates/deletes these rows in the same lifecycle transactions instead.
CREATE TABLE IF NOT EXISTS brain_subagent_runs (
  parent_session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (parent_session_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS idx_brain_subagent_runs_child ON brain_subagent_runs(child_session_id);
-- Latest durable UI state for each `WorkflowStart` tool call, holding the WHOLE DAG the in-plugin
-- engine otherwise keeps only in memory. Without it a finished workflow is unrecoverable: the live
-- projection is rebuilt from the transcript on every hydration, so a reconnect (or merely closing a
-- sub-agent view) would drop it and its modal could never be reopened.
--
-- Unlike brain_subagent_runs there is no single child to key on -- one blocking call fans out to N node
-- sessions -- so the node session ids live inside `state` and are NOT trusted on read: getWorkflowRuns
-- re-derives each node's drill-in target from the live parent/child relation. That check is strictly
-- stronger than rewriting ids on rollover, which is why the DAG can stay one JSON blob (and why one
-- snapshot costs one write, not up to 64). Same no-foreign-keys rule as the tables above.
CREATE TABLE IF NOT EXISTS brain_workflows (
  parent_session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (parent_session_id, tool_call_id)
);
-- Display panels a plugin pushed via ctx.emitCard (the todo checklist is the canonical one). They are
-- conversation state, not turn state: closing the chat disposes the live session, so a memory-only panel
-- would take the user's todo list with it. Persisting them lets a reopened conversation show its
-- checklist again, exactly as the transcript above it survives. Row order (rowid) is insertion order, so
-- the panel comes back in the order the cards were first emitted. Same no-foreign-keys rule as above.
CREATE TABLE IF NOT EXISTS brain_cards (
  session_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, card_id)
);
-- Visible, display-only markers of owner-driven session-state changes (model switch, work-mode switch,
-- rename, reasoning change). Rendered as a subtle system line INTERLEAVED into the transcript by time,
-- and replayed on reconnect — but deliberately NOT part of brain_messages, so they never enter the
-- model's context (rehydrate) or perturb compaction alignment. Row order (rowid) mirrors event order;
-- same no-foreign-keys / rekey-in-rollover rule as the tables above.
CREATE TABLE IF NOT EXISTS brain_session_events (
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('model', 'mode', 'rename', 'reasoning', 'cwd')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_brain_session_events_session ON brain_session_events(session_id);
-- Durable completion inbox for detached/background sub-agents. A result is persisted before the
-- parent is woken and remains pending until that triggered parent turn settles successfully.
CREATE TABLE IF NOT EXISTS brain_subagent_results (
  result_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done', 'error')),
  task TEXT NOT NULL,
  payload TEXT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'acknowledged')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (parent_session_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS idx_brain_subagent_results_pending
  ON brain_subagent_results(delivery_state, parent_session_id, created_at);
-- Mid-turn messages are STEERED into the running turn via PI's native session queue (no daemon-side
-- persistence): a message sent while a turn streams lands between steps, so there is no durable queue table.
CREATE TABLE IF NOT EXISTS brain_goals (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  goal TEXT NOT NULL,
  draft TEXT NOT NULL DEFAULT '',
  subgoals TEXT NOT NULL DEFAULT '[]',
  turns_used INTEGER NOT NULL DEFAULT 0,
  turn_budget INTEGER NOT NULL DEFAULT 8,
  last_verdict TEXT NOT NULL DEFAULT '',
  last_evidence TEXT NOT NULL DEFAULT '',
  paused_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_brain_goals_user ON brain_goals(user_id, status);

-- Durable binding for an admin's interactive `elowen chat` terminal (BrainTerminalService): the tmux
-- session name → the brain conversation it resumes + the per-terminal auth token minted for it. The token
-- is stored verbatim (not hashed) because the tmux session survives a daemon restart and teardown must be
-- able to revoke the exact live token; this table is private, out of every wire/log path. One terminal per
-- (admin, conversation) via the UNIQUE constraint; the tmux name is the stable handle the DELETE/stream
-- routes key on.
CREATE TABLE IF NOT EXISTS brain_terminals (
  terminal_name    TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL,
  brain_session_id TEXT NOT NULL,
  token            TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, brain_session_id)
);

-- Elowen RAW memory (v1: user-scoped only). Durable facts/preferences/instructions/corrections about a
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
  use_count INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER
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
  -- Which model performed the mutation (curator add/update, categorizer categorize). NULL for
  -- human/API-driven events and any mutation not backed by an inference model.
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_events_memory ON memory_events(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_events_user ON memory_events(user_id, id DESC);

-- Per-user memory categories (v1: user-scoped). name is the label; description is the LLM-facing guide
-- text the categorizer classifies against; color is an optional UI hint; is_builtin marks seeded ones.
-- Referenced by memories.category_id (soft, id-addressed — see below). UNIQUE(user_id,name) makes a
-- name the natural key per user; the classifier still binds by id so a rename never re-tags memories.
CREATE TABLE IF NOT EXISTS memory_categories (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  -- A lucide icon name from the server-side ICON_ALLOWLIST (see memoryCategoryStore). Empty = the UI
  -- fallback glyph ('Folder'); the store always writes a clamped allowlist value on create/update.
  icon TEXT NOT NULL DEFAULT '',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_memory_categories_user ON memory_categories(user_id);
