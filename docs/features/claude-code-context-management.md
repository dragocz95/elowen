# Claude Code: Context and Token Management

Domain: context/token budgeting, compaction, tool-result aging, cache-prefix stability, and user-facing reporting.
Source read: `/tmp/claude-code` at commit `6f6f12b37f529488b10e53928dd5508bb93535c7` (2026-05-07).
Compared against: this checkout, release `0.28.24` (public GitHub/npm remain on `0.28.17`), built on `@earendil-works/pi-coding-agent` (PI).

Scope note: PI owns the base agent loop, tool execution, and session persistence; Elowen owns a layer of `transformContext`/extension hooks on top of it (`src/brain/session/*`, `src/brain/continuity/*`). Findings below compare Claude Code's in-process mechanisms against what that combination already provides.

---

## F1 — Tiered context-pressure thresholds (warning / error / autocompact / blocking)

**Claude Code**: `getEffectiveContextWindowSize()` (`services/compact/autoCompact.ts:33-49`) subtracts a reserved-for-summary-output buffer (min of model max-output and 20k) from the model's context window. On top of that, four separate buffers carve out zones: `AUTOCOMPACT_BUFFER_TOKENS=13_000` (`autoCompact.ts:62`), `WARNING_THRESHOLD_BUFFER_TOKENS=20_000`, `ERROR_THRESHOLD_BUFFER_TOKENS=20_000`, `MANUAL_COMPACT_BUFFER_TOKENS=3_000` (`autoCompact.ts:63-65`). `calculateTokenWarningState()` (`autoCompact.ts:93-145`) derives `percentLeft`, and four booleans (`isAboveWarningThreshold`, `isAboveErrorThreshold`, `isAboveAutoCompactThreshold`, `isAtBlockingLimit`) from these, so the UI can show an amber warning well before autocompact fires, and a hard block only very close to the true window edge.

**Elowen/PI today**: PI's compaction settings are `reserveTokens` (default 16384) and `keepRecentTokens` (default 20000) — a single trigger point, no separate warning/error/blocking tiers (`node_modules/@earendil-works/pi-coding-agent/docs/compaction.md:29-41`). Elowen's `installTurnBoundaryAutoCompaction` (`src/brain/session/turnBoundaryCompaction.ts:65-142`) delegates the threshold *decision* entirely to PI's own `_checkCompaction`, just at a safer point in the turn (after tool-batch settlement, not only at `agent_end`). Elowen's `statsOverlay.tsx` shows a live percentage bar but no warning/error tiering.

**Gain from adopting**: a pre-emptive user-visible warning ("context is getting full") a good margin before the hard compaction/block point is genuinely useful for a chat UI where a user is mid-explanation. Currently the user only learns after the fact via the stats overlay.

**Cost/risk**: small — pure derived-state math over token counts Elowen already computes; no change to compaction trigger logic itself.

**Verdict: ADAPT, priority low.** The UI-facing warning tier is worth adding cheaply; the four-buffer internal plumbing is not — PI's single `reserveTokens` threshold is simpler and Elowen doesn't need CC's separate manual-vs-auto blocking distinction.

---

## F2 — Circuit breaker on repeated auto-compaction failure

**Claude Code**: `autoCompactIfNeeded()` tracks `consecutiveFailures` on an `AutoCompactTrackingState` threaded through the query loop, and stops attempting compaction after `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3` (`services/compact/autoCompact.ts:60,67-70,260-265,341-349`). The comment cites a real incident: 1,279 sessions with 50+ consecutive failures, up to 3,272 in one session, ~250K wasted API calls/day fleet-wide.

**Elowen/PI today**: Elowen now wraps PI with `createCompactionCircuitBreaker` (`src/brain/session/compactionCircuitBreaker.ts`). It counts failed automatic compactions per session, cancels further automatic attempts after the live `compactionFailureLimit` (default 3), leaves manual `/compact` available, and reports the terminal condition to the conversation. It also stops threshold compaction when the measured post-compaction floor cannot get below the trigger; this is a separate reachability guard.

