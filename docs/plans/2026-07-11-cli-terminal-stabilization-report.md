# CLI/TUI terminal stabilization report

Date: 2026-07-12
Scope: `src/cli/chat`, PI TUI integration, terminal lifecycle, streaming admission, LSP diagnostics,
and PI-native context compaction

## Outcome

The interactive CLI now has one frame owner, one terminal-lifecycle owner, one layout allocation, and a
viewport-oriented transcript. A physical root frame is constrained to the current terminal before PI's
diff renderer sees it. Ordinary scrolling and streaming stay bounded by the visible window instead of
the number of settled turns, and an idle chat has no permanent render loop.

The existing UX remains present: start screen, Markdown and tool output, Thoughts and expand/collapse,
diffs, Todos/cards, sub-agent drill-in, queued messages, attachments, slash/file suggestions, pickers,
plan/build mode, telemetry, mouse and keyboard scrolling, thumb dragging, drag-to-copy, external editor,
alternate screen, session switching, and compaction.

## Verified root causes

1. **No single physical layout invariant.** Several components independently reserved fixed/minimum
   heights. During a tool burst, multi-line input, resize, ask dock, cards, queue, and telemetry could
   produce more rows than `terminal.rows`. PI then diffed an impossible root, leaving stale rows, a white
   reverse-video band, a duplicated footer, or a displaced/missing editor that persisted after reload.
2. **Fragmented render ownership.** SSE events, resize, thinking, overlays, and the 33 ms mascot timer
   could each prepare the entire UI. Requests were neither consistently coalesced nor aligned with PI's
   own render clock.
3. **Whole-history work on viewport events.** Scroll rebuilt or copied flattened transcript state and
   could Markdown-render settled turns. Long-session cost therefore grew with history depth.
4. **Incomplete virtual-scroll geometry.** Cold turns were not represented consistently in painted,
   hit-tested, and dragged scrollbar geometry. The thumb could disappear before the older prefix was
   indexed; a stationary drag could also stall after one bounded batch or jump when grabbed off-centre.
5. **PI overlay clipping was treated as layout.** PI slices an overlay's returned rows to `maxHeight`;
   it does not preserve the important bottom controls. Oversized slash/mention/ask/telemetry content was
   therefore cut at small heights.
6. **Terminal text and diff boundaries were porous.** Root and overlay lines did not share one control-
   sequence/width boundary, and redundant exact-width truncation could disturb terminal attributes.
7. **Lifecycle and async ownership were split.** Alternate-screen, mouse modes, input/resize listeners,
   external-editor suspend/resume, local processes, streams, and late bootstrap publications could
   outlive one another. Shutdown during bootstrap could even mount fresh terminal owners after teardown.
8. **Unrelated transport failures amplified the visual symptoms.** `POST /brain/send` waited for a full
   model/tool turn, so a proxy timeout surfaced as `[error: fetch failed]` after Diagnostics. Parallel
   LSP requests considered a server warm before its first real diagnostic verdict, giving siblings a
   too-short timeout.
9. **Compaction selected an unstable deployment indirectly.** ChatGPT OAuth may expose a selected
   preview alias unsuitable for summary requests. The route is now resolved before the session starts:
   only PI's own compaction signal uses the same configured provider's distinct default model, while
   normal chat stays on the exact selected model. There is no error-string retry loop or custom
   summarizer outside PI.

## Architecture after remediation

- `RenderShell` is the sole render sink. It records every reason, merges same-window requests, delegates
  the physical clock to PI, and uses forced repaint only for geometry/lifecycle/overlay transitions.
- `computeLayoutBudget()` allocates header, transcript, cards, sub-agents, queue, attachments, editor,
  status, hints, ask/Todo priority surfaces, and the telemetry rail once per frame. `constrainFrame()`
  enforces exact row and visible-width bounds, with a stable tiny-terminal fallback.
- `ChatViewport` stores per-turn chunks plus a dynamic height index, a bounded row LRU, sparse revision
  reconciliation, and streaming-tail invalidation. It materializes only the visible window plus bounded
  overscan. Plain rows for selection are retained only for the current window.
