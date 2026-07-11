# CLI Terminal Review Remediation Design

**Status:** Approved by the user's request to fix every independent review finding.

## Goal

Close the remaining terminal-control injection paths, preserve constant-size transcript reconciliation when several stream events are coalesced, make the visible progressive scrollbar draggable, and run the real tmux regressions in CI.

## Terminal trust boundary

Every string originating outside Elowen's own theme/layout code is untrusted terminal text. It may carry printable Unicode and Markdown syntax, but it may not directly contribute CSI, OSC, DCS, APC, PM, C0, or C1 control sequences.

The existing `terminalPlainText()` remains the canonical projection for content before Markdown/wrapping/styling. Transcript user text, assistant text, reasoning, plans, tool metadata, notices, cards, queues, attachments, approvals, sub-agent data, processes, titles, telemetry metadata, and picker values cross this boundary at their reusable leaf renderer. The final root frame additionally applies an ANSI allow-list that preserves Elowen-owned SGR, PI's cursor marker, and renderer-owned OSC 8 hyperlinks while removing every other terminal control sequence. This final pass is defense in depth for future components, not a replacement for leaf projection because tabs and carriage returns must be normalized before layout measurement.

Drag-to-copy derives plain rows through the complete plain-text projection, so SGR and OSC 8 metadata cannot enter OSC 52 clipboard payloads.

## Coalesced transcript changes

`ChatView` metadata becomes a predecessor-linked WeakMap chain. Each reducer output records its predecessor and the smallest changed suffix for that single mutation. `ChatViewport` asks for the accumulated change since the exact view it last reconciled; walking the chain costs O(number of coalesced events), not O(history size).

The accumulated result is either reset, no change, or `suffix(from)`. A suffix reconciliation preserves every entry before `from`, discards only affected cached entries, and appends/replaces the current suffix. Externally constructed views without metadata retain the conservative reference-scan fallback.

## Progressive scrollbar dragging

An estimated visible thumb is also a hit target. On press/drag, the viewport indexes a bounded number of older turns within a small time budget. Short and ordinary histories become exact immediately and use exact ratio mapping. Very long histories advance progressively: each drag event indexes another bounded chunk and clamps movement to the exact rows already known, avoiding one unbounded Markdown pass.

Wheel and PageUp/PageDown keep their exact bottom-relative semantics. The estimated thumb never claims exact random access until the prefix is indexed.

## CI and verification

Package scripts expose a built-artifact tmux command. Local `test:cli-tmux` builds once and delegates to it; GitHub Actions already builds and installs tmux, so it runs the built command without rebuilding.

Required regression evidence:

- raw model/user/reasoning/approval/card/queue data cannot emit CSI/OSC terminal controls;
- Markdown syntax and renderer-owned styling/hyperlinks remain functional;
- selected Markdown hyperlinks copy as plain text;
- a 10,000-turn view receiving `user -> text -> tool` before one render reconciles only the changed suffix;
- the incomplete-history scrollbar accepts a drag, ordinary history becomes exact, and huge history indexing is bounded per event;
- short and long tmux scenarios pass locally and in CI.

## Commit boundaries

Each completed logical change is committed independently: repository policy, design/plan, terminal trust boundary, coalesced change tracking, scrollbar drag, and CI wiring. Unrelated `web/` worktree changes remain outside every commit.
