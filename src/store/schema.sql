CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, path TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
-- `id` is AUTOINCREMENT, not a bare rowid: durable account-owned rows reference it, and a plain rowid
-- is reused after the highest-numbered user is deleted. AUTOINCREMENT keeps the counter monotonic in
-- sqlite_sequence so an id is never handed out twice. See db.ts v7.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  allowed_execs TEXT NOT NULL DEFAULT '',
  disabled_tools TEXT NOT NULL DEFAULT '',
  -- Per-user plugin GRANTS (CSV of plugin names). The semantics are the INVERSE of `allowed_execs`:
  -- empty there means "no personal restriction", empty here means "granted nothing". The list only
  -- matters for a plugin whose manifest opts in with `userGrantable`; every other plugin stays
  -- reachable by everyone exactly as before. See shared/pluginAccess.ts.
  granted_plugins TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  default_exec TEXT NOT NULL DEFAULT '',
  advisor_exec TEXT NOT NULL DEFAULT '',
  advisor_autostart INTEGER NOT NULL DEFAULT 1
);
-- Immutable identities proven by an external identity provider. The composite primary key prevents one
-- provider identity from ever resolving to two local accounts; the unique user key also prevents a local
-- account from silently changing who it represents in the same provider tenant.
CREATE TABLE IF NOT EXISTS user_external_identities (
  provider TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, tenant_id, subject_id),
  UNIQUE (provider, tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_external_identities_user ON user_external_identities(user_id);
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
-- One revision per logical personal-settings resource. The resource snapshot is assembled from one or more
-- user_settings keys, so a whole-form PATCH can reject a stale tab without coupling unrelated resources.
CREATE TABLE IF NOT EXISTS user_setting_revisions (
  user_id INTEGER NOT NULL,
  resource TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, resource)
);
-- Per-user, per-plugin non-secret settings. Stored as one JSON blob per (user, plugin), so a write is
-- atomic against the whole form and a plugin's schema can change without a migration. Legacy secret
-- fields are not moved automatically; new integrations use the encrypted plugin_secrets vault below.
CREATE TABLE IF NOT EXISTS user_plugin_config (
  user_id INTEGER NOT NULL,
  plugin TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, plugin)
);

