# Review fixes — status (2026-07-20 overnight + 2026-07-21 continuation)

What was fixed vs. what is deliberately deferred. Every fix ships with a regression test. Current tree is
green end to end — see the **Final verification (2026-07-21)** section below for the authoritative run
(daemon vitest 4062, web 875, `npm run check` with knip at 0 findings, build + build:web, and 9 e2e suites).
The per-fix sections are grouped by wave: the original overnight pass, then the 2026-07-21 continuation
(Low lifecycle/spawn bugs, the quality + structural refactors, WhatsApp live-trace, and dead code).

## ✅ Fixed + tested

### Correctness / security bugs
- **HIGH — user-deletion data leak** (`auth.ts` DELETE `/users/:id`): now disposes the user's live
  sessions (`brain.deleteAllManagedSessions`), hard-deletes all brain data (`brainStore.removeForUser`)
  and push devices (new `PushSubscriptionStore.removeAllForUser`). Closes the SQLite rowid-reuse leak.
  Test: `tests/api/auth.test.ts`.
- **HIGH — tmux prefix-match** (`tmux/driver.ts`, `terminal/ptySession.ts`): all `-t` targets now pin an
  exact match (`=name:` / `=name`), closing cross-user kill AND keystroke injection. Test: `tests/tmux/driver.test.ts`.
- **Medium — `/tasks/ready` cross-tenant leak**: scoped by `accessibleProjects` + optional `?project_id`.
  Test: `tests/api/projectAccess.test.ts`.
- **Medium — `/plan/:jobId/submit` not idempotent**: 409 unless the job is still `planning`.
  Test: `tests/api/planJobs.test.ts`.
- **Medium — `GET /memory?offset=N` 500**: emits `LIMIT -1 OFFSET ?`. Test: `tests/store/memoryStore.test.ts`.
- **Medium — push for standalone (mission-less) tasks**: falls back to admins. Test: `tests/push/pushDispatcher.test.ts`.
- **Low — `POST /users` validation + password policy** (`userCreateSchema`, min 8), NaN→500 on the two
  `memory` LIMIT binds (`queryInt`), setup-mode 500 guards (`brain.ts`, `auth.ts adminOnly`), non-numeric
  DELETE id → 400. Tests: `tests/api/auth.test.ts`, `tests/api/memoryRoutes.test.ts`.
- **Low leaks/hygiene**: lock-map release in `liveRegistry.withLock`; throttle-map cap in `events.ts`;
  SSE multi-`data:` join in `brainClient.parseSse`; `$EDITOR` shell-quote tokenizer; `BoundedChildTermination`
  timer `unref`; `wsHandler` attach try/catch → `UNSUPPORTED_CLOSE`; `PushSender` parallel delivery;
  legacy diff-row sign precedence in `components.ts`. Tests: brainClient / externalEditor / components.

### SSOT
- **HIGH — `web/lib/cron.ts` drift**: `nextCronRun` now handles 5-field cron expressions (was returning
  null → dashboard showed valid cron jobs as "never fires"). Added a 4-way conformance test across the
  plugin / shared / web-validate / web-nextrun copies. Test: `tests/contract/cronParity.test.ts`.

### Dead code
- Removed dead `UserPromptStore.removeForUser`; removed web `pushUser`; deleted 3 fully-dead web UI
  components + their tests (`SettingCard`, `ThemeToggle`, `Section`); deleted 3 orphan scripts.

### Low bugs into delicate lifecycle/spawn/deletion paths (2026-07-21 continuation)
- `store#3` — retention janitor now deletes the whole descendant tree (`descendantSessionIds` BFS over
  `getSubagentRuns`) before the root, so `brain-ch-subagent-*` transcripts are no longer stranded.
  Test: `tests/brain/brainService.test.ts` (purge).
- `store#4` — `bindChannelContext` tears down a bound `elowen chat` terminal (`terminalTeardown`) BEFORE
  re-keying, so the sweep can't later reap it as `conversationGone` and kill the live pane. Mirrors
  `deleteSession`. Test: `tests/brain/brainService.test.ts` (bindChannelContext teardown).
- `brain#3` — the mode-switch marker + `flushReasoningMarker` moved inside `serial(send-…)` onto the
  post-rollover session `b`, so a send that switches mode AND rolls over no longer strands the marker on
  the archived conversation. Tests: `tests/brain/brainService.test.ts` (mode marker + rollover).
- `cli#4` — `stop`/`start`/`status` birth-validate a tracked pid (`isTrackedService`: procfs argv match on
  Linux, liveness fallback elsewhere), so a stale `run.json` after a reboot never SIGTERMs a recycled PID
  or adopts a stranger as "already running". Tests: `tests/cli/launcher.test.ts`.