**Why it matters**: this protects against the exact failure mode CC hit — an irrecoverably oversized context retrying compaction every turn and burning API cost. The implementation keeps the counter per session, resets it after a successful compaction, and surfaces the terminal condition instead of silently doing nothing.

**Verdict: ADOPTED in 0.28.24.** The guard is per-session, operator-tunable, preserves manual recovery, and reports when automatic compaction is stopped.

---

## F3 — Full-discard compaction with attachment reinjection vs. always-keep-recent-verbatim

**Claude Code**: the primary/auto compaction path, `compactConversation()` (`services/compact/compact.ts:387-763`), discards **every** prior message. It replaces them with: a boundary marker, one summary message (`getCompactUserSummaryMessage`, `prompt.ts:337-374`), then a set of freshly regenerated attachments — up to 5 most-recently-read files re-fetched from disk and truncated to a 50k-token/5k-per-file budget (`createPostCompactFileAttachments`, `compact.ts:1415-1464`), invoked-skill content up to a 25k budget (`createSkillAttachmentIfNeeded`, `compact.ts:1494-1534`), the active plan file, plan-mode instructions, and re-announced tool/agent/MCP deltas (`compact.ts:563-585`). No verbatim recent turns are kept in this path — continuity is reconstructed entirely from the summary text plus these regenerated attachments. A *separate* manual path, `partialCompactConversation()` (`compact.ts:772-1106`), can keep a verbatim tail via `messagesToKeep`, selected by message index.

**Elowen/PI today**: PI's native compaction *always* keeps a verbatim tail — it walks backward from the newest message accumulating `keepRecentTokens` (default 20k), summarizes only what's older, and on repeated compactions the summarized span starts from the *previous* compaction's kept boundary so nothing kept once is ever re-summarized away (`pi-coding-agent/docs/compaction.md:39-79`). Elowen's own reinjection is much thinner: `buildPostCompactionContext()` (`src/brain/continuity/postCompactionContext.ts:71-107`) attaches only the active plan's *text* and a list of touched file *paths* (not content) — plus an explicit instruction to re-read files rather than trust the summary (`postCompactionContext.ts:104-105`).

**Gain from adopting CC's approach**: none, structurally — PI's design (always keep a verbatim recent window, cumulative summarization) is strictly safer for continuity than CC's full-discard path, because it never depends on the model correctly reconstructing "what I was doing" purely from a generated summary plus reattached artifacts. CC's design exists because Anthropic's model-side context window handling doesn't have PI's incremental-compaction primitive; it's a workaround, not a superior architecture.

**Gain from adopting CC's *file-content* reinjection specifically**: real. CC's post-compact attachments restore actual file *content* (up to budget) for recently-touched files; Elowen only restores *paths* and tells the model to re-read. That trades one Read tool round-trip (and its own tokens) for a text instruction. For sessions that touched many files right before compaction, pre-attaching a handful of the most-recent ones' content could save that round trip.

**Cost/risk**: moderate. Requires reading files off disk at compaction time, truncating to a budget, and getting the "avoid stale content" tradeoff right — CC accepts this risk by design (comment: `stale ⇒ model re-reads only if it suspects staleness`), while Elowen's current design deliberately avoids ever risking stale content by never serving cached content post-compact.

**Verdict: SKIP** on adopting CC's full-discard model (Elowen/PI's is better for the stated reason). **ADAPT, priority low** on the file-content-reinjection idea specifically — worth prototyping only if post-compaction "re-read storms" turn out to be a measured cost problem; no evidence of that yet.

---

## F4 — Detailed 9-section compaction summary prompt