-- Core-owned encrypted plugin secrets. Ciphertext is bound by AES-GCM AAD to every ownership key, so a
-- row copied to another scope/account/plugin/key fails authentication. Instance rows alone have NULL
-- owner_id; the expression index makes that nullable tuple unique.
CREATE TABLE IF NOT EXISTS plugin_secrets (
  scope TEXT NOT NULL CHECK (scope IN ('instance', 'user')),
  owner_id INTEGER,
  plugin TEXT NOT NULL,
  key TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  format_version INTEGER NOT NULL,
  cas_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((scope = 'instance' AND owner_id IS NULL) OR (scope = 'user' AND owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_secrets_owner
  ON plugin_secrets(scope, ifnull(owner_id, 0), plugin, key);
CREATE INDEX IF NOT EXISTS idx_plugin_secrets_user ON plugin_secrets(owner_id) WHERE scope = 'user';
CREATE TABLE IF NOT EXISTS plugin_secret_vault_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  format_version INTEGER NOT NULL,
  key_fingerprint TEXT NOT NULL,
  canary_ciphertext BLOB NOT NULL,
  canary_nonce BLOB NOT NULL,
  canary_auth_tag BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
-- Same one-owner-per-id rule for a linked Microsoft Teams identity (Entra object id or `29:…` Teams id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_msteams_id ON user_settings(value) WHERE key = 'msteamsUserId';
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  project_id INTEGER,
  label TEXT NOT NULL DEFAULT '',
  -- WHO did it and FROM WHERE. Only the id is stored: the display name is resolved by JOIN at read
  -- time, so renaming an account renames it throughout the history instead of leaving stale copies.
  actor_user_id INTEGER,
  surface TEXT NOT NULL DEFAULT '',
  -- A repetitive event is folded into ONE row per actor/surface/type/project per time bucket:
  -- `count` and `last_ts` move, `ts` stays the first occurrence. A feed nobody can read is worse
  -- than no feed, and forty identical rows are unreadable.
  count INTEGER NOT NULL DEFAULT 1,
  last_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(target);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts DESC);
-- NOTE: the index over actor_user_id/last_ts is NOT here. schema.sql is re-applied on every boot and
-- runs BEFORE the additive column migrations, so on a database created before those columns existed the
-- CREATE INDEX would fail and take the whole migration — and the daemon's boot — with it. It is created
-- in db.ts immediately after the columns are added.
-- Embedded brain (advisor engine): per-user conversations. SQLite is the sole authoritative store —
-- the PI agent session runs in-memory (SessionManager.inMemory) and every settled turn is projected
-- here; on start the history is rehydrated back into a fresh in-memory session. No JSONL on disk.
CREATE TABLE IF NOT EXISTS brain_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  -- The CONFIG provider entry id the conversation last ran on (BrainProviderEntry.id, not the registry
  -- provider name). Stored beside `model` because a model id alone is ambiguous: two configured entries
  -- can expose the same id, and resolveBrainModelRoute falls back to providers[0] when no provider is
  -- given — so a respawn restoring only the model could reach a different provider than the one the
  -- conversation was actually running on. Empty on rows written before this column existed.
  provider TEXT NOT NULL DEFAULT '',
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
  -- Provenance of a forked conversation: the session whose history was copied into this one. Kept apart
  -- from `parent_session_id` on purpose — a fork is a PEER, not a delegated child, and that column is
  -- read as "delegated child" by the usage roll-up, the retention janitor, the sub-agent listing and the
  -- eviction guard for parents with running children. Recorded as provenance only: never joined on (so
  -- no index) and never dereferenced, because deleting the source leaves this pointing at a gone row.
  forked_from_session_id TEXT,
  -- IMMUTABLE spill namespace: the fs-safe directory segment this conversation's cleared tool results
  -- live under (<dataDir>/tool-results/<spill_ns>). Minted once at creation and NEVER rewritten — the
  -- session id is re-keyed by channel rollover and /context binds, but the placeholders already sent to
  -- the provider embed spill paths, and moving the directory (or rewriting the stored paths) would
  -- rewrite an already-cached prefix and strand files under a slot id the next conversation inherits.
  -- Empty on rows minted by older builds; db.ts backfills those to their then-current id, freezing the
  -- layout the files already sit in. Read through BrainStore.spillNamespace ('' falls back to the id).
  spill_ns TEXT NOT NULL DEFAULT '',
  -- When the /clear command last emptied this conversation (NULL = never). It is the ONLY durable record
  -- that a conversation with no messages HAS been used: "was this ever spoken in?" is derived everywhere
  -- else from the existence of a brain_messages row, and clearing destroys exactly that evidence. Without
  -- it a cleared conversation reads as a never-used empty shell — the pickers hide it, dropIfUnspoken and
  -- pruneEmptyConversations delete the very row the clear had to preserve, and the next cold respawn drops
  -- the conversation's model pin.
  cleared_at TEXT,
  -- 1 = this platform conversation is a DIRECT 1:1 chat between the bot and one verified account, not a
  -- shared room. Both shapes carry a `brain-ch-*` id, so the id alone cannot tell them apart, and the
  -- blanket "channel = nobody's own conversation" rule made a private DM behave like a group: personal
  -- skills disappeared and a scheduled job could not report back into it. Only the adapter knows which it
  -- is, so it says so per message and the flag is stamped here. Fail-closed: 0 on every legacy row and on
  -- anything the adapter did not explicitly mark, which keeps shared rooms behaving exactly as before.
  direct INTEGER NOT NULL DEFAULT 0,
  -- The account that last WROTE here, which on a shared room is a different question from `user_id`.
  -- A room is anchored on the instance operator because it has no single author, so the owner column
  -- alone reported a colleague's Teams room as the operator's own conversation. Written at message time
  -- rather than derived on read: answering it from brain_messages would mean scanning the largest table
  -- with a per-row json_extract for every row of a listing. NULL where nobody identifiable has written
  -- yet (an unlinked sender, or a row that predates this column).
  last_writer_user_id INTEGER,
  -- Shutdown park marker: when the step-boundary drain parked this conversation's live turn (see
  -- stepDrain.ts). A parked turn's durable pending tail is fully answered, so the boot recovery providers
  -- (`owner-conversations` for owner rows, `platform-conversations` for platform channel rows — the two
  -- partition the markers between them) can continue the turn from exactly there and deliver
  -- the answer the restart interrupted. NULL = nothing parked. Written synchronously at the park (before
  -- the process exits) and cleared by: a successful boot resume, the sweep failing closed, an explicit
  -- user abort, or the user's own next message (their message IS the continuation then).
  parked_at TEXT,
  -- How many boot resumes have been attempted on the current park. Bumped durably BEFORE each attempt so
  -- a boot that dies mid-resume still counts it; past the cap the sweep gives up visibly instead of
  -- stacking resume turns forever. Reset whenever the marker clears.
  park_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_brain_sessions_user ON brain_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_brain_sessions_debug_updated ON brain_sessions(updated_at DESC, id DESC);

-- Durable resume envelope for the platform channel turn currently in flight (channels.ts,
-- PlatformTurnResumeEnvelope). Written when an ordinary platform turn starts and DELETED when it
-- settles, so a surviving row means exactly one thing: the process died (or will one day park) with
-- this turn unfinished. Its own table rather than a brain_sessions column on purpose: the lifecycle
-- is per-TURN (replaced each turn, gone on settle) while the session row is per-conversation,
-- `getSession` is a hot `SELECT *` that must not drag a verbatim multi-KB prompt blob into every
-- read, and "no row" is an honest absent state that no session-write path can accidentally clobber.
-- The envelope carries prompt INPUTS verbatim (byte-stability) and the ACCOUNT identity only —
-- authority is re-derived from that account at read time (resolvePlatformTurnAuthority), never
-- replayed from this row, so a stored permission set can never widen behind the operator's back.
CREATE TABLE IF NOT EXISTS brain_platform_turn_envelopes (
  session_id  TEXT PRIMARY KEY,
  envelope    TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The SECOND durable state of a boot-resumed platform turn: the answer is computed but has not reached
-- the room yet. An envelope row above means "this turn still needs a model turn"; a row HERE means "the
-- answer already exists and only has to be posted". The two are mutually exclusive by construction —
-- promotePlatformTurnToDelivery swaps one for the other inside a single transaction — and that is what
-- makes a delivery retry structurally unable to spend a second model turn: the prompt inputs it would
-- need are gone the instant the reply becomes durable.
--
-- Deliberately self-contained rather than a column on brain_sessions or on the envelope row: it is its
-- OWN boot worklist entry (claimParkedPlatformTurns unions it in), so no other path that clears the park
-- marker — turn admission when the room speaks next, an abort, a session teardown — can strand a
-- computed answer where the resume would read it as "nothing to do". It carries everything a post needs
-- (the exact text and the encoded destination) plus the sender→account claim, which is RE-PROVEN before
-- the retry posts, so a re-delivery is never a back door around the authority check.
--
-- Cleared only by a confirmed post or by the attempt cap giving up visibly. `attempts` is bumped durably
-- BEFORE each post, so a boot that dies mid-post still counts it: the retry is at-least-once and BOUNDED
-- (a duplicate in a chat is self-explaining; silence is not).
CREATE TABLE IF NOT EXISTS brain_platform_turn_deliveries (
  session_id       TEXT PRIMARY KEY,
  reply            TEXT NOT NULL,
  target           TEXT NOT NULL,
  platform         TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  account_user_id  INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- `pending` marks a row written MID-TURN, straight off PI's `message_end`, before the turn settled.
-- Without those rows a daemon restart in the middle of a long turn threw away every tool call and every
-- word the agent had produced: the settled `agent_end` was the only thing that ever reached SQLite. They
-- are provisional — the authoritative `agent_end` write discards them and re-persists the run in PI's
-- real execution order (a mid-turn steer can reorder it). They only become history when a session is
-- respawned while some are still pending, which means the turn that wrote them never finished.
CREATE TABLE IF NOT EXISTS brain_usage_reset_state (
  user_id INTEGER PRIMARY KEY,
  usage_epoch INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS brain_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  pending INTEGER NOT NULL DEFAULT 0,
  -- Usage belongs to the owner's current epoch at persistence time. Reset advances the tiny per-user
  -- state row instead of rewriting historical transcript JSON.
  usage_epoch INTEGER NOT NULL DEFAULT 0,
  -- Whole visible agent run, stamped only on the run's last assistant row. Kept outside `content` so
  -- display metadata can never change the message bytes replayed to a provider (prompt-cache invariant).
  turn_duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_brain_messages_session ON brain_messages(session_id);

-- Exact provider request capture for the conversation debugger. Requests are attempts, not turns: a retry,
-- a compaction summary call, and every tool-loop model step each get their own monotonically ordered row.
-- Payload content is split into session-scoped content-addressed segments below, so repeated prompt prefixes
-- and dynamic tool schemas are stored once without creating a second brain_messages archive.
CREATE TABLE IF NOT EXISTS brain_provider_requests (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  retry_of TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'compaction', 'remote_compaction')),
  configured_provider TEXT NOT NULL DEFAULT '',
  wire_provider TEXT NOT NULL DEFAULT '',
  api TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  response_at INTEGER,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'error', 'interrupted')),
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  canonicalization_version INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  response_segment TEXT,
  assistant_message_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  -- Assigned only when the attempt reaches a terminal state, from the session owner's then-current epoch.
  usage_epoch INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_brain_provider_requests_session_seq ON brain_provider_requests(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_brain_provider_requests_session_status ON brain_provider_requests(session_id, status, seq);

CREATE TABLE IF NOT EXISTS brain_request_segments (
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  canonicalization_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  PRIMARY KEY (session_id, kind, digest, canonicalization_version)
);

CREATE TABLE IF NOT EXISTS brain_request_session_summary (
  session_id TEXT PRIMARY KEY,
  capture_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  first_request_at INTEGER,
  last_request_at INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  costed_request_count INTEGER NOT NULL DEFAULT 0
);

-- The persisted egress latch of tool-result clearing (brain/session/toolResultClearing.ts). A row means
-- "this session already replaced one tool-result OCCURRENCE with a spill placeholder on the wire", and
-- holds that placeholder VERBATIM (`placeholder`) so a respawn re-sends the exact bytes the provider
-- already cached — never a re-render, which a wording change would silently drift. `mode`/`bytes`/
-- `preview`/`path` remain as the placeholder's ingredients for observability and for legacy rows
-- (placeholder NULL) written before the column existed. Restoring from here instead of comparing the
-- live message text against the spill file is what keeps a restart free even when rehydration changed
-- that text (an externalized tool image comes back as a placeholder text block — persistence.ts
-- `withoutExternalizedImages`).
--
-- `occurred_at` is the tool-result MESSAGE's own timestamp (epoch ms) and is part of the key on
-- purpose: tool_call_id alone is not an identity — sequential id styles (`call_0`) reset every turn, so
-- once a compaction removes the cleared occurrence the same id can return on a brand-new result, and a
-- row keyed by id alone would swallow it (the model would get a placeholder pointing at another call's
-- spill instead of its own output). 0 marks a legacy row from before this column; toolResultClearing
-- restores those through a created_at heuristic and prunes/graduates them. The spill FILES keep the
-- full output for the model to Read; this table carries only placeholder state. No foreign keys, same
-- lifecycle policy as brain_subagent_runs: sessions are re-keyed during channel rollover, so BrainStore
-- moves/deletes these rows itself (`path` moves with the row VERBATIM — the spill dir is keyed by the
-- immutable spill_ns, so the files never move and the path stays true).
CREATE TABLE IF NOT EXISTS brain_tool_result_spills (
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
-- Latest durable UI state for each delegated tool call. The parent assistant message remains the
-- canonical transcript row; this sidecar supplies the child session id + rolling status that PI's
-- message format does not carry. No foreign keys here: brain sessions are re-keyed during channel
-- rollover, so BrainStore updates/deletes these rows in the same lifecycle transactions instead.
CREATE TABLE IF NOT EXISTS brain_subagent_runs (
  parent_session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  -- Host-owned recovery lifecycle (Phase 2 — see the matching addColumn block in db.ts for full
  -- semantics). NULL on rows written before these columns existed; the data migration backfills them.
  -- job_id mirrors the `dlg-` job so a handle still resolves after a restart clears the in-memory map.
  -- lifecycle (running|recovering|recovery_required|done|error|legacy_interrupted) drives boot recovery.
  -- attempt bounds respawn retries. owner_boot_id + lease_until are the compare-and-swap claim that stops
  -- two booting daemons recovering the same run.
  job_id TEXT,
  lifecycle TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  owner_boot_id TEXT,
  lease_until INTEGER,
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
  -- Which process wrote the last running snapshot (mirrors brain_subagent_runs.owner_boot_id): a
  -- `running` row owned by a DEAD boot is a restart orphan the boot reconcile may claim for resume.
  -- attempt bounds resume retries so a workflow that keeps crashing its own recovery caps out.
  owner_boot_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
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
  kind TEXT NOT NULL CHECK (kind IN ('model', 'mode', 'rename', 'reasoning', 'cwd', 'subagent', 'workflow')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_brain_session_events_session ON brain_session_events(session_id);
-- Durable completion inbox for detached/background delegated work. A result is persisted before the
-- parent is woken and remains pending until that triggered parent turn settles successfully.
--
-- `kind` discriminates the two producers that share this one queue (so retry/backoff, the delivery
-- drain, acknowledgement and the restart reconcile stay in ONE place): a 'subagent' row links to a
-- brain_subagent_runs row via child_session_id, while a 'workflow' row links to a brain_workflows row
-- via workflow_id and leaves child_session_id empty (a workflow fans out to N node sessions, so there
-- is no single child to key on).
CREATE TABLE IF NOT EXISTS brain_subagent_results (
  result_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'subagent',
  workflow_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('done', 'error')),
  task TEXT NOT NULL,
  payload TEXT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'acknowledged')),
  attempts INTEGER NOT NULL DEFAULT 0,
  wake_attempts INTEGER NOT NULL DEFAULT 0,
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

-- Ingress ledger: which request origins spoke into which conversation. Its job is to survive a daemon
-- restart — the in-memory sessionId → origin map is rebuilt from here — and to answer "which address
-- talked into this session" for the admin drill-down. One row per (session, distinct origin), so it grows
-- with conversations and networks, never with messages. `trusted` records whether the origin was a
-- proxy-verified fact at the time (see src/api/clientIp.ts); it is stored, never used to hide a row.
CREATE TABLE IF NOT EXISTS brain_session_origins (
  session_id TEXT NOT NULL,
  origin     TEXT NOT NULL,   -- '203.0.113.7' | 'local' | 'internal' | 'platform:discord'
  user_id    INTEGER NOT NULL,
  trusted    INTEGER NOT NULL DEFAULT 0,
  requests   INTEGER NOT NULL DEFAULT 0,
  first_at   INTEGER NOT NULL,
  last_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, origin)
);
CREATE INDEX IF NOT EXISTS idx_session_origins_last ON brain_session_origins(last_at);

-- Rollup of settled-turn spend per day × user × origin, and the ONLY source the admin origin view reads.
-- It exists because the question "who burned the tokens, and from where" cannot be answered from
-- brain_messages without scanning the largest table in the database with json_extract on every row — the
-- /usage/by-* views already pay that (~1.2 s cold) and this view must not add a second one. Written once
-- per settled turn (one UPSERT), read as a scan over a table whose row count is days × users × addresses.
--
-- It is a SEPARATE counter from /usage/by-day and /usage/by-model, which derive their numbers from the
-- messages themselves. The two answer different questions and are NOT guaranteed to agree: this table
-- starts at deployment (older spend has no origin and never will), a hand-edited message row changes one
-- side only, and only /usage/reset clears both. Callers must never present one as a check on the other.
CREATE TABLE IF NOT EXISTS usage_by_origin (
  day          TEXT NOT NULL,     -- 'YYYY-MM-DD' UTC, the same day basis as usageByDay
  user_id      INTEGER NOT NULL,
  origin       TEXT NOT NULL,
  origin_kind  TEXT NOT NULL CHECK (origin_kind IN ('ip','local','internal','platform','redacted')),
  -- 0 as soon as ANY turn in the bucket came from an unverifiable claim: a bucket is only as trustworthy
  -- as its weakest contribution.
  trusted      INTEGER NOT NULL DEFAULT 0,
  turns        INTEGER NOT NULL DEFAULT 0,
  input        INTEGER NOT NULL DEFAULT 0,
  output       INTEGER NOT NULL DEFAULT 0,
  cache_read   INTEGER NOT NULL DEFAULT 0,
  cache_write  INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  -- NULL stays NULL: a bucket whose turns reported no cost is "unknown", never a real $0.
  cost         REAL,
  costed_turns INTEGER NOT NULL DEFAULT 0,
  first_at     INTEGER NOT NULL,
  last_at      INTEGER NOT NULL,
  PRIMARY KEY (day, user_id, origin)
);
CREATE INDEX IF NOT EXISTS idx_usage_by_origin_day ON usage_by_origin(day);

-- Per-user daily dashboard digest: the agent-written hero greeting, quick-action pills, yesterday
-- summary and next-work suggestions, generated once per (user, UTC day) by ONE cheap background
-- inference (a direct relay call — no brain session is ever created for it) and served from here on
-- every dashboard visit. `payload` is one validated JSON document ({greeting, pills, summary,
-- suggestions}) rather than a column per field: the fields are written and read together as a unit.
-- `status` doubles as the lazy-generation latch — the 'generating' row IS the cross-request mutex
-- (see DashDigestStore.beginGeneration).
CREATE TABLE IF NOT EXISTS dash_digests (
  user_id    INTEGER NOT NULL,
  day        TEXT NOT NULL,              -- 'YYYY-MM-DD' UTC, same day basis as usage_by_origin
  status     TEXT NOT NULL CHECK (status IN ('generating','ready','failed')),
  payload    TEXT NOT NULL DEFAULT '{}',
  attempts   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,           -- unix ms; drives the retry/stale-generation rules
  PRIMARY KEY (user_id, day)
);

-- Durable binding for an admin's interactive `elowen chat` terminal (BrainTerminalService): the tmux
-- session name → the brain conversation it resumes + the per-terminal auth token minted for it. The token
-- is stored verbatim (not hashed) because the tmux session survives a daemon restart and teardown must be
-- able to revoke the exact live token; this table is private, out of every wire/log path. One terminal per
-- (admin, conversation) via the UNIQUE constraint; the tmux name is the stable handle the DELETE/stream

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

-- One row per RECALL: the memory was actually handed to the model. `memories` only keeps the running
-- totals (use_count, last_used_at), which cannot answer "when was this used" — this log can, and
-- replaying it reproduces both totals exactly, which is what lets the vitality curve be reconstructed
-- rather than guessed. Deliberately NOT an audit table: rows are pruned by age (USAGE_HISTORY_DAYS) and
-- are deleted outright when the memory is hard-purged, so a reused rowid can never inherit the previous
-- occupant's history the way memory_events has to defend against.
CREATE TABLE IF NOT EXISTS memory_usage_events (
  id INTEGER PRIMARY KEY,
  memory_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  used_at TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT,
  turn_id TEXT,
  search_index INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_usage_events_memory ON memory_usage_events(memory_id, used_at);
CREATE INDEX IF NOT EXISTS idx_memory_usage_events_used_at ON memory_usage_events(used_at);

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
  project_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_memory_categories_user ON memory_categories(user_id);

-- Hourly rollup behind the dashboard's activity heatmap. A write-time rollup for the same reason
-- usage_by_origin is one: the only other source for "how busy was this instance at 3pm last Tuesday"
-- is brain_messages, the largest table, and better-sqlite3 is synchronous — grouping it per request
-- would run on the daemon's event loop. `user_id` is NOT NULL with 0 meaning "no account behind it"
-- (a cron or an unlinked platform sender), because SQLite treats every NULL in a primary key as
-- distinct and the bucket would stop folding.
CREATE TABLE IF NOT EXISTS activity_buckets (
  day TEXT NOT NULL,              -- YYYY-MM-DD, UTC, matching strftime output
  hour INTEGER NOT NULL,          -- 0-23, UTC
  user_id INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, hour, user_id)
);
CREATE INDEX IF NOT EXISTS idx_activity_buckets_day ON activity_buckets(day);

-- Plugin-owned schema migrations bookkeeping (plugin-platform F1c). Plugin tables live in THIS database
-- (one WAL/backup/transaction domain — see src/store/pluginDb.ts for why not a per-plugin file); each
-- plugin applies its own ordered steps through ctx.db().migrate(), recorded here exactly once.
CREATE TABLE IF NOT EXISTS plugin_migrations (
  plugin TEXT NOT NULL,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (plugin, version)
);