- `N1` — agent env (incl. token) is delivered as tmux session env (`spawn` `-e KEY=VAL`) instead of an
  inline `export …`, so it never enters the pane scrollback; the now-redundant env-export path was removed
  from `commandBuilder` (single delivery path), and a spawn failure scrubs the token. Kept `send-keys`
  (login-shell/PATH/prompt-detection preserved — `spawnArgv` would have changed pane-persistence, which
  `deadAgentTasks`/deriver depend on). Tests: `tests/spawn/{spawn,commandBuilder}.test.ts`.

### Quality refactors (2026-07-21 continuation)
- `#9` `TranscriptModel.apply` — the three heavy reducer cases (`tool`/`subagent`/`workflow`) peeled into
  private `applyTool`/`applySubagent`/`applyWorkflow` methods; the switch is now a thin dispatch. Pure
  refactor, covered by the existing 33-case `transcriptModel.test.ts`.
- `#15a` `withBrain(handler)` guard dedup in `routes/brain.ts` — the copy-pasted `503 + forbidden` (+admin)
  prologue is now one wrapper that hands the handler a guaranteed-present `brain`; a new route can't forget
  the agent-scope guard. Routes with a benign non-503 fallback (`status`/`sessions`/`rate-limits`/`queue`)
  and the SSE stream keep their bespoke guard.
- `#2` zod migration of `routes/brain.ts` — the remaining hand-rolled `(await c.req.json().catch(()=>({})))`
  bodies now go through `parseBody` + a schema (`brainRename/Toggle/Think/Cwd/Compact/Context/Terminal/Goal`).
  **Behavior change (flagged): malformed JSON now 400s** instead of silently defaulting; real clients always
  send valid JSON (`JSON.stringify`), so only hand-crafted bad bodies are affected. The two polymorphic
  dispatchers (`/brain/command`, `/brain/subgoal`) keep their hand-rolled read. Test: `tests/api/brainRoutes.test.ts`.

### Structural refactors (2026-07-21 continuation)
- `#14` `routes/plugins.ts` (792 lines) split into `routes/plugins/{index,cronjobs,skills,agents,oauth}.ts`
  (+ a 7-line `shared.ts` for the `notAdmin` gate type). `index.ts` keeps the public `registerPluginRoutes`
  signature and calls the four sub-registrars in the original order. Pure move, zero behavior change; caller
  `routes/index.ts` re-pointed to `./plugins/index.js`. Verified: `tests/api/pluginRoutes.test.ts` 24/24.
- `#3a` `BrainUsageStore` extracted from `BrainStore` (`src/store/brainUsageStore.ts`): the usage-accounting
  engine (`USAGE_ROWS`/`TASK_SNAPSHOT_EXCLUSION` SQL + `usageByDay`/`usageByModel`/`descendantUsage` +
  `rollupDroppedUsage`). BrainStore is the facade — it holds one `BrainUsageStore` and delegates the three
  views (callers unchanged). `rollupDroppedUsage` takes a structural `{ content }[]` so the two stores share
  only `Db` (no import cycle). Verified: `tests/store/brainStore.test.ts` 75/75.

### Dead code (2026-07-21 continuation)
- Removed verified prod-dead, test-only exports + retargeted their tests to the public API (never weakened
  coverage): `UserStore.userForToken`→`principalForToken`, `UserStore.refreshAgentToken`→`ensureAgentToken`,
  `PushSubscriptionStore.listForUser`→`listForUsers`, `appendBufferedBrainEvent`→`appendReplayBrainEvent`,
  `bottomHints`/`startScreenHints`→`*Items`, `ConfigStore.providers()` (+ orphan `Providers` type), web
  `epicCapacity`/`lastClosedTask`/`modulesByGroup` (+ `GROUP_ORDER`/`ModuleGroup`), deleted dead
  `PageFrame.tsx`+`Surface.tsx` (excised from the shared `InteractionPatterns` test, DataTable coverage kept),
  dropped the `askUsesButtons` index re-export in discord+telegram, removed the stale `knip.json`
  playwright suppressions (knip now 0 findings). Two isolated test cases that only exercised a dead symbol
  were dropped; every live behavior stayed covered.
- **KEPT (documented)**: `MemoryStore.getEmbedding` — it is the only public read path for a single embedding
  row and the sole way tests assert `setEmbedding`/`purge`/`removeForUser` cascade + cross-user isolation on
  prod-used methods; removing it would delete live-behavior coverage with no equivalent public API.