- Cold history has estimated visual geometry from the first frame, so the scrollbar remains visible and
  clickable while older Markdown is still lazy. Wheel/PageUp/PageDown and thumb continuation index only
  bounded batches; the pointer-to-thumb grab offset is preserved.
- `OverlayController` owns every native PI overlay and reflows it after the root geometry is prepared.
  Suggestion, ask, picker, and telemetry components budget their own content rather than relying on PI's
  top-only clip.
- `TerminalLifecycle` alone owns alternate screen, raw mode, mouse 1000/1002/1006, resize/input listeners,
  start/suspend/resume/stop, and diff reset. `ChatApplicationLifetime` fences detached work; bootstrap has
  stop guards after each async boundary. Local child trees have bounded platform-specific termination.
- `AnimationController` uses one-shot timers. Thinking ticks at 250 ms; mascot motion ticks at 100 ms
  only while visible and unsettled, is disabled during thinking/hidden/narrow states, and reuses cached
  transcript rows. Idle has zero animation timers.
- Parent stream controller replacement is encapsulated by `StreamCoordinator`; pickers cannot mutate
  `ChatState.streamAc`. Session switches invalidate old publications and reset semantic viewport state.
- `ELOWEN_TUI_DEBUG=1` and `ELOWEN_TUI_PERF=1` write structured JSONL only to an opt-in file (or a safe
  temporary default), never to the active alternate screen. Frames include reasons, phase timings,
  terminal geometry, section heights, transcript/cache/index work, visible rows, root rows/width, PID,
  sequence, and lifecycle records.

## User-visible fixes included

- No white horizontal band or duplicated model/build/hint footer after a one-message chat, tool burst,
  resize, stream, modal, or session reopen.
- Multi-line editor grows automatically and is capped at six content rows by the central budget.
- Short ask/slash/mention menus keep controls visible and scroll their content window.
- Todo clipping renders an underlined clickable `+N more` row and borrows available transcript height
  when expanded.
- Successful tool rows omit the redundant `[exit 0]`; errors remain visible.
- Telemetry Context and rate-limit meters use the same `█/░` style. Vertical budgeting protects Context
  and Project before optional sections/mascot, and hides the rail when it cannot fit.
- Diagnostics requests are independently queued until the LSP publishes a real verdict; a busy cold
  TypeScript server no longer makes parallel siblings silently time out.
- Brain send returns HTTP 202 only after durable admission and authoritative user echo. Post-admission
  failures travel through SSE; headless mode waits for ordered `idle`/`error` rather than a 300 ms guess.

## Deterministic performance

All figures below are fresh on Node v22.23.1 with no parallel test/agent load, 20 pipeline samples and
40 viewport samples per operation. The baseline is the characterization run recorded before production
replacement work.

### Complete BrainEvent-to-frame pipeline

| History turns | Metric | Baseline | Final |
|---:|---|---:|---:|
| 200 | reducer avg / p95 | 0.252 / 1.133 ms | 0.067 / 0.189 ms |
| 200 | event-to-frame avg / p95 | 2.778 / 5.794 ms | 0.451 / 0.870 ms |
| 10,000 | reducer avg / p95 | 0.124 / 0.158 ms | 0.008 / 0.014 ms |
| 10,000 | event-to-frame avg / p95 | 1.341 / 1.404 ms | 0.118 / 0.145 ms |
| 40,000 | reducer avg / p95 | 0.645 / 0.691 ms | 0.007 / 0.010 ms |
| 40,000 | event-to-frame avg / p95 | 1.822 / 1.847 ms | 0.100 / 0.124 ms |

Every measured final event visits one reducer turn and one viewport turn, reconciles one turn, renders
zero settled turns, and performs zero layout visits. The result does not grow with 10k/40k history.

### Viewport scroll and streaming tail

