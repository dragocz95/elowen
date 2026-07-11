# CLI Terminal Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every blocking/important CLI terminal review finding and restore draggable progressive scrollbars without regressing frame performance.

**Architecture:** Project untrusted content before layout, accumulate immutable transcript mutations through predecessor metadata, and make incomplete scrollbar dragging progressively exact under a bounded indexing budget. Keep the existing scheduler, layout budget, lifecycle owner, and tmux production path.

**Tech Stack:** TypeScript ESM, `@earendil-works/pi-tui` 0.80.6, Vitest 2.1, Node 22, tmux, GitHub Actions.

## Global Constraints

- Do not stage or edit unrelated `web/` worktree changes.
- Every production behavior change must first have a focused failing test and observed RED result.
- Commit every completed logical change locally; never push or deploy without explicit authorization.
- Preserve Markdown presentation, OSC 8 links produced by the renderer, PI's cursor marker, and Elowen-owned SGR.
- No ordinary frame may perform work proportional to settled transcript history.

---

### Task 1: Complete terminal trust boundary

**Files:**
- Modify: `src/cli/ui/text.ts`
- Modify: `src/cli/chat/layout.ts`
- Modify: `src/cli/chat/components.ts`
- Modify: `src/cli/chat/askFlow.ts`
- Modify: `src/cli/chat/shell.ts`
- Test: `tests/cli/chat/layout.test.ts`
- Test: `tests/cli/chat/components.test.ts`
- Test: `tests/cli/chat/askFlow.test.ts`

**Interfaces:**
- Consumes: `terminalPlainText(input: string): string`.
- Produces: `terminalSafeAnsi(input: string): string`, preserving SGR, OSC 8, and the PI cursor marker only.

- [ ] Add tests rendering assistant Markdown, user text, reasoning, approval questions/options, cards, and queue entries containing `ESC[2J`, OSC title/clipboard, tabs, CR, and backspace. Assert dangerous sequences are absent while Markdown styling remains.
- [ ] Run `npm test -- tests/cli/chat/layout.test.ts tests/cli/chat/components.test.ts tests/cli/chat/askFlow.test.ts` and verify the new assertions fail on raw CSI/OSC.
- [ ] Project untrusted strings with `terminalPlainText()` at reusable leaf renderers before wrapping or Markdown parsing.
- [ ] Implement `terminalSafeAnsi()` as the root defense-in-depth allow-list and apply it before `constrainFrame()`.
- [ ] Replace the selection SGR regex with `terminalPlainText(line)` and add an OSC 8 selection test.
- [ ] Re-run the focused tests and verify GREEN.
- [ ] Commit with `fix(cli): enforce terminal text trust boundary`.

### Task 2: Accumulate coalesced transcript mutations

**Files:**
- Modify: `src/brain/transcript.ts`
- Modify: `src/cli/chat/layout.ts`
- Test: `tests/brain/transcript.test.ts`
- Test: `tests/cli/chat/layout.test.ts`
- Modify: `scripts/tests/cli-render-benchmark.mjs`

**Interfaces:**
- Produces: `getChatViewChange(view: ChatView, since?: ChatView): { kind: 'reset' | 'none' | 'suffix'; from?: number } | undefined`.
- Each WeakMap entry stores `{ previous?: ChatView; change: ChatViewChange }`.

- [ ] Add a 10,000-turn test that folds `user`, `text`, and `tool` events before one render and asserts reconciliation touches only the appended/changed suffix.
- [ ] Run `npm test -- tests/brain/transcript.test.ts tests/cli/chat/layout.test.ts` and verify reconciliation is currently proportional to history.
- [ ] Record predecessor metadata in every `withChange()` call and accumulate the minimum changed suffix until `since` is reached.
- [ ] Store the last reconciled `ChatView` in `ChatViewport`; apply suffix reconciliation without scanning the settled prefix and retain the conservative fallback for unknown views.
- [ ] Extend the benchmark with a coalesced stream burst.
- [ ] Re-run focused tests and benchmark; verify GREEN and history-size-independent reconciliation.
- [ ] Commit with `perf(cli): accumulate coalesced transcript changes`.

### Task 3: Make the progressive scrollbar draggable

**Files:**
- Modify: `src/cli/chat/layout.ts`
- Modify: `src/cli/chat/shell.ts`
- Test: `tests/cli/chat/layout.test.ts`
- Modify: `scripts/tests/cli-tmux-short.mjs`

**Interfaces:**
- `isScrollbarHit(x, y)` recognizes exact and estimated visual thumbs.
- `setScrollFromRow(absRow)` indexes at most a fixed turn count/time budget before mapping the pointer.

- [ ] Change the existing incomplete-history tests to require a scrollbar hit and observable upward movement after drag; add a large-history assertion that one drag does not index the entire transcript.
- [ ] Run `npm test -- tests/cli/chat/layout.test.ts` and verify RED because incomplete history rejects the hit and drag.
- [ ] Share visual scrollbar metrics between drawing, hit testing, and pointer mapping.
- [ ] Add bounded progressive indexing on pointer input; use exact ratio mapping immediately when indexing completes.
- [ ] Extend tmux E2E with SGR mouse press/drag/release on the visible thumb and assert the `History +` chip appears.
- [ ] Re-run layout and tmux tests and verify GREEN.
- [ ] Commit with `fix(cli): enable progressive scrollbar dragging`.

### Task 4: Run real tmux regressions in CI

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run test:cli-tmux:built` for already compiled `dist/`.
- `npm run test:cli-tmux` remains the local build-plus-E2E entry point.

- [ ] Add `test:cli-tmux:built` to run the short and long scripts and make `test:cli-tmux` build once then delegate.
- [ ] Add `npm run test:cli-tmux:built` after daemon tests in CI, where tmux and `dist/` already exist.
- [ ] Run both package scripts locally and verify the built command does not invoke another TypeScript build.
- [ ] Commit with `ci: run deterministic CLI tmux regressions`.

### Task 5: Final gate and re-review

**Files:**
- Review the complete commit range after Task 4.

- [ ] Run focused tests, `npm run lint`, `npm run typecheck`, `npm run deadcode`, `npm run depcruise`, `npm test`, and `npm run build`.
- [ ] Run `npm run test:cli-tmux` at least twice and inspect machine reports/captures.
- [ ] Run `git diff --check` and verify no `web/` paths appear in the new commits.
- [ ] Send the exact base/head SHA range to an independent read-only reviewer.
- [ ] Fix and commit any Critical or Important finding, then repeat the focused gate and re-review.
