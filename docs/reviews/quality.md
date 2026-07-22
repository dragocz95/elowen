# Quality / maintainability review — 2026-07

Three area agents (cli · store/api/daemon · brain). Micro-level hygiene is consistently strong
across the whole codebase: essentially no `any` (single digits, all in guarded boundary code),
no `@ts-ignore`, no TODO/FIXME/commented-out code, dense *rationale* comments. The debt is
**structural** — a handful of oversized single-function files, and one inconsistent validation
convention. Ordered by leverage.

---

## Highest leverage (cross-cutting)

1. **`buildApp()` god-function (~550 lines) + `startLoops` (~220)** — `src/daemon/bootstrap.ts:144-694`,
   `:726-946`. Constructs every store, seeds users/VAPID/LSP, wires the **Deriver decision engine inline**
   (`decideApproval` `:302-325`, `decideQuestion` `:330-354` — real business logic), builds brain/registry/
   marketplace/restart handler, then ~15 `setInterval` sweeps with inline bodies (`checkWorker` `:825-855`,
   `restartWorker`, `replan` `:912-933`). Nothing here is unit-testable in isolation.
   Fix: extract `buildStores`/`buildOverseer`/`buildBrain`/`buildPluginProvider`, move decision callbacks
   into `overseer/decision.ts`, move sweep bodies into `overseer/`. Target: `buildApp` ~80 lines.

2. **Two parallel input-validation conventions at the API boundary** — a clean zod layer exists
   (`src/api/validation.ts` `parseBody`, `src/api/schemas/*`), yet **26 handlers bypass it** with
   `(await c.req.json().catch(() => ({}))) as {...}` + hand-rolled `typeof` ladders. Counts: `routes/brain.ts`
   14, `routes/plugins.ts` 8, `routes/auth.ts` 3, `routes/tasks.ts` 1. Reviewers can't assume inputs are
   validated. Fix: route each through `parseBody` with a small zod schema; do `brain.ts` first.

3. **`BrainStore` (1221 lines) spans ~9 sub-domains** — `src/store/brainStore.ts`. One class holds sessions,
   messages + compaction, cards, terminals, subagent runs, subagent results, workflows, session events, goals,
   **and** the entire usage-accounting engine (`USAGE_ROWS` + `rollupDroppedUsage` `:306-344` + `usageBy*`
   `:463-575`). 95 `db.prepare` calls. Fix: split into `BrainSessionStore` / `BrainMessageStore` /
   `BrainDelegationStore` (runs/results/workflows) / `BrainUsageStore` — they share only `Db`.

---

## src/brain (structural)

4. **`spawner.spawn` — 337-line god-function with embedded event-reducer state machine** —
   `src/brain/service/spawner.ts:87-423`; the inline `session.subscribe` handler (`:233-404`) juggles
   `deferredCompacted`/`deferredOverflowError`/`terminalIdleDeferred`/`agentRunOpen` across ~170 lines of
   `if (raw === '…')` branches. Fix: extract a named `SpawnEventTranslator` class (one method per raw event,
   deferral flags as fields) + pull pre-session assembly (persona/tools/request profile) into helpers.

5. **`ChannelSessionService.send` — 278-line multi-path god-function** — `src/brain/channels.ts:194-472`.
   Steering fast-paths (`:206-257`) and the locked main path (`:258-472`) are effectively two functions
   sharing one signature. Fix: split into `steerIntoRunningTurn()` / `rolloverIfIdle()` / `runChannelTurn()`.

6. **`brainService.ts` (1189 lines) — facade that still owns business logic** — most methods delegate, but
   `interruptQueued` (`:333-401`, full queue-snapshot/abort/promote/re-steer algorithm), `start` (`:805-841`,
   daemon-restart orphan reconciliation for sub-agent + workflow runs), `delegatedContinuation`/`sendDelegated`
   (`:869-943`) carry real orchestration. Fix: move `interruptQueued` into `turnRunner`, restart-reconciliation
   into `lifecycle`/a `bootReconciliation.ts`.

7. **`service/lifecycle.ts` (517 lines) bundles too many concerns** — session-id resolution, empty-conversation
   pruning, start/ensureLive/switchModel, rollover (`:342`), vision-model hopping (`:383-433`), subscribe/tap
   plumbing (`:435-498`). Fix: extract `respawnStrategies.ts` (rollover + vision-hop) and `listenerAttachment.ts`.

8. **`turnRunner.send` (182 lines)** — `src/brain/service/turnRunner.ts:236-418` interleaves addressing
   (double `assertClientCurrent` re-checks), reasoning-marker flushing, mode-change detection, parent-abort
   fencing, steering decision, execution, post-turn goal-judge + subagent-drain. Fix: extract `resolveTurnTarget()`
   + `recordModeChange()`; keep `send` as the loop skeleton.

9. **`TranscriptModel.apply` — 186-line switch** — `src/brain/transcriptModel.ts:139-325`. Reducer, so a big
   switch is defensible, but peel the heavier cases (`tool`/`subagent`/`workflow`) into private methods.

10. **Giant inline structural return types duplicated** — `status(...)` declares the same ~15-field return type
    inline in both `brainService.ts:580` and `statusService.ts:184`; `listManagedSessions` similarly
    (`brainService:742` / `statusService:260`). Fix: name them (`BrainStatusView`, `ManagedSessionView`) once.

11. **`InternalTurn` should be a discriminated union** — `src/brain/service/turnRequest.ts:11`
    (`{ goalKickoff?; goalContinue?; systemNudge? }`) tested longhand at `turnRunner.ts:286/291/298/416`;
    nothing prevents illegal combos. Fix: `type InternalTurn = { kind: 'goalKickoff'|'goalContinue'|'systemNudge' }`.

12. **Lone genuinely-unsafe cast into PI internals** — `src/brain/session/compactionCheckCoordinator.ts:29`
    (`session as unknown as PiCompactionSession`), the only double-cast reaching an undocumented shape (the
    `toolPermissions.ts:67-137` casts are `typeof`-guarded and fine). Fix: minimal structural interface + runtime assert.

---

## store / api / daemon (structural)

13. **`ConfigStore` duplicates every field's mapping across ~7 sites** — `src/store/configStore.ts`: `ElowenConfig`
    (`:41-78`), `Stored` (`:268-294`), `ConfigPatch` (`:324-344`), `DEFAULT_CONFIG` (`:247-266`), `defaultStored()`
    (`:303-322`), the ~63-line `read()` shape-checker (`:349-412`), `get()` (`:419-443`), `update()` (`:480-558`).
    Adding one setting = editing 7 places in lockstep. Fix: describe fields once as `{ default, sanitize, isSecret }`
    and drive read/get/update from it (or at least extract per-block helpers).

14. **`routes/plugins.ts` (792 lines) bundles 8 admin sub-APIs** — `src/api/routes/plugins.ts:34-792`: plugin CRUD,
    MCP control, marketplace, cron-jobs file editor (`:346-439`), skills editor (`:444-571`), sub-agents editor
    (`:578-666`), Discord channel fetch, WhatsApp pairing, brain OAuth. Fix: split into `routes/plugins/{index,
    cronjobs,skills,agents,oauth}.ts`.

15. **`routes/brain.ts` (799 lines, ~40 handlers)** — inlines a ~100-line SSE state machine (`:698-798`) and repeats
    `if (!d.brain) return 503; if (forbidden(c)) return 403;` ~40×. Fix: extract `brain/session/sseStream.ts` +
    a `brainGuard` middleware / `withBrain(handler)` wrapper.

16. **`routes/tasks.ts` plan/replan logic duplicated inline** — `/tasks/plan` (`:401-475`) and
    `/tasks/:epicId/phases` (`:503-557`) write the relay-vs-pilot decompose flow almost verbatim twice, though a
    `PlanService` exists. Fix: move the shared "run a plan job" body into `PlanService`.

17. **Raw-SQL scattering + `SELECT * … as XRow` casts** — ~90 sites across `src/store/*` trust the DB shape;
    JSON columns parsed + re-validated ad hoc. Not urgent; for hot tables introduce `rowToBrainSession`/`rowToMemory`
    mappers and prefer explicit column lists. Also the three hand-rolled `normalize*` validators
    (`brainStore.ts:131-240`) reimplement what zod does one layer up.

18. **`taskForSession` full `tasks.list()` scan on every call, in hot sweep paths** — `src/daemon/bootstrap.ts:264-268`,
    consumed by `sessionProject`/`missionIdForSession`/deriver/janitor/per-minute liveness sweep. O(sessions × tasks).
    Fix: indexed store lookup (`tasks.byAgentLabel(name)`) or memoize per sweep tick.

19. **Repeated `as never` / structural-cast escapes** — `plugins routes plugins.ts:717`
    (`registry?.platforms.find(...) as never`), `routes/brain.ts:163-164` (`denyNonOwner` casts `c` twice).
    Fix: typed adapter control interface (extend the `KnownControls` pattern from `plugins/api.ts:240` to platforms).

---

## src/cli

The `src/cli/chat` area is the most concentrated maintainability debt (transcribed from the cli agent):

20. **`chatComposition.ts` is a ~1058-line god-file** — the top structural offender.
21. **`commands.ts` `onSubmit` is a ~374-line megaswitch** over slash commands.
22. **`ChatInputContext` 30-member back-channel** — a large implicit-coupling surface.
23. **Positional boolean flags** in several call sites (readability/foot-gun).
24. **`BrainClient` boilerplate duplication** across request methods.

---

## Explicitly noted as good (no action)

- `plugins/api.ts` (407 lines) is almost entirely interface + doc comments — a well-documented contract module.
- `lsp/client.ts`, `store/memoryStore.ts` are well-factored despite line count.
- `src/brain/modelCapabilityData.ts` (2223 lines) is a `GENERATED FILE` (`npm run models:refresh`), correctly excluded.
- `db.ts` migration ledger (`:29-127`) + `runOnce` v1–v6 chain are clearly marked/self-documented; the tool-rename
  v1–v4 runners are known-temporary (see memory note) and can be retired once no pre-rename DBs remain.

---

## Fable verification + execution order (2026-07-20)

All findings HOLD at current HEAD. Classified SAFE (mechanical, contained, low regression risk)
vs RISKY (large diff into hot correctness paths, thin/no direct test coverage). New findings:
**N1** usage-snapshot expression duplicated 7× (`spawner.ts:260/281/370/378`, `channels.ts:437`, …) →
`sessionUsageSnapshot` helper; **N2** last-assistant scan `[...messages].reverse().find(role==='assistant')`
~11× across 8 files → `lastAssistant` helper; **N3** thinking-only-nudge block duplicated
(`turnRunner.ts:353-357` / `channels.ts:430-434`). Corrections: `#19` `denyNonOwner` cast already fixed
(only `plugins.ts:717` `as never` remains); `#20` `chatComposition.ts` grew 1058→**1357** lines.

**Overnight-safe order (autonomous):**
1. `#10` name `BrainStatusView`/`ManagedSessionView` (removes 4 duplicated inline types)
2. `#11` `InternalTurn` discriminated union (3 construction sites: `goalLoop.ts:122/173`, `bootstrap.ts:618`)
3. `N1` `sessionUsageSnapshot` helper (7 sites)
4. `N2`+`N3` `lastAssistant` helper (~11 sites) + optional nudge helper
5. `#24` `BrainClient.get<T>()` (~15 hand-rolled GETs)
6. `#15a` `withBrain(handler)` guard dedup in `routes/brain.ts` (36 sites; leave the SSE handler)
7. `#2` zod migration, `routes/brain.ts` first — **flag: malformed JSON now 400s instead of defaulting**; add per-schema tests
8. `#9` `TranscriptModel.apply` case-peeling (pure reducer, 531-line test)
9. `#14` `routes/plugins.ts` file split (identical paths)
10. `#3a` extract `BrainUsageStore` behind the `BrainStore` facade (no caller changes) — first slice only
11. `#1a` move `decideApproval`/`decideQuestion` into `overseer/decision.ts`, sweep bodies into `overseer/` (verify: bootstrap has near-zero direct coverage)
12. `#8a` extract `resolveTurnTarget()` + `recordModeChange()` from `turnRunner.send`
13. `#18` memoize `taskForSession` per sweep tick
14. `#12` compaction-coordinator structural interface (cosmetic)

**Defer to supervised sessions (RISKY):** `#4` spawner reducer (hottest correctness path, no direct unit
test — write characterization tests first), `#5` `channels.send` (10 abort-fences at TOCTOU-exact awaits),
`#1` full `buildApp` decomposition (boot wiring untested), `#13` `ConfigStore` table rewrite (deliberate
`plugins.enabled` fresh-vs-upgrade default asymmetry with an explicit do-not-reconcile warning), `#3` full
`BrainStore` 4-way split, `#6`/`#7` `interruptQueued` move + lifecycle respawn extraction, `#16` `PlanService`
consolidation, `#20`/`#21`/`#22` CLI (`chatComposition` now 1357 l. — schedule soon).