### Final verification (2026-07-21) — ALL GREEN
`npm run check` exit 0 (lint + knip **0 findings** + depcruise + typecheck) · `npm run build` + dist-integrity
· `npm run build:web` · daemon vitest **4062** · web vitest **875** · e2e: whatsapp / discord / telegram /
brain / api / cron / migration / delegate / web — all pass, prod daemon PID unchanged (zero prod impact).

### WhatsApp live-trace drift (2026-07-21 continuation)
- `#155` root cause fixed **surgically**: WhatsApp's `LiveMessage` (`plugins/whatsapp/lib/stream.mjs`) was a
  stripped copy that handled only the tool CALL line and silently dropped tool **results, diffs, sub-agent
  panels and retry/compaction notices**, and never folded same-signature failures. It now drives the SAME
  shared transport-neutral engine Discord/Telegram use (`_shared/liveTrace.mjs`: `foldedCalls`/`toolLinesFor`/
  `outputSummary`/`diffSummary`) through a WhatsApp `style` + `resolveDisplaySettings`, handling the full
  event set (`tool`/`tool_progress`/`tool_output`/`diff`/`tool_end`/`subagent`/`notice` + lifecycle rows).
  Live-trace e2e written FIRST (`tests/plugins/whatsappLiveTrace.test.ts`, 4 cases) — it failed against the
  old renderer, passes now. **Touched WhatsApp files ONLY** — Discord/Telegram (both working) are untouched,
  so zero regression risk to them.
- **Deliberately NOT done** (scope): the larger `_shared/liveMessage.mjs` extraction that would also dedupe
  Discord+Telegram's near-identical `EditableMessage`/`StreamingAnswer`/transport, and the
  `resolveImageFiles`/voice/`footerLine`/`buildReplyContext` helper dedup. Those are a DRY refactor of two
  WORKING plugins on untyped `.mjs` — supervised-session material; the user-facing bug (WhatsApp dropping
  events) is fully resolved without that risk.

### Supervised refactors (2026-07-21 continuation — DONE, each its own commit)
Every RISKY decomposition the review deferred was completed with a subagent per part, verified with the full
suite + relevant e2e, and committed separately so any one reverts alone:
- `BrainDelegationStore` extracted behind the BrainStore facade (`30258e80`) — the second BrainStore slice.
- `ConfigStore` field-mapping consolidated conservatively (`19d0fb45`) — sanitizers + the fresh-vs-upgrade
  `plugins.enabled` asymmetry left explicit and untouched.
- `spawner.spawn` event reducer extracted into `createSpawnEventReducer` (`58d42c3f`) — characterization
  tests written FIRST, pass before and after the verbatim move.
- `channels.send` pre-lock steer path extracted (`871ce48c`) — verbatim block move, every abort fence keeps
  its exact position vs its await; the TOCTOU-critical withLock body untouched; new characterization cases.
- `startLoops` sweep bodies extracted to named functions (`bbc2e935`) — buildApp's load-bearing dependency
  assembly left untouched (realistic win was startLoops: 221→128 lines).
- `_shared/liveMessage.mjs` shared engine extracted for Discord+Telegram (`a2658e6d`) — 889 duplicated lines
  → 439 shared; per-surface parts (image strategy, reply refs, style, chunk size) stay per-plugin; WhatsApp
  and the liveTrace core untouched; all three roundtrips pass.

## ⏳ Deferred — what genuinely remains

- **SSOT tail — assessed, NOT worth it**: the daemon `Task` (store row, `outcome: string`) and web's `Task`/
  `TaskOutcome='ok'|'fail'` (a narrower view) are NOT duplicates of one DTO. Moving them to `src/shared` is
  either cosmetic relocation of web's copy (no dedup) or a risky tightening of the store row type; a real win
  needs a wire-contract for the task REST/SSE shape (its own task). `SlashCommandDef` (the clean part) is done.
- **Other RISKY items left in `quality.md`** (own supervised passes): `#6`/`#7` interruptQueued move +
  lifecycle respawn extraction, `#16` PlanService consolidation, `#20`/`#21`/`#22` CLI `chatComposition` split.
- **Informational (not bugs)** — test-fakes shipping in the `dist/` tarball and ~30 test-only exported
  constants; `MemoryStore.getEmbedding` kept for coverage.

## Note on models
The 5 review agents ran with the `model: "fable"` parameter this session (dead-code, security, bugs,
single-source-of-truth, quality). Findings came back 17/19 bug findings CONFIRMED with two scope
corrections and one new user-visible HIGH (`web/lib/cron.ts`), all captured in the per-category docs.
