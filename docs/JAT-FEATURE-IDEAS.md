# JAT → Orca: High-Impact Feature Ideas

Exploration of the [JAT](https://github.com/joewinke/jat) project (full agentic IDE:
SvelteKit front-end + bash/Node tooling + tmux orchestration, multi-project, multi-source
ingest, automation rules, workflows, scheduler, overseer cockpit) compared against orca's
current scope (single-project daemon: Hono + SQLite, Next.js web, tmux agents, missions,
guardrails, scheduler, planner, deriver, decision engine stubbed but not wired).

Goal: identify features JAT has that would bring **a lot of value** to orca, prioritised
by impact vs effort. Each entry: what JAT does, why it's valuable, and how it fits orca's
architecture (Next.js web + Hono/SQLite daemon + tmux agents).

Priority key:
- **P0** — high impact, low/medium effort, drops cleanly onto existing tables/modules.
- **P1** — high impact, moderate effort, needs new schema/UI but fits the architecture.
- **P2** — strategic, larger effort, worth planning but not next.

Conventions follow `docs/DESIGN-PROPOSALS.md` (OLED-black, Vercel-clean, no gradients).
All proposals are **spec only** — no code changes here. See `docs/FOLLOWUPS.md` for
in-flight work these build on.

---

## P0 — High impact, low/medium effort

### P0.1 — Recurring tasks (cron) on the existing `scheduled_at` field

**What JAT does.** Tasks carry `schedule_cron` + `next_run_at` + `command` + `agent_program`
+ `model`. The scheduler daemon (`tools/scheduler/index.js`) polls every 30s; for cron
tasks it spawns a **child instance task** (inherits command/agent/model/labels, gets
`{parent title} ({date})` title, no cron itself), then recomputes `next_run_at` from the
cron expression. One-shot tasks (`next_run_at` set, no cron) spawn directly and clear the
date. Human tasks (command = `/human` or null) get a child instance but no spawn. Timezone
is configurable. See `shared/scheduler.md`.

**Why it's valuable.** Orca already has the foundation: `tasks.scheduled_at` + `tasks.autostart`
+ `Scheduler.tick()` in `src/overseer/scheduler.ts:18` consumes due one-shot tasks. What's
missing is **recurrence** — the difference between "remind me once at 9am" and "review PRs
every weekday at 9am forever". Recurring chores are JAT's most-loved single feature for
anyone running agents overnight: nightly test sweeps, weekly dep updates, periodic
regression checks, cron-triggered scraping/monitoring tasks. They turn orca from a queue
into a self-sustaining system.

