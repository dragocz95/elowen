# Orca — deferred follow-ups (post sub-project #1)

Sub-project #1 (orchestration backend `orca serve`) ships with the **boolean guardrail
gate** and **sequential autopilot** (`max_sessions: 1`, the documented default). The items
below are deliberately deferred — each is a self-contained next task, not abandoned work.

## 1. Decision engine (wire the `inference` module)

**Status:** `src/inference/` (`RelayClient` + `FakeInference`) is built and unit-tested, and
the relay config is plumbed into `buildApp(opts.relay)` — but it is **not yet consumed**. The
overseer currently decides purely from autonomy level + cleared guardrails.

**Next task:** add an overseer decision step that consults `mimo-v2.5` via the relay
(`InferenceClient.decide`) for approve/redirect judgments before spawning a guardrail-triggering
task. Construct `RelayClient` in `bootstrap.ts` when `opts.relay` is set and inject it into
`MissionEngine` as an optional decision hook (relay absent → unchanged boolean behavior). This
is Filip's "the LLM decides about tasks" layer.

## 2. Concurrency hardening (only matters at `max_sessions > 1`)

At the sequential default these are inert; they become real when parallel agents are enabled:

- **`nameAgent` uniqueness** (`bootstrap.ts`): `Agent${performance.now() % 9999}` can collide
  for two spawns in the same millisecond → duplicate `orca-<name>` tmux session + agent row.
  Fix: a monotonic counter or a uniqueness check against live sessions.
- **`sessionTaskId` resolver** (`bootstrap.ts`): returns the first `in_progress` task regardless
  of session, so every concurrent session derives against the same task. Fix: have
  `SpawnService` record a `session → taskId` map and resolve from it.
- **Per-mission running count** (`missionEngine.ts`): the cap counts ALL `orca-*` sessions
  globally, so two concurrent missions interfere. Fix: attribute sessions to missions.
- **Stuck-session recovery:** if an agent dies without `jt close`, its task stays `in_progress`
  and the mission never advances (no liveness sweep). Fix: a stall detector (silent > N min →
  nudge → relaunch → escalate), as jat had.

## 3. API surface completion (spec §5 routes not in #1)

Task 17 scoped a subset. Spec §5 also lists: `GET /tasks/:id/tree`, `POST /tasks/:id/deps`,
`GET/POST /agents`, `GET /projects`, `POST /sessions` (spawn), `PATCH /missions/:id`
(pause/resume). Add as the CLI/frontend needs them; `POST /tasks/:id/deps` is the most useful
(currently deps are only settable via the internal `TaskStore.addDep`).