| Transcript turns | Operation | Baseline avg / p95 | Final avg / p95 / max |
|---:|---|---:|---:|
| 201 | scroll | 3.148 / 4.397 ms | 0.442 / 1.113 / 2.890 ms |
| 201 | streaming tail | 3.293 / 5.096 ms | 0.719 / 0.975 / 2.448 ms |
| 2,001 | scroll | 3.497 / 7.061 ms | 0.210 / 0.323 / 0.802 ms |
| 2,001 | streaming tail | 3.251 / 7.557 ms | 0.540 / 0.735 / 3.963 ms |
| 10,001 | scroll | 12.508 / 21.433 ms | 0.205 / 0.323 / 0.609 ms |
| 10,001 | streaming tail | 12.214 / 17.606 ms | 0.505 / 0.593 / 5.873 ms |

The 10,001-turn cold initial frame is 4.490 ms versus 730.858 ms in the baseline. Scroll performance is
effectively viewport-bound and every ordinary deterministic sample is well below the 16–33 ms target.

## Automated verification

- Full Vitest JSON report: **3,182/3,182 tests passed**, no skips or failures.
- tmux evidence analyzer unit/mutation suite: **28/28 passed**.
- `npm run lint`: exit 0, zero errors; one pre-existing unrelated hook warning in
  `web/modules/users/UsersView.tsx:88`.
- `npm run typecheck`: pass.
- `npm run deadcode` (Knip): pass.
- `npm run depcruise`: pass; 822 modules and 3,241 dependencies, no violations.
- `npm run build`: pass.
- Independent read-only release audit: READY, no remaining Critical/Important ownership, lifecycle,
  timer, listener, duplication, or dead-code finding.

## Real tmux release evidence

The release runner builds once, creates a fresh isolated tmux server for every scenario, and executes two
distinct rounds only after the documentation/integration commit. This ordering binds all evidence to the
exact deployed Git HEAD and a SHA-256 of every built `dist` byte. The authoritative aggregate is stored
outside Git at `.artifacts/cli-tui-final/final-summary.json`; individual plain/ANSI captures, state JSON,
raw perf JSONL, terminal writes, restored shell, and exact TTY states sit beside it.

Each round requires short, long, and signal scenarios. The analyzer re-runs every capture contract from
raw evidence and rejects stale/missing/duplicated paths, symlink escapes, partial JSONL, report/perf drift,
capture-frame drift (full payload plus PID/sequence/time), lifecycle/PID mismatch, non-canonical roots,
wrong commit/dist hash, reused run IDs/tmux servers, or an ordinary frame at/over 50 ms.

The scenarios cover:

- the reported one-message white-line/footer/scrollbar regression;
- hundreds of transcript lines, rapid streamed tool/diagnostic bursts, queue updates, and long-history
  operation bounds;
- 20x10, 32x12, 40x15, 80x24, the telemetry 103/104-column threshold, 120x30, and 180x50;
- wheel, PageUp/PageDown, red-thumb drag beside telemetry, drag-to-copy, and input recovery;
- multi-line editor, slash/mention/help/ask surfaces, Todo expansion, queued message, telemetry show/hide,
  generic modal, and external-editor suspend/resume;
- normal quit, SIGTERM, and SIGHUP with exact TTY restoration, readable shell, all mouse modes disabled,
  alternate screen exited, and no stale primary-buffer frame.

## Remaining limitations

- Forced geometry/lifecycle frames may exceed 50 ms on a slow terminal; they are deliberately excluded
  from the ordinary-frame target and are reported separately. Ordinary interaction still fails closed at
  50 ms in the release analyzer.
- PI does not expose a separate hardware dirty region for the telemetry mascot. Elowen therefore uses
  cached transcript frames plus a slower, finite one-shot animation. Correctness and scrolling take
  priority, and no mascot timer exists when hidden, narrow, thinking, settled, paused, or stopped.
- The live daemon, SQLite persistence, and PI in-memory queue cannot be one hardware-atomic transaction.
  Admission ordering and rollback cover ordinary partial failures, while an external machine/process
  loss can still interrupt any application between durable operations.