**Fit for orca.** Clean, additive:
- Schema: add `schedule_cron TEXT` and `next_run_at TEXT` columns to `tasks` (keep
  `scheduled_at` as the human-facing due date for one-shots; `next_run_at` is the
  scheduler's internal cursor). Migration is forward-only with `ALTER TABLE … ADD
  COLUMN … NULL`.
- `Scheduler.tick()` (`src/overseer/scheduler.ts`): extend the existing due-task filter
  to (a) one-shots as today, (b) cron parents with `next_run_at <= now` → clone a child
  task (new id, `parent_id = parent.id`, inherit `type/priority/labels/description`,
  stamp title with today's date), spawn the child, then recompute parent's `next_run_at`
  via a tiny `cron-parser` dependency. Skip spawn when `labels` contains `human:true`.
- CLI: `orca schedule <id> --cron "0 9 * * 1-5"` and `orca schedule --cancel <id>`.
- Web: extend `TaskModal` (`web/modules/tasks/TaskModal.tsx`) with a "Repeat" segmented
  control (None / One-shot / Cron) that reveals a cron input + next-run preview. Add a
  `/chores` page mirroring JAT's (`ide/src/routes/chores/+page.svelte`) — a filtered
  table of tasks where `schedule_cron IS NOT NULL`, with Start/Stop scheduler and
  "Run now" actions.
- Timezone: store per-project (or in `settings.data`) — default UTC, mirror JAT.
- Effort: ~1 day. Dependency: `cron-parser` (~30KB, no transitive deps).

---

### P0.2 — Task comments / async questions thread

**What JAT does.** Every task has a comment thread (`comments` table, types:
`question`/`answer`/`note`/`event`). Agents emit `jat-signal waiting` to ask an async
question when the human isn't around — this posts a `question` comment, flips task to
`waiting`, and pauses the tmux session. The human answers by posting an `answer` comment
in the IDE; when the session resumes (new agent picks up the task), it reads the thread.
`CommentsThread.svelte` renders types with different avatars/alignment. See
`AGENTS.md` → "Asynchronous Questions".

**Why it's valuable.** Orca today has only synchronous "needs_input" escalation
(`src/deriver/deriver.ts` → `EventBus` → web toast). When the operator is asleep, the
agent sits frozen and the mission stalls until morning. JAT's pattern converts a
blocking question into an **async, durable, threaded conversation** that survives
session kill/replay and lets the operator triage 10 overnight questions in 5 minutes
from one inbox. This is the single biggest unblocker for L3 overnight autonomy.

**Fit for orca.** Reuses the existing `events` table shape but needs its own table:
- Schema: `CREATE TABLE task_comments (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL,
  author TEXT, author_type TEXT, comment_type TEXT, body TEXT, created_at TEXT …)` +
  index on `task_id, created_at`. Add `waiting` to the `TaskStatus` union
  (`src/store/types.ts`) — agents in `waiting` are excluded from `readiness.ready()`
  (already the case for non-`open`/`in_progress`).
- Deriver: when an agent hits `needs_input` and the mission autonomy is L0/L1 (or L2/L3
  but `decision.approve === false`), instead of only emitting the SSE event, also
  insert a `task_comments` row with `comment_type='question'`, set task `waiting`, and
  publish a `task` event. The agent session stays alive (don't kill — let the human
  answer in-band via `tmux send-keys`, or kill + relaunch on answer).
- API: `GET /tasks/:id/comments`, `POST /tasks/:id/comments` (body + optional
  `comment_type`). Posting an `answer` flips the task back to `open`/`in_progress` and
  (optionally) sends the text to the tmux session via `sendKeys`.
- Web: a `CommentsThread` component in the `TaskModal` (or a new `TaskDetailDrawer`
  mirroring `web/components/.../TaskDetailDrawer.tsx`), plus an `/inbox` route listing
  all tasks in `waiting` state with the question inline — JAT's `/inbox` is the single
  most-used page for overnight operators.
- Effort: ~1.5 days. Pure additive layer; no changes to existing deriver state machine
  beyond emitting one extra side-effect.

---

### P0.3 — Agent "review" signal + Mission Inbox (suggested tasks, human actions)

**What JAT does.** When an agent finishes, it emits `jat-signal review` with a payload
that includes not just a summary, but two structured queues:
- `humanActions[]` — manual steps a human must run after the code ships ("Register the
  webhook in Stripe Dashboard", "Run `psql ... < migrate.sql`"). Surfaces in the
  "Needs-Human Queue" in the overseer cockpit.
- `suggestedTasks[]` — follow-up work the agent noticed but is out of scope (a spotted
  bug, an adjacent feature, tech debt). One click in the IDE files it as a real task.

See `ide/src/lib/server/overseer/types.ts` → `ReviewPayload`, and
`NeedsHumanQueue.svelte`.

**Why it's valuable.** Orca's `TaskStore.close()` (`src/store/taskStore.ts:42`) already
stamps `result_summary` + `outcome` — but those are free text. Structured `humanActions`
+ `suggestedTasks` turn a finished task from a one-line "done" into a **two-click
workflow**: review what the agent did, see what still needs me, file the follow-ups.
This is the difference between "agent did a thing" and "agent did a thing and told me
exactly what to do next". It's also the foundation for the autopilot's
perpetual-motion loop (JAT's flywheel step 9 → back to step 3).

**Fit for orca.** Drops onto the existing close flow:
- Schema: two new tables, `task_human_actions (id, task_id, title, items_json, done INTEGER,
  created_at)` and `task_suggested (id, task_id, title, type, priority, description, reason,
  filed_task_id, created_at)`. Or, simpler: one `task_followups` table with a `kind`
  column. The agent emits these via a new CLI subcommand `orca followup add` or by
  writing to a known JSON file in the session dir, which the deriver picks up on
  `complete`.
- Deriver: on detecting `complete`, read the follow-up file (if any) and persist rows.
- API: `GET /tasks/:id/followups`, `POST /tasks/:id/followups/:fid/file` (creates a
  real task from a suggested one, links via `filed_task_id`), `POST
  /tasks/:id/followups/:fid/done`.
- Web: in `TaskModal` (or a new right-hand drawer), render a "Review" tab when
  `result_summary` is set: shows summary, `humanActions` as a checklist, `suggestedTasks`
  as a list with "File as task" buttons. Add a `/missions/:id/inbox` panel inside the
  existing mission detail modal aggregating all open human actions across the epic.
- Effort: ~1.5 days. The agent-side emission can reuse the existing `close --summary
  --outcome` CLI and just add `--human-actions <json>` / `--suggested <json>` flags.

---

### P0.4 — Session automation rules (pattern → action)

**What JAT does.** A user-configurable rules engine that watches terminal output and
fires actions on match. Rule = `{patterns[], actions[], sessionFilter[], cooldown,
priority}`. Pattern modes: `string`/`regex`/`contains`/`exact`/`startsWith`/`endsWith`/
`semantic` (LLM fuzzy). Action types: `send_text`, `send_keys`, `tmux_command`,
`signal`, `notify_only`, `show_question_ui`, `run_command`, `execute_workflow`. Stored
in a JSON config file, editable in the IDE at `/automation` with a pattern tester.
See `ide/src/lib/types/automation.ts` and `ide/src/lib/utils/automationEngine.ts`.

**Why it's valuable.** Orca's `Deriver` (`src/deriver/deriver.ts`) hardcodes prompt
detection in `detectAgentPrompt()` and hardcodes the response (clear or escalate).
JAT's rules engine makes this **user-extensible without touching daemon code**:
"when an agent prints `npm ERR! ERESOLUTION` → send `--force` and Enter", "when an
agent prints `Do you want to create a PR?` → always answer `n`", "when an agent
prints `Rate limit exceeded` → kill the session and requeue the task". This is the
single biggest lever for reducing operator interruptions during overnight runs.

**Fit for orca.** The deriver already does pattern detection + action dispatch — this
generalises it:
- Config: store rules in `settings.data.automationRules` (the `ConfigStore` already
  handles arbitrary JSON patches at `src/store/configStore.ts`) or a new
  `automation_rules` table. Keep rule shape close to JAT's for portability.
- Engine: in `Deriver.tick()`, after the built-in `detectAgentPrompt` check, run the
  pane tail through the user ruleset. For each match (respecting cooldown + session
  filter + priority), fire the action via `tmux.sendKeys` / `EventBus.publish` /
  `SpawnService.launch`. Skip `semantic` mode in v1 (needs the inference relay); ship
  string/regex/contains only.
- Web: a new `/automation` route mirroring JAT's (`ide/src/routes/automation/+page.svelte`)
  — rules list + preset picker + pattern tester against a pasted pane tail. Presets:
  "Auto-retry npm install", "Always decline PR creation", "Auto-confirm safe prompts",
  "Kill on rate limit".
- API: `GET /automation/rules`, `PUT /automation/rules`, `POST /automation/test`
  (dry-run a pane tail against the ruleset, return matches).
- Effort: ~2 days. Reuses `TmuxDriver.sendKeys` and `EventBus`; the engine is ~150
  lines. Biggest win per line of code in this list.

---

### P0.5 — Stuck-session detector (stall → nudge → relaunch → escalate)

**What JAT does.** The overseer trigger loop has a `stall` trigger: if an agent emits
no signal for N minutes (default 20), it nudges (sends a key), then relaunches, then
escalates to the Needs-Human queue. See `types.ts` → `OverseerTrigger = 'stall' | …`
and `trigger-loop.ts`.

**Why it's valuable.** Orca has a known gap here — `docs/FOLLOWUPS.md` §2 calls it out:
"if an agent dies without `jt close`, its task stays `in_progress` and the mission never
advances (no liveness sweep)". Today the `Janitor` (`src/overseer/janitor.ts`) only
reaps sessions whose task is already `closed`/`cancelled` — it does nothing for
**zombie** sessions (alive but silent, or dead but tmux still attached). This is the #1
cause of stuck missions in practice.

**Fit for orca.** Small, surgical:
- `AgentStore` (`src/store/agentStore.ts`) already tracks `last_active_ts`. Add a
  `StallDetector` (new file in `src/overseer/`) that the deriver tick calls: for each
  live `orca-*` session, if `now - last_active_ts > threshold` (default 20 min,
  configurable per-mission or in `settings`): (1) first time → send a newline via
  `tmux.sendKeys` (nudge), (2) still silent after 2 min → kill the session via
  `tmux.kill`, flip task back to `open`, publish a `task` event, (3) if the task has
  failed N times → set `blocked` and emit a `needs_input` event with "agent stalled"
  context.
- Web: surface stalled sessions in the sessions list with a "stalled" badge + manual
  "Relaunch" button (already exists via `ExecutorPicker`).
- Effort: ~0.5 day. Pure daemon-side; no schema change beyond maybe a
  `tasks.stall_count INTEGER DEFAULT 0` column.

---

## P1 — High impact, moderate effort

### P1.1 — Visual workflow builder (n8n-style nodes + edges + cron triggers)

**What JAT does.** A full n8n-style workflow editor: nodes (`trigger_cron`,
`trigger_event`, `trigger_manual`, `llm_prompt`, `action_create_task`,
`action_spawn_agent`, `action_run_bash`, `action_browser`, `action_run_workflow`,
`condition`, `transform`, `delay`), edges with typed ports, canvas with minimap.
Workflows are JSON files in `~/.config/jat/workflows/`, executed by the scheduler
daemon on cron or manual trigger. Each node supports `{{input}}` / `{{result}}`
template vars; condition nodes branch on a JS expression; subflows are reusable.
See `ide/src/lib/types/workflow.ts` and `tools/scheduler/lib/workflows.js`.

**Why it's valuable.** This is JAT's headline differentiator vs every other agent
orchestrator. A mission in orca is a **fixed dependency graph executed
deterministically** — good for "decompose this epic into ordered tasks". Workflows are
**composable, branching, event-driven automations** — good for "when a Stripe
webhook fires, classify the event, file a bug if it's a failure, spawn an agent to
investigate, and ping me on Telegram". The two cover different use cases; orca has
the first, not the second. Workflows unlock: event-driven agents (CI failures,
GitHub PRs, Sentry alerts), multi-step LLM pipelines (classify → draft → review →
file), cross-tool automation (browser → screenshot → LLM → task).

**Fit for orca.** Bigger but well-scoped, and orca's planner + scheduler give a head
start:
- Storage: JSON files in `~/.config/orca/workflows/*.json` (mirror JAT exactly —
  easy to port presets). No DB schema needed.
- Daemon: a new `WorkflowEngine` in `src/overseer/workflowEngine.ts` that the
  existing `Scheduler.tick()` calls for due cron-triggered workflows (reusing the
  `cron-parser` dep from P0.1). Event triggers subscribe to the existing `EventBus`
  (`src/api/sse.ts`) — `task_created`, `task_closed`, `signal_received` become
  first-class workflow triggers. Node executors: `action_create_task` →
  `TaskStore.create`, `action_spawn_agent` → `SpawnService.launch`,
  `action_run_bash` → `child_process.execFile`, `llm_prompt` → `InferenceClient`
  (already built at `src/inference/client.ts`, just not wired).
- Web: a `/workflows` route with a React Flow canvas
  (`reactflow` / `@xyflow/react` is the standard). Node palette on the left, canvas
  in the middle, config panel on the right. Reuse the `ModuleShell` + `Section` +
  `Card` primitives. Run history drawer per workflow. This is the single biggest
  web-side effort in the list.
- API: `GET/POST /workflows`, `GET/PUT/DELETE /workflows/:id`, `POST
  /workflows/:id/run`, `GET /workflows/:id/runs`.
- Effort: ~1 week (web canvas is the bulk; daemon engine is ~2 days). Defer
  `action_browser` and `subflow` to v2.

---

### P1.2 — External ingest (Telegram / Slack / RSS / email → task → agent)

**What JAT does.** A separate daemon (`jat-ingest`) polls external sources via a
plugin adapter system (`tools/ingest/adapters/`: RSS, Slack, Telegram, Gmail,
Discord, WhatsApp, Signal, Matrix, MS Teams, Feishu, Line, Nostr, Twitch, Postgres,
Supabase, BlueBubbles, Google Chat, Mattermost — 18 built-in). Each plugin exports
metadata + an adapter class with `poll()` / `validate()` / `test()`. Incoming items
become tasks via `buildTaskIdentity()` (creator/requester/approver routing); trigger
modes: Immediate / Delay / Schedule / Cron. See `tools/ingest/PLUGINS.md`.

**Why it's valuable.** This is the "ship while you sleep" half of JAT's pitch. Orca
today is a queue you have to feed by hand (or via the planner). Ingest makes orca
**event-driven from the outside world**: DM your Telegram bot "fix the login crash
on staging" → task created → agent spawned → PR opened → you wake up to a
notification. The same mechanism drives cron RSS monitoring (blog competitors,
Sentry feeds, GitHub release notes), Slack-triggered triage, and email-to-task
(support tickets becoming agent work automatically). Combined with P0.1 (cron) and
P1.1 (workflows), this is the full autonomous platform.

**Fit for orca.** Orca already has the receiving end (TaskStore, SpawnService,
Scheduler) — this adds the polling/source layer:
- Daemon: a new `src/ingest/` module, optionally a separate process (`orca ingest
  start`) mirroring `jat-ingest`. Polls each configured source on its interval,
  dedupes (store last-seen item id per source in a new `ingest_state` table),
  creates a task per new item, optionally spawns an agent immediately (trigger mode
  `immediate`) or sets `scheduled_at` (mode `delay`/`schedule`) or `schedule_cron`
  (mode `cron`, reusing P0.1).
- Adapters: start with the 3 highest-value (Telegram, Slack, RSS) — they're the
  best-documented in JAT and cover 80% of use cases. Port the adapter interface
  (`BaseAdapter.poll(sourceConfig, adapterState, getSecret)`) almost verbatim.
  Secrets via the existing `ConfigStore` (extend `settings.data.secrets` — or a
  dedicated `secrets` table with 0600 file perms like JAT's `credentials.json`).
- Web: an `/integrations` route mirroring JAT's wizard (`IngestWizard.svelte`):
  pick source type → fill config fields (rendered from the adapter's
  `configFields` metadata) → test connection → set trigger mode → see poll history.
  A `DynamicConfigForm` component renders fields from metadata (no per-source UI
  work).
- API: `GET/POST/DELETE /integrations/sources`, `POST /integrations/sources/:id/poll`
  (manual poll), `GET /integrations/sources/:id/history`.
- Effort: ~3-4 days for the 3 adapters + daemon + minimal web. The plugin interface
  is ~80 lines; each adapter is ~150. Defer the long tail of adapters.

---

### P1.3 — Overseer cockpit (live + history + needs-human queue per mission)

**What JAT does.** The `/epics` page is a 3-column cockpit for piloting one epic:
**TaskRail** (ready/running/review/escalated/done/blocked groups), **Live** (running
sessions with their latest signal + the in-flight LLM decision), **History** (the
audit event log). Below: a **TechTree** panel (the dependency graph with frontier
highlight) and a **NeedsHumanQueue** (pending escalations with approve/redirect/skip).
All driven by the overseer's append-only decision log + signal timeline. See
`ide/src/lib/server/overseer/cockpit-types.ts`.

**Why it's valuable.** Orca's `MissionProgressView` (`web/modules/missions/MissionProgressView.tsx`)
shows progress stat cards + a static dependency graph. It doesn't show **what the
overseer is doing right now** — the in-flight decision, the recent
launches/approvals/redirects, the queue of things waiting on you. For an L2/L3
mission running 5 parallel agents, the cockpit is the difference between "I can see
the swarm" and "I'm flying blind". This is the operator-facing surface that makes
autonomy feel safe.

**Fit for orca.** Orca already has the data; it's a UI reorganisation:
- Data: `events` table already records every state change. Extend `EventStore`
  (`src/store/eventStore.ts`) with a `forMission(missionId, limit)` query. The
  decision engine (FOLLOWUPS §1 — wire the `inference` module) writes its
  approve/redirect/escalate decisions as typed events; `Decision` already exists at
  `src/overseer/decision.ts`.
- Web: rework `MissionProgressView` into a 3-pane layout (reuse the existing
  `DependencyGraph` for the tech-tree panel). Add a `LiveColumn` that lists
  `in_progress` tasks for the epic with their session card inline (reuse
  `SessionCard`), a `HistoryColumn` that streams the last N events via the existing
  SSE `useOrcaEvents` hook, and a `NeedsHumanQueue` that filters events where
  `type='needs_input'` and the task is still `in_progress`.
- API: `GET /missions/:id/events?limit=50`, `GET /missions/:id/escalations`
  (filters the above), `POST /missions/:id/escalations` (resolve: approve / redirect
  / skip — approve sends `/jat:complete`-equivalent to the session, redirect sends a
  steer text).
- Effort: ~2-3 days. Mostly web; daemon side is a couple of queries + one new
  endpoint. Depends on P0.2 (comments) for the redirect/answer path.

---

### P1.4 — Decision engine: wire the `inference` module (already built)

**What JAT does.** The overseer's `InferenceProvider` abstraction (`types.ts`) has
cloud + relay backends; the decision engine calls it on every review signal with a
stitched `DecisionContext` (task, review payload, signal timeline, guardrail result)
and gets back `{action: launch|approve|redirect|escalate|hold, rationale,
steerText?}`. Decisions are persisted to an append-only `decision_log` for audit +
replay. See `types.ts` → `DecisionLogEntry`.

**Why it's valuable.** Orca already has the inference client
(`src/inference/client.ts`), the decision prompt/parser
(`src/overseer/decision.ts`), and a `decideApproval` hook in the deriver
(`src/deriver/deriver.ts`). Per `docs/FOLLOWUPS.md` §1, it's **built and unit-tested
but not consumed** — the overseer currently decides purely from autonomy level +
cleared guardrails (boolean). Wiring it is the difference between "L3 auto-approves
everything that's not on the guardrail list" and "L3 asks the model whether this
specific review payload looks safe, with the diff + signal history as context". This
is the single highest-leverage daemon-side change in the backlog.

**Fit for orca.** Small, surgical, already specced in FOLLOWUPS:
- `bootstrap.ts`: construct `RelayClient` when `opts.relay` is set, inject into
  `MissionEngine` and `Deriver` as `decideApproval` (the deriver hook is already
  there).
- `MissionEngine.tick()`: before spawning a guardrail-triggering task, call the
  decision engine with the task title + labels + guardrail result; on
  `action='escalate'` skip + emit a `needs_input` event, on `action='redirect'`
  inject the steer text into the task description before spawn.
- `DecisionLogEntry`: add a `decision_log` table (`id, mission_id, epic_id, task_id,
  trigger, action, rationale, steer_text, tokens_used, latency_ms, timestamp`) and
  write one row per decision. This is the data source for P1.3's history column.
- Web: surface the latest decision rationale on each task card in the missions view
  (tooltip or inline badge). No new route needed.
- Effort: ~1 day. The code is 80% written; this is wiring + a table + a column.

---

### P1.5 — File declarations + conflict-aware launch guard

**What JAT does.** Tasks declare `reserved_files` (glob patterns). The overseer
launch loop checks: a ready task whose `reserved_files` overlap a running agent's
declared files is **held back** (`SlotReason.kind='file_conflict'`). Tasks with no
declared files serialize under an `undeclaredCap` (default 3) to avoid blind
collisions. The per-tick readout of why each idle slot is unfilled is surfaced in
the cockpit header. See `types.ts` → `EpicTaskNode.reservedFiles`, `SlotReason`.

**Why it's valuable.** Orca's `FOLLOWUPS.md` §2 lists "per-mission running count"
and concurrency hardening as the main blockers for `max_sessions > 1`. Today, two
parallel agents can both touch `src/store/schema.sql` and produce a merge conflict
the operator has to untangle. File declarations make parallelism **safe by
construction**: agents that touch disjoint files run concurrently; agents that
touch overlapping files serialize automatically. This unlocks the actual value of
`max_sessions > 1` (which is orca's default per `configStore.ts` —
`maxSessions: 1`).

**Fit for orca.** Additive:
- Schema: `ALTER TABLE tasks ADD COLUMN reserved_files TEXT DEFAULT ''` (comma-joined
  globs, like `labels`).
- `Readiness.ready()`: return `reserved_files` on each ready task.
- `MissionEngine.tick()`: before spawning, check the ready task's globs against the
  union of globs from currently-`in_progress` tasks in this mission; if overlap,
  skip this tick (the task stays ready and will fire when the conflicting agent
  closes). Track an `undeclared_count` for tasks with empty `reserved_files` and
  cap it.
- Web: add a "Reserved files" field to `TaskModal` (comma-separated globs). Surface
  the skip reason as a tooltip on the task card ("held — conflicts with
  `orca-Nova` on `src/api/**`").
- Effort: ~1 day. The glob match is a ~20-line `minimatch` helper.

---

## P2 — Strategic, larger effort

### P2.1 — Multi-project support

**What JAT does.** Every project under `~/code/` with a `.jat/tasks.db` is
auto-discovered. The IDE shows all projects' tasks in one view, filtered by
project. Task IDs carry the project slug (`alpha-abc`, `beta-xyz`). Agents spawn
in the project's own working directory. Per-project config (port, tunnels,
backend, secrets) lives in `~/.config/jat/projects.json`. See `README.md` →
Configuration.

**Why it's valuable.** Orca is single-project today (`bootstrap.ts` boots one
`project: { id, path }`). For anyone running more than one repo (client work +
side project + orca itself), this means running multiple orca daemons on
different ports — no unified view, no cross-project agent sharing, no shared
config. Multi-project is what turns orca from "a tool for one repo" into "the
control tower for everything I work on". It's also a prerequisite for ingest
(P1.2) being useful — an incoming Telegram message needs to route to the right
project.

**Fit for orca.** Bigger refactor but the schema is ready:
- `projects` table already exists (`src/store/schema.sql`) with `slug`/`path`/`notes`.
  The `project_id` foreign key is already on `tasks`/`agents`/`missions`. The
  missing piece is that `bootstrap.ts` binds one project at boot and threads it
  through `ServerDeps`/`MissionEngineDeps`/`SchedulerDeps` as `project: { id, path }`.
- Refactor: lift `project` out of the deps — every store method already takes
  `project_id` as a filter; the engines need to iterate over active projects per
  tick instead of one. `Scheduler.tick()` → loop over projects. `MissionEngine.tick()`
  → loop over missions (already mission-scoped, just needs to not assume one
  project).
- Web: a project switcher in the sidebar (JAT has `ProjectSelector.svelte`),
  routing becomes `/:slug/tasks`, `/:slug/missions`, etc. or a global filter.
- CLI: `orca ls` takes `--project <slug>`; `orca use <slug>` sets a default in
  `~/.config/orca/default-project`.
- Effort: ~1 week. Mostly mechanical (the schema is right); the web routing is the
  bulk.

---

### P2.2 — Code editor + git source control in the web UI

**What JAT does.** A full Monaco editor in the IDE: file tree, multi-file tabs,
lazy-loading, context menu (rename/delete/send-to-LLM/create-task-from-selection).
Git tab: staged/unstaged changes, per-file stage/unstage, commit (Ctrl+Enter),
push/pull with ahead/behind, branch switcher, diff preview drawer, commit
timeline. `/source` route: full commit history, multi-select cherry-pick/revert,
search by message/author, diff viewer for any commit. See `README.md` → Code
Editor / Git Source Control.

**Why it's valuable.** Orca today has a `GitReader` (`src/git/gitReader.ts`) that
exposes branch/ahead-behind/dirty/commits as **read-only** data on the projects
view. JAT's integration makes the web UI a **first-class review surface**: see an
agent's diff, commit it, push it, cherry-pick a fix from another branch — without
leaving the browser. For overnight autonomous runs, this is how the operator
reviews and ships the work the swarm produced. It closes JAT's flywheel loop
(steps 6-7: review in /tasks → commit & push).

**Fit for orca.** Big web effort, small daemon effort:
- Daemon: extend `GitReader` with write operations — `stage(paths)`, `unstage(paths)`,
  `commit(message, paths)`, `push()`, `pull()`, `checkout(branch)`, `cherryPick(hash)`,
  `revert(hash)`, `diff(path, ref?)`. All are thin `execFile('git', …)` wrappers
  like the existing `read()`. Add `GET /projects/:id/git/diff?path=&ref=`,
  `POST /projects/:id/git/stage`, `POST /projects/:id/git/commit`, etc.
- Web: integrate `@monaco-editor/react` for the editor pane. A `/files` route with
  a 3-pane layout (file tree | tabbed editor | git panel) mirroring JAT's. A
  `/source` route with commit history + diff viewer (reuse `react-diff-viewer`).
  The file tree can reuse the existing `Section`/`Card` primitives.
- Effort: ~1.5 weeks. Monaco is heavy; the git daemon side is ~2 days. Defer
  cherry-pick/revert to v2 — stage/commit/push/diff covers 90% of the value.

---

### P2.3 — Knowledge bases / block-based interactive documents

**What JAT does.** "Bases" are block-based documents (text, table_view, control,
formula, divider, action) stored in a `bases` table. They're attached to tasks or
set as always-inject for a project, giving agents structured context beyond a
free-text description. Controls (select/slider/date/text_input/checkbox) let a
human parameterise a base; formulas compute from controls + table views; actions
run workflows. See `ide/src/lib/types/canvas.ts`.

**Why it's valuable.** Orca's task `description` is a single text blob. For
recurring work ("review the open PRs in repo X, filter by label Y, summarise Z"),
a parameterised base with controls + a live data table view is far more powerful
than a static prompt. Bases also give orca a **lightweight Notion-like surface**
for project context that agents read on every spawn — architecture decisions,
conventions, glossary, runbooks. This is the difference between "agent has a
task" and "agent has a task + the project's brain".

**Fit for orca.** Mostly web, fits the module pattern:
- Schema: `bases (id, project_id, name, blocks_json, always_inject INTEGER,
  created_at, updated_at)` + `task_bases (task_id, base_id)`.
- Daemon: `BaseStore` CRUD; on `SpawnService.launch`, prepend the concatenated
  text of the project's `always_inject` bases + the task's attached bases to the
  task description before building the agent command.
- Web: a `/bases` route with a block editor (reuse `BlockRenderer`-style
  components). The block types map cleanly to existing UI primitives (text →
  markdown editor, table_view → a query-driven table, control → form inputs).
- Effort: ~1 week. The block editor is the bulk; the daemon injection is trivial.
  Defer formula + action blocks to v2.

---

### P2.4 — Voice commands (two-tier: fixed phrases + LLM natural language)

**What JAT does.** Hold `Ctrl+Space` and talk. A two-tier dispatcher: fixed
phrases fire keyboard shortcuts (sub-second, no LLM); natural-language utterances
route through an LLM that extracts parameters and chains actions in one shot
("Create a bug for the login crash and spawn an agent" → opens new-task drawer
with title set → spawns). Local whisper.cpp for STT (PII stays on-device). See
`README.md` → Voice Commands, `ide/docs/voice-commands.md`.

**Why it's valuable.** This is a power-user delighter, not a core capability. But
for hands-free operation (driving, cooking, walking through the office reviewing
the swarm), voice is the difference between "I'll check when I'm back at my desk"
and "I just approved 3 escalations while pouring coffee". It also doubles
accessibility.

**Fit for orca.** Pure web, no daemon change:
- Web: a `useVoiceCommand` hook + a `VoiceCommandOverlay` component. Tier 1: a
  fixed map of phrase → action (e.g. "new task" → open TaskModal, "kill session"
  → kill focused session, "approve" → send `y` to focused session). Tier 2: send
  the transcript + a system prompt describing available actions to the inference
  relay (P1.4) → get back a structured action → execute.
- STT: browser `SpeechRecognition` API for the MVP (no whisper.cpp dependency);
  offer whisper.cpp as an upgrade for PII-sensitive setups.
- Effort: ~2-3 days for tier 1, +2 days for tier 2 (depends on P1.4).

---

### P2.5 — Skill marketplace (install community skills, auto-sync to agents)

**What JAT does.** `jat-skills install` pulls a skill (a prompt template +
optional scripts) from a community catalog; it's auto-synced to all agent
programs (Claude Code gets symlinks in `~/.claude/commands/`, OpenCode gets
directory symlinks, others get prompt injection at spawn). `jat-skills sync`
repairs. See `README.md` → Skill marketplace, `skills/` directory.

**Why it's valuable.** Orca's agents today get a task title + description + the
autopilot prompt. Skills let the community share reusable workflows ("audit this
repo for security issues", "write a migration for this schema change", "review
this PR against our conventions") that get injected at spawn. This is the
difference between "agent has the task" and "agent has the task + a proven
playbook for this kind of task". It also builds a community moat.

**Fit for orca.** Daemon-light, mostly infra:
- Catalog: a GitHub repo (or a directory in orca's repo) with skill manifests
  (`skill.json` with name/description/prompt/scripts/agent-programs).
- CLI: `orca skills install <name>`, `orca skills list`, `orca skills sync`.
  Install = clone/copy into `~/.config/orca/skills/<name>/` + symlink into the
  relevant agent config dir (`~/.claude/commands/`, `~/.opencode/skills/`, etc.).
- Daemon: at spawn time, `SpawnService` checks the task's `labels` for
  `skill:<name>` and prepends the skill's prompt to the agent command.
- Web: a `/skills` route browsing the catalog + installed skills + install
  button.
- Effort: ~3 days. The agent-side injection is trivial; the catalog infra
  (discovery, versioning, sync) is the bulk.

---

## Summary table

| ID | Feature | Priority | Effort | Depends on |
|---|---|---|---|---|
| P0.1 | Recurring tasks (cron) | P0 | ~1 day | — |
| P0.2 | Task comments / async questions | P0 | ~1.5 days | — |
| P0.3 | Review signal + Mission Inbox | P0 | ~1.5 days | — |
| P0.4 | Session automation rules | P0 | ~2 days | — |
| P0.5 | Stuck-session detector | P0 | ~0.5 day | — |
| P1.1 | Visual workflow builder | P1 | ~1 week | P0.1 |
| P1.2 | External ingest (Telegram/Slack/RSS) | P1 | ~3-4 days | P0.1, P2.1 |
| P1.3 | Overseer cockpit | P1 | ~2-3 days | P0.2, P1.4 |
| P1.4 | Wire the decision engine | P1 | ~1 day | — |
| P1.5 | File declarations + conflict guard | P1 | ~1 day | — |
| P2.1 | Multi-project support | P2 | ~1 week | — |
| P2.2 | Code editor + git source control | P2 | ~1.5 weeks | — |
| P2.3 | Knowledge bases / block docs | P2 | ~1 week | — |
| P2.4 | Voice commands | P2 | ~2-3 days | P1.4 |
| P2.5 | Skill marketplace | P2 | ~3 days | — |

**Recommended order to ship first:** P0.5 (stuck-session, half-day, unblocks
overnight runs) → P1.4 (wire decision engine, 1 day, already built) → P0.4
(automation rules, biggest interruption-reducer) → P0.1 (cron, enables recurring
work) → P0.2 (comments, enables async overnight triage) → P0.3 (review signal,
closes the flywheel) → P1.5 (file declarations, unlocks safe parallelism) → P1.3
(cockpit, makes autonomy observable) → P1.1 (workflows, event-driven automations)
→ P1.2 (ingest, external triggers) → P2.x (strategic).