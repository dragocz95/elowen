# CLI Architecture Rewrite Implementation Plan

> **For agentic workers:** implement one task at a time with TDD, commit every completed task, and
> return a report containing commands and exact test results. Never touch unrelated web work.

**Goal:** Replace the fragile chat internals with bounded, indexed, single-owner modules while
preserving CLI UX and wire/storage behavior.

**Architecture:** Build the new transcript, viewport, hydration and shell modules beside the legacy
graph, then switch `runChat()` once and delete the old graph in that same integration task. Brain turn
internals are refactored independently behind unchanged REST/SSE contracts.

**Tech stack:** TypeScript ESM, Node 22, Vitest, `@earendil-works/pi-tui`, SQLite, Hono REST/SSE.

## Global constraints

- Preserve all existing CLI features, keybindings, visuals, REST/SSE payloads and stored sessions.
- No database migration, web change, push or npm publish.
- History timeout is 10,000 ms; hydration buffer limits are 2,048 events and 4 MiB.
- Steady transcript events visit at most one turn; height updates/lookups are O(log n).
- Idle CLI owns no permanent render or animation timer.
- Every completed logical task is committed and independently reviewed.

### Task 1: Characterization and whole-pipeline baseline

- Add a deterministic benchmark for `BrainEvent -> transcript apply -> state selection -> viewport render` at 200, 10k and 40k turns.
- Add characterization tests for current layout, overlay, input, parent/child stream, terminal lifecycle and all audited dead-code call sites.
- Prove the new tests fail only for the intended O(history), unbounded hydration and sparse-height behaviors before implementing replacements.
- Run focused tests and commit `test(cli): characterize chat architecture rewrite`.

### Task 2: Indexed TranscriptModel

- Introduce a model with `revision`, `turnCount`, `turnAt`, `apply`, `replaceHistory`, `changesSince`, `subagents` and `lastAssistantText`.
- Maintain an O(1) tool-location index, incremental sub-agent projection and bounded change journal.
- Replace production reducer callers; remove history cloning for notice/token events and backward tool scans.
- Cover reset, compaction, streaming, tool output, old sub-agent patch and 40k-turn operation counts.
- Commit `refactor(cli): introduce indexed transcript model` and obtain task review.

### Task 3: Fenwick-backed virtual viewport

- Add a dynamic Fenwick height index supporting append/growth, point updates, prefix sums and offset lookup.
- Convert `ChatViewport` to the transcript read interface and Fenwick index while retaining lazy tail indexing, row LRU, expansions, scroll/drag and copy selection.
- Remove prefix arrays/delta maps and test randomized sums plus 1,200 old-turn height changes.
- Commit `refactor(cli): replace transcript height index`.

### Task 4: Bounded SnapshotHydrator

- Add combined lifecycle/timeout signals and a replay buffer capped at the global limits.
- Use one hydration state machine for parent snapshot/refetch and child drill-in/fallback.
- On timeout retain the last valid state and notice; on overflow abort stale GET and request a fresh snapshot; fence every async publication by generation.
- Test never-settling history, event/byte overflow, reconnect, compaction, session switching and teardown.
- Commit `fix(cli): bound transcript hydration` and obtain concurrency review.

### Task 5: New ChatApplication shell

- Introduce `ChatApplication`, `ChatState`, `RenderShell`, `InputRouter`, `OverlayController` and `AnimationController`.
- Split viewport/turn rendering, telemetry/start components and shared suggestion overlay into focused modules.
- Make layout allocation the sole row-cap policy; remove stateful duplicate queue caps and duplicate inline-text helpers.
- Restrict frame priorities to interactive/normal and keep animation timers self-canceling.
- Preserve all mouse, keymap, modal, external-editor, telemetry and tiny-terminal behavior.
- Commit `refactor(cli): replace chat application shell`.

### Task 6: Brain turn request and admission services

- Replace positional send/startSend arguments with the approved `TurnRequest` object across every caller.
- Extract `TurnAdmission` and `TurnContextBuilder` while preserving PI-native preflight, steering, title, rollback, goal and post-admission error semantics.
- Keep API schemas/routes and database shape unchanged; update focused service/API/headless tests.
- Commit `refactor(brain): encapsulate turn execution` and obtain admission review.

### Task 7: Entrypoint switch and legacy deletion

- Switch `runChat()` to the new application graph and remove the old runtime/shell/layout/stream implementation in the same commit.
- Remove audited dead code and redundant exports: old allocator, pure transcript helpers, plain-text fallback, scheduler background branch, LSP fresh result, test-only accessors and internal-only public methods.
- Ensure Knip and dependency-cruiser see one production architecture, not adapters or parallel paths.
- Commit `chore(cli): remove legacy chat architecture` and obtain broad branch review.

### Task 8: Final verification, report and deploy

- Run focused suites, full Vitest, lint, typecheck, deadcode, dependency-cruiser and build.
- Run the whole-pipeline benchmark and two consecutive built tmux E2E rounds; machine-check all established terminal scenarios.
- Fix every Critical/Important final-review finding, rerun affected and full gates, and commit the verification report.
- Integrate the worktree branch into `feat/living-webui`, rebuild CLI, restart `elowen-daemon` and `elowen-web`, verify health/web/logs/global version and run an isolated real tmux smoke.