**Claude Code**: `BASE_COMPACT_PROMPT` (`services/compact/prompt.ts:61-143`) asks for a structured `<analysis>` scratchpad followed by a `<summary>` with 9 fixed sections: Primary Request and Intent, Key Technical Concepts, Files and Code Sections (with full code snippets and *why* each mattered), Errors and fixes, Problem Solving, **all** non-tool-result user messages verbatim, Pending Tasks, Current Work, and an Optional Next Step that must quote the most recent conversation verbatim "to ensure there's no drift in task interpretation" (`prompt.ts:76-77`). `formatCompactSummary()` (`prompt.ts:311-335`) strips the `<analysis>` scratchpad before it reaches context — it exists only to improve summary quality, not to be read later.

**Elowen/PI today**: PI's built-in summary format is terser: `Goal / Constraints & Preferences / Progress (Done, In Progress, Blocked) / Key Decisions / Next Steps / Critical Context`, plus a `<read-files>`/`<modified-files>` file-tracking block (`pi-coding-agent/docs/compaction.md:219-253`). No equivalent to CC's "verbatim next-step quote" anti-drift technique, no "all user messages" preservation section, no scratchpad-then-strip two-pass structure.

**Gain from adopting**: CC's format targets exactly the failure mode a compaction summary is prone to — losing precise resumption context and drifting into a plausible-but-wrong next step. The verbatim-quote instruction and the exhaustive user-message capture are cheap, concrete mitigations for that.

**Cost/risk**: low, and does not require replacing PI's compaction engine — Elowen already has the seam. `session_before_compact` (used today only for model routing in `compactionModelRoute.ts:32-36`, which deliberately returns `undefined` so PI's native summarization still runs) is exactly where a custom `preparation`-driven prompt could be substituted, per PI's own extension docs (`compaction.md:275-345`).

**Verdict: ADAPT, priority medium.** Cheap to try via the existing `session_before_compact` hook Elowen already has code wired to; the anti-drift techniques are worth borrowing even if PI's shorter format is kept as the default shape.

---

## F5 — Manual partial-range compaction (`/compact` message selector, `from`/`up_to`)

**Claude Code**: `partialCompactConversation()` lets a user or the message-selector UI pick a pivot index and compact only messages before or after it, in either direction (`compact.ts:772-1106`). Direction `from` keeps the earlier prefix verbatim and cache-hits it; direction `up_to` keeps the later suffix, at the cost of the cache (summary now precedes kept messages, so everything after the boundary re-caches). This is explicit user control over *which* part of a long conversation gets compacted, independent of the automatic threshold.

**Elowen/PI today**: no equivalent — compaction is all-or-nothing at the boundary PI's threshold walk picks. There is no UI/command to say "summarize only messages 10–40, keep the rest."

