# CLI architecture rewrite design

Date: 2026-07-11

## Goal and compatibility boundary

Replace the internal CLI/TUI chat architecture while preserving every user-visible CLI feature,
keybinding, REST/SSE payload, persisted conversation and terminal lifecycle behavior. Internal
TypeScript exports are not compatibility surfaces and may be removed.

## Target architecture

- `ChatApplication` orchestrates lifecycle and composes one writable `ChatState`, a
  `StreamCoordinator`, `RenderShell`, `InputRouter`, `OverlayController` and
  `AnimationController`.
- `TranscriptModel` owns turns, an O(1) tool/sub-agent location index, derived sub-agent state and a
  bounded revision journal. Steady events mutate only one turn; history reset may be O(history).
- `ChatViewport` consumes the model through a small read interface and uses a dynamic Fenwick tree
  for point height updates, prefix sums and offset lookup in O(log n). Lazy cold-history rendering
  and the bounded row LRU remain.
- One `SnapshotHydrator` serves parent and child streams. History reads time out after 10 seconds.
  Hydration buffers are capped at 2,048 events and 4 MiB. Timeout preserves the last valid view;
  overflow aborts stale history and requests a fresh atomic snapshot.
- `RenderShell` is the sole layout/frame owner. `InputRouter` owns keyboard/mouse dispatch,
  `OverlayController` owns PI overlay handles, and `AnimationController` owns decorative timers.
- The central layout allocator is the only row-cap policy. Slash and mention suggestions share one
  renderer, and terminal inline-text normalization has one implementation.
- Brain turns use a `TurnRequest` object. `TurnAdmission` owns hidden persistence, PI acceptance,
  authoritative user echo/title and rollback. `TurnContextBuilder` owns memory/plugin/policy prompt
  assembly. HTTP/SSE/storage contracts do not change.

## Failure and resource invariants

- Before admission, no visible user event is published and every prepared row/mirror is rolled back.
- After admission, failure is published through the ordered replay stream.
- No history request, event buffer, height-delta structure, timer, listener or render queue is
  unbounded.
- A stale generation cannot publish parent or child state.
- Idle TUI owns no permanent render or animation timer.
- Every root frame stays within terminal rows/columns and contains exactly one footer.

## Verification and rollout

Tests instrument work counts rather than rely only on timing: a steady transcript event may visit at
most one turn, and height operations remain logarithmic after 1,200 old-turn updates. A separate
benchmark measures the complete event-to-frame path at 200, 10k and 40k turns. Full static gates,
Vitest, build, two tmux E2E runs and independent reviews are mandatory before the private production
deploy. Deployment builds CLI only, restarts daemon/web, verifies health, HTTP 200, service logs,
global CLI version and an isolated real tmux smoke. No push or npm publish.