**Gain from adopting**: real but niche — useful for a user who knows a specific chunk of history (e.g. a long debugging tangent that got resolved) is safe to drop, without waiting for or forcing a full auto-compact. Low frequency of use in practice even in Claude Code (it's a power-user feature behind a message picker).

**Cost/risk**: moderate — needs a message-index-addressable UI or command surface, plus wiring a manual override into PI's compaction call with a custom `firstKeptEntryId`.

**Verdict: SKIP, priority low if ever revisited.** Interesting but not load-bearing; PI's automatic cumulative compaction already covers the common case, and building a manual range-picker is speculative UI work with no evidence Elowen users need it.

---

## F6 — Time-based tool-result clearing (idle-gate microcompact)

**Claude Code**: `maybeTimeBasedMicrocompact()` (`services/compact/microCompact.ts:402-517`) fires when the gap since the last main-loop assistant message exceeds a configured threshold (GrowthBook-controlled), on the reasoning that a cold gap means the server prefix cache has already expired, so the *next* request will re-write the full prefix regardless — clearing old tool results now only shrinks what gets rewritten, at zero incremental cache cost. It keeps the last N (`keepRecent`) compactable tool results and content-clears the rest to a fixed marker string, latching the decision so it never reverts.

**Elowen today**: `toolResultClearing.ts` implements essentially the identical mechanism, explicitly modeled on it (`toolResultClearing.ts:12-27`): gated by `cacheColdAtTurnStart()` comparing the last-user-message gap against the cache TTL + 1-minute buffer (`cacheTiming.ts:15-20`), keeping the last `KEEP_USER_TURNS=2` turns and spilling everything older to disk with a write-once (`wx`) latch (`toolResultClearing.ts:47,76,229-322`). The design rationale ("never rewrite history while the cache could still be warm") is stated as the governing invariant in both codebases.

**Gain from adopting**: none — this is already implemented, and Elowen's version additionally spills full content to disk with a Read-tool-recoverable path, which CC's time-trigger path does *not* do (CC's time-based clear has no preview/recovery — content is just gone, replaced by `TIME_BASED_MC_CLEARED_MESSAGE` with no file reference; `microCompact.ts:36,479-483`). Elowen's version is strictly more recoverable.

**Verdict: SKIP — already implemented, and Elowen's is better** (recoverable spill vs. CC's non-recoverable clear-in-place for the time-triggered path).

---

## F7 — Cache-editing microcompact (delete from an *already warm* cache)

**Claude Code**: `cachedMicrocompactPath()` (`microCompact.ts:296-399`) uses an Anthropic cache-editing beta (`cache_edits` API parameter) to delete specific tool results from a cache Anthropic is still serving — no idle gap required. It registers tool results as they're seen, and once a count-based threshold (`config.triggerThreshold`/`config.keepRecent`) is crossed, queues a `cache_edits` deletion block that the API layer sends alongside the request, so the *provider* rewrites its own cached prefix, not the client. This can shrink context **during an active, cache-warm session** — something F6's idle-gate approach structurally cannot do, since F6 only acts once the cache is already cold.

**Elowen today**: no equivalent. Elowen's `toolResultClearing.ts` explicitly documents (in its own header comment) that it only clears when the cache is provably cold, precisely because client-side content rewriting of a warm prefix would break the cache — the exact problem cache-editing solves at the API level instead.

**Gain from adopting**: potentially significant for long-running warm sessions (the daemon's typical usage pattern — long-lived channel conversations, autopilot missions) where the idle gate rarely opens because turns come in steadily. Those sessions currently accumulate tool-result bloat indefinitely between cold gaps.

**Cost/risk**: high uncertainty, not high engineering cost. This depends entirely on whether Anthropic's cache-editing beta is (a) publicly available outside Claude Code's internal access, and (b) exposed through whatever provider abstraction Elowen's Anthropic integration (via PI) uses. If it's an internal-only beta header, this is not adoptable at all. This needs to be verified against current Anthropic API docs before any implementation work.

**Verdict: ADOPT if API-available, priority medium — otherwise SKIP.** Worth a half-day spike to check Anthropic's public `cache_edits`/prompt-cache-editing beta status before committing; do not build against it speculatively.

---

## F8 — Aggregate per-message tool-result budget

**Claude Code**: `enforceToolResultBudget()` (`utils/toolResultStorage.ts:769-909`) is a *second*, independent layer from single-result persistence (F9): it looks at the **sum** of all tool-result content in one wire-level user message (parallel tool calls collapse into one API message) and, if the sum exceeds `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS=200_000` chars (`constants/toolLimits.ts:49`), persists the *largest* fresh results in that message to disk until back under budget — even if no single result individually crossed the per-tool threshold. State is tracked per `tool_use_id` (`seenIds`/`replacements`) and frozen forever once a result's fate (replaced or not) is decided, guaranteeing the same choice is replayed byte-identically on every subsequent turn for prompt-cache stability (`toolResultStorage.ts:372-393,641-667`).

**Elowen today**: `toolResultClearing.ts` evaluates individual results and the aggregate size of each current-run, consecutive `toolResult` group. `selectBudgetedToolResults` spills the largest members above `TOOL_RESULT_GROUP_BUDGET_BYTES` (default 200,000 bytes), while latching both spilled and kept decisions for prompt-cache stability. The per-result threshold remains 50,000 bytes.

**Why it matters**: parallel tool calls make the many-medium-results case practical, even when every individual result is below the per-result threshold. The implementation reuses the existing transform-context spill path, groups consecutive current-run results as one provider message, spills largest-first, and latches both kept and spilled decisions.

**Verdict: ADOPTED in 0.28.24.** The aggregate budget and durable latch are implemented in the existing transform-context spill path; the limit is operator-tunable and applies live.

---

## F9 — Single oversized tool-result → disk persistence with preview

**Claude Code**: `maybePersistLargeToolResult()` (`utils/toolResultStorage.ts:272-334`) persists any one tool result over a per-tool threshold (default `DEFAULT_MAX_RESULT_SIZE_CHARS=50_000` chars, `constants/toolLimits.ts:13`) to `<sessionDir>/tool-results/<id>.{json,txt}`, replacing it in context with a preview (2000 bytes, newline-aligned) plus the file path.

**Elowen today**: `toolResultClearing.ts`'s size trigger (`selectOversizedToolResults`, `SPILL_MAX_RESULT_BYTES=50_000`, `SPILL_PREVIEW_CHARS=2000`) does exactly this, including matching the same 50,000-byte threshold and 2000-char preview size CC uses (`toolResultClearing.ts:47-72`), with write-once (`wx`) spill semantics and pathGuard-scoped read-back via the `Read` tool.

**Verdict: SKIP — already implemented, at parity (same thresholds, same preview size).**

---

## F10 — File-read deduplication (`FILE_UNCHANGED_STUB`)

**Claude Code**: `FileReadTool.call()` (`tools/FileReadTool/FileReadTool.ts:522-565`) checks, before doing any read work, whether the exact same file path + offset/limit range was already read earlier in the conversation *and* the file's on-disk mtime hasn't changed since. If so, it returns a short stub — `"File unchanged since last read..."` (`tools/FileReadTool/prompt.ts:7-8`) — instead of re-sending the full content a second time. The comment cites measured impact: ~18% of Read calls are same-file collisions, up to 2.64% of fleet-wide `cache_creation` tokens.

**Elowen/PI today**: no equivalent — checked PI's `read.js` tool implementation directly (no dedup/mtime-cache logic present) and Elowen's codebase (no `readFileState`-equivalent, no `file_unchanged` stub). A model re-reading the same file range twice in one Elowen session pays full tokens both times.

**Gain from adopting**: the CC measurement (~18% of reads are collisions) suggests this is not a marginal case — agents frequently re-read a file they already have in context (e.g. re-verifying before an edit). Directly reduces `cache_creation` cost, which is the expensive side of Anthropic's pricing.

**Cost/risk**: this is the one finding where the implementation location matters a lot. `Read` is PI's built-in tool, not an Elowen-registered tool via `defineTool` — Elowen cannot simply add a pre-check inside it without either (a) a PI extension hook that intercepts tool *calls* before execution (not just the egress `transformContext` hook the other findings use), or (b) forking/wrapping PI's tool registration. This needs to be verified against PI's actual extension surface before committing to a design — if PI has no pre-call interception point, this cannot be done cleanly and would require patching PI's Read tool itself.

**Verdict: ADAPT, priority medium.** Worth doing given the measured savings, but scope the spike to "does PI's extension API expose a pre-tool-call interception point" before estimating implementation cost — the answer changes this from a half-day change to a much larger one.

---

## F11 — Image handling over time

**Claude Code**: images are **not** continuously aged out of context. The only image-stripping code found, `stripImagesFromMessages()` (`services/compact/compact.ts:145-200`), runs once, only on the messages sent *to the compaction summarization call itself* (so that call doesn't itself blow its own context budget) — it does not touch the images that remain in the live, uncompacted conversation. Outside of compaction, CC's only mitigation for image-heavy sessions is a user-facing error suggesting `/compact` when a many-image request exceeds a dimension limit (`services/api/errors.ts:635`). Token *estimation* for images is a flat 2000-token approximation used consistently across the codebase (`services/tokenEstimation.ts:400-411`, `microCompact.ts:38,152-153`).

**Elowen today**: `stripHistoricalImages()` (`src/brain/session/historyImageStripping.ts:44-61`) runs on **every** cold-cache turn (same TTL-based gate as F6/F7), continuously collapsing every image block in every message before the current run into a `[image omitted from history]` placeholder — proactively, not just at compaction time. It's latched per-message-hash for idempotence and cache stability (`historyImageStripping.ts:63-126`), the same pattern as `toolResultClearing.ts`.

**Gain from adopting CC's approach**: none — Elowen's mechanism is strictly more thorough. CC lets images accumulate in the live conversation indefinitely between compactions (each one re-serialized into every provider call, per Elowen's own code comment at `historyImageStripping.ts:38-39` explaining exactly this cost); Elowen prevents that steady-state growth entirely.

**Verdict: SKIP — Elowen's mechanism is better than Claude Code's here.** This is worth stating plainly: do not "catch up" to CC on this axis.

---

## F12 — Prompt-cache-break detection and diagnosis

**Claude Code**: `promptCacheBreakDetection.ts` records a hash snapshot of system prompt, tools (with per-tool schema hashes), betas, model, and cache-control settings before each request (`recordPromptState`, `promptCacheBreakDetection.ts:247-436`), then on the response, if cache-read tokens dropped >5% and more than `MIN_CACHE_MISS_TOKENS=2000` absolute (`:118-120,483-492`), attributes the drop to the specific pending change (system prompt changed, N tools added/removed, which tool's schema changed, beta flags flipped, etc. — `:494-563`) or, if nothing client-side changed, to a TTL-expiry or "likely server-side" bucket (`:565-588`). It logs an analytics event and writes an actual unified diff of before/after system+tools content to a temp file for debugging (`writeCacheBreakDiff`, `:646-658,708+`).

**Elowen today**: `cacheWatch.ts`, explicitly modeled on this CC mechanism (`cacheWatch.ts:6`), does the equivalent job and in one respect goes further: instead of only a coarse system/tools/model hash comparison, it hashes and position-tracks individual **history message segments and individual tool schemas**, then classifies a divergence as `appended` / `dropped` / `inserted` / `removed` / `rewritten` by probing whether the tail resumes after a shift (`cacheWatch.ts:119-178`) — distinguishing "a message was inserted mid-history" (routine — e.g. tool-result clearing, or memory injection) from "an already-sent message was rewritten in place" (the actual cost defect behind the project's worst cache incident). It suppresses expected drops from real compactions and TTL expiry the same way CC does (`cacheWatch.ts:12-14,259-263`).

**Gap vs CC**: Elowen logs a warning line, not a persisted diff file; CC additionally writes the actual diff content to disk for later inspection (`writeCacheBreakDiff`). Given Elowen's segment classification already names *which* history index or tool changed, a full diff-to-disk adds marginal debugging value on top of that.

**Verdict: SKIP — already implemented and, on the mid-history-shift-vs-rewrite distinction, more precise than Claude Code's version.** The diff-to-disk gap is real but low value given the segment classification Elowen already reports; not worth the added complexity of persisting and rotating diff files.

---

## F13 — User-facing context/token usage reporting

**Claude Code**: the `/context` command / `get_context_usage` control request (`commands/context/context-noninteractive.ts:34-325`) produces a full breakdown: total tokens vs. window with percentage, a per-category table (system prompt, tools, memory, messages, free space, autocompact buffer), a per-MCP-tool token table, a per-custom-agent table, a per-memory-file table, a per-skill table, and a message-breakdown table splitting tokens by tool-call vs. tool-result vs. attachment vs. assistant-text vs. user-text, with a "top tools by token cost" and "top attachments by token cost" ranking.

**Elowen today**: `src/brain/contextBreakdown.ts` implements the read-only breakdown behind `GET /brain/context-usage` and CLI `/context`. It reports estimated resident tokens and free space, categories for system prompt, active tool schemas, user messages, assistant messages, tool results and other history, plus the eight heaviest tools split into schema, call and result cost. It uses provider-reported resident usage where reliable and the same structured local estimate used by compaction for Anthropic hosted-tool sessions.

**Remaining gap vs CC**: Elowen does not split memory files, skills, custom agents and attachments into separate rankings, and its category taxonomy is intentionally shaped around Elowen's own request model rather than Claude Code's.

**Verdict: ADAPTED in 0.28.24.** The actionable self-service category/free-space and top-tool breakdown is implemented; the remaining finer-grained tables are optional extensions, not a missing core diagnostic.

---

## Summary table (ordered by value-for-effort)

| # | Finding | Verdict | Priority | Reasoning |
|---|---------|---------|----------|-----------|
| F13 | User-facing context/token breakdown (`/context`-equivalent) | **ADAPTED in 0.28.24** | — | Category/free-space and top-tool breakdown is available through the API and CLI |
| F2 | Circuit breaker on repeated compaction failure | **ADOPTED in 0.28.24** | — | Per-session automatic-compaction breaker with manual recovery retained |
| F8 | Aggregate per-message tool-result budget | **ADOPTED in 0.28.24** | — | 200,000-byte current-run group budget reuses the existing spill/latch machinery |
| F4 | Detailed anti-drift compaction summary prompt | ADAPT | medium | Cheap via existing `session_before_compact` hook; targets a real summary-quality failure mode |
| F10 | File-read deduplication | ADAPT | medium | Measured ~18%/2.64% savings in CC, but cost depends on unverified PI extension-hook feasibility — spike first |
| F7 | Cache-editing microcompact (warm-cache clearing) | ADOPT if API-available / SKIP otherwise | medium | High potential value for long warm sessions, but entirely gated on unverified Anthropic beta availability |
| F1 | Tiered warning/error/blocking thresholds | ADAPT | low | Only the user-facing warning tier is worth adding; internal buffer plumbing not needed |
| F5 | Manual partial-range compaction | SKIP | low | Niche power-user feature; no evidence of user need; PI's automatic model already covers the common case |
| F3 | Full-discard compaction + regenerated attachments | SKIP | — | PI/Elowen's always-keep-recent-verbatim design is safer; only the file-content-reinjection sub-idea is worth a future look (low) |
| F6 | Time-based tool-result clearing | SKIP | — | Already implemented (`toolResultClearing.ts`), and Elowen's version is more recoverable (disk spill vs. CC's non-recoverable clear) |
| F9 | Single oversized result → disk persistence | SKIP | — | Already implemented at parity (identical 50k/2k thresholds) |
| F11 | Image aging over time | SKIP | — | Elowen's continuous stripping is strictly better than CC's compaction-only stripping |
| F12 | Prompt-cache-break detection & diagnosis | SKIP | — | Already implemented (`cacheWatch.ts`), and more precise than CC on the shift-vs-rewrite distinction that matters most |

---

*Findings newly implemented in 0.28.24 are F2, F8 and F13. F12 was already implemented; remaining proposals are labelled ADAPT/ADOPT, and existing or intentionally skipped mechanisms are labelled SKIP.*

*Status note: the Elowen-side claims above were reconciled against this checkout at `0.28.24`; cited paths and line numbers are illustrative and may move. Findings labelled ADOPT/ADAPT remain proposals unless explicitly marked implemented.*
