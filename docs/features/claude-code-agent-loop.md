# Claude Code's Agent Loop and Orchestration — What Elowen Should Adopt

Domain: the main turn loop, streaming/tool-call interplay, mid-turn steering, sub-agent orchestration, model routing, retry/fallback, and autonomy mechanisms. Explicitly out of scope: context-compaction internals, tool permission/definition mechanics, and session persistence-on-disk (other investigators cover these; they're mentioned only where they touch the loop).

Clone state: `/tmp/claude-code` at commit `6f6f12b` (2026-05-07), read-only, TypeScript/Bun source. Elowen reference: this checkout, release `0.28.24` (public GitHub/npm remain on `0.28.17`), built on PI (`@earendil-works/pi-coding-agent`) as the actual turn-loop runtime; Elowen's own `src/brain/` is an orchestration layer on top of PI, not a from-scratch agent loop.

---

## F1 — Main loop shape: continue while tool_use blocks appear, stop otherwise

**Claude Code.** `query.ts` is one big `async function* queryLoop` with a `while (true)` (`query.ts:307`–`1728`). Each iteration streams one model response, tracks whether any `tool_use` block appeared (`needsFollowUp`, set at `query.ts:558,834`), executes tools if so, and loops. The exit decision is: no tool_use in the response (`!needsFollowUp`, `query.ts:1062`) → run Stop hooks → if nothing blocks, `return { reason: 'completed' }` (`query.ts:1357`). Every `return` carries a typed `reason` (`blocking_limit`, `image_error`, `model_error`, `aborted_streaming`, `prompt_too_long`, `stop_hook_prevented`, `hook_stopped`, `aborted_tools`, `max_turns`, `completed`) — the whole loop is explicit about *why* it stopped, not just that it did.

**Elowen.** The equivalent loop lives inside PI (`agent-session.js`, vendored), not in Elowen's own code — Elowen doesn't reimplement a turn loop, it drives PI's `session.prompt()` (`src/brain/service/turnRunner.ts:418`) and reads PI's step/turn events. Elowen adds its own step ceiling on top by counting PI's `turn_start` events and aborting past a configured max (`src/brain/service/spawnEventReducer.ts:118-136`) rather than passing a `maxTurns` parameter in. This is a different but sound design: Elowen doesn't own the decision of "did the model produce a tool call," it only owns "how many steps have gone by."

**Verdict: SKIP — priority: low.** Elowen doesn't need to reimplement this; it already delegates loop mechanics to PI and only needs to react to PI's events, which it does. Re-implementing tool-loop mechanics in Elowen's own code would duplicate PI's job.

---

## F2 — Tools execute as soon as their `tool_use` block finishes streaming, not after the full assistant turn

**Claude Code.** While the assistant message is still streaming, each completed `tool_use` block is handed to a `StreamingToolExecutor` immediately (`query.ts:841-844`), and completed results are drained and yielded inline as they land, even mid-stream (`query.ts:851-861`). Only leftovers are awaited after streaming ends (`query.ts:1380-1381`, `streamingToolExecutor.getRemainingResults()`). This overlaps tool latency with the tail of the model's own output generation instead of serializing "model finishes → then tools run."

**Elowen.** Not verified in Elowen's own source — this is PI's job (`core/agent-session.js`), and Elowen's `src/brain/` never touches individual `tool_use` blocks during streaming; it only sees PI's step-level events (`step`, `tool`, etc. per `src/brain/events.ts`).

**Verdict: SKIP — priority: low.** This is a low-level streaming/tool-execution mechanism that belongs to the agent runtime (PI), not to Elowen's orchestration layer. Nothing to adopt at Elowen's level; if it matters, it's a PI feature request, not an Elowen change.

---

## F3 — Mid-turn message handling: a priority queue drained between iterations, not a live interrupt

**Claude Code.** All queued input — user prompts typed while streaming, task notifications, orphaned permission replies — goes through one module-level priority queue (`now` > `next` > `later`, FIFO within a level) in `utils/messageQueueManager.ts:53-193`. `query.ts` drains commands up to `next` priority (`getCommandsByMaxPriority('next')`, `query.ts:1570-1578`) **after tool results come back and before the next model call** (`query.ts:1580-1590`), converting them to attachment messages the model reads on its next turn — it does *not* interrupt an in-flight API call. A genuine hard interrupt (Ctrl+C / Escape) is a separate path: it aborts the `AbortController` mid-stream (`toolUseContext.abortController.signal.aborted`, checked at `query.ts:1015` and `query.ts:1485`), which unwinds the current call and yields synthetic tool results for anything in flight.

**Elowen.** Elowen's steering is PI-native and richer in one important way: it distinguishes a *durable* delivery problem from a UX one. `BrainTurnRunner.sendCustomSystem` (`src/brain/service/turnRunner.ts:119-182`) steers a message into a running turn via `session.sendCustomMessage(..., { deliverAs: 'steer' })`, but treats "PI accepted the steer" as **not yet proof of delivery** — a stop that clears PI's queue in between would silently erase it — so the caller (sub-agent/workflow result delivery, `turnRunner.ts:211-271`) keeps the row `pending` until it can *see* the message in the transcript, with bounded retries (`MAX_RESULT_DELIVERY_ATTEMPTS = 5`, `turnRunner.ts:32`) and exponential backoff (`turnRunner.ts:279-288`). Ordinary user steering during a busy turn goes through `TurnAdmission.steer()` (`turnRunner.ts:354-361`).

**Verdict: Elowen's own is BETTER — no adoption needed, priority: n/a.** Claude Code's queue is sufficient for its single-writer, always-live CLI process; Elowen's daemon has to survive turns clearing the queue, retries, and multi-source contention (goal loop, sub-agent results, user), which its delivery-confirmation design already handles and Claude Code's does not need to.

---

## F4 — Sub-agent launch: a nested call to the same loop, filtered context inheritance, per-branch abort scoping

**Claude Code.** `runAgent()` (`tools/AgentTool/runAgent.ts:248-860`) is a *recursive call into `query()`* (`runAgent.ts:748`) — a sub-agent is not a different mechanism, it's the same loop with a different `agentId`, `toolUseContext`, and initial messages. Context inheritance: `forkContextMessages` (parent's message history) is filtered to strip any assistant message with an unresolved `tool_use` before being handed to the child (`filterIncompleteToolCalls`, `runAgent.ts:370-372, 866-904`) — a sub-agent never inherits a dangling tool call. Abort scoping: a **sync** agent shares the parent's `AbortController` (so Ctrl+C kills both together); an **async** agent gets its own unlinked one (`runAgent.ts:520-528`) so it survives the parent turn ending. Each sub-agent gets its own `agentId`, its own todos-map key (cleaned up on exit so long sessions don't leak entries, `runAgent.ts:835-843`), its own file-read-state cache, and its own MCP client set merged with the parent's (`initializeAgentMcpServers`, `runAgent.ts:95-218`); all of it is torn down in a `finally` regardless of how the agent exited (`runAgent.ts:816-859`).

**Elowen.** The `Delegate` tool (`plugins/subagent/index.mjs`) is architecturally the same idea — spawn a fresh isolated conversation, not a special-cased execution mode — but built for a permissioned multi-user daemon instead of a single local process: the child inherits **exactly** the caller's access (`ctx.currentAccess()`, `index.mjs:402-439`) and can only ever *narrow* it (`resolveDelegateTools`, `index.mjs:42-61` — an explicit `tools` list not held by the caller is a hard error, not silently dropped), it inherits the parent's model, `thinkingLevel`, and `cwd` by default (`index.mjs:383-397, 412-414`), and cleanup on plugin reload force-settles every still-running job so nothing is orphaned (`index.mjs:807-832`).

**Verdict: Elowen already has this, comparable design — priority: n/a.** No gap. The one thing worth double-checking against F4's abort-scoping distinction (sync-shares / async-unlinked controller) is whether Elowen's foreground vs. background delegate correctly ties a **foreground** delegate's lifetime to the parent turn's own abort — worth a targeted look, not a redesign.

---

## F5 — Sub-agent concurrency and nesting: no built-in depth limit, concurrency by convention

**Claude Code.** Multiple `tool_use` blocks in one assistant message run concurrently automatically (the streaming tool executor doesn't serialize by tool type) — the sub-agent system prompt explicitly instructs "Launch multiple agents concurrently whenever possible... use a single message with multiple tool uses" (`tools/AgentTool/prompt.ts:248`). Nesting is bounded only by `queryTracking.depth` (`query.ts:346-355`, incremented per recursive `query()` call) which is used for analytics, not enforcement — no hard-coded max-depth guard was found in `query.ts` or `runAgent.ts`. `allowedAgentTypes` (`AgentTool.tsx:340-344`) restricts *which* agent types a given `Agent(x,y)` tool spec can spawn, which is a taxonomy control, not a depth control.

**Elowen.** Same shape: parallel `Delegate` calls in one response run concurrently (`index.mjs:338`), and nesting has no explicit depth cap either — the only real bound is `MAX_BACKGROUND_JOBS = 64` per plugin instance (`index.mjs:19`) and the `read_only=true` mode's explicit "cannot delegate further" restriction (`index.mjs:339`), which caps fan-out from read-only leaves but not from full-access sub-agents.

**Verdict: SKIP — priority: low.** Both systems rely on cost/practicality rather than a hard depth limit, and neither shows evidence this is a real production problem. Not worth inventing a depth cap Claude Code itself doesn't have; if runaway recursive delegation becomes a real incident, revisit then with actual data.

---

## F6 — Sub-agent resume: continuing a finished sub-agent with its own preserved context

**Claude Code.** `resumeAgentBackground()` (`tools/AgentTool/resumeAgent.ts:42-265`) reloads a sub-agent's stored transcript from disk, filters out whitespace-only and orphaned-thinking messages (`resumeAgent.ts:70-74`), appends the new prompt, and re-enters `runAgent()` with the reconstructed history — this is how a background agent gets a follow-up instruction without losing what it already did.

**Elowen.** `DelegateContinue` (`plugins/subagent/index.mjs:716-782`) does the same thing at the daemon level: it resumes the child's *own* PI session (not a reconstructed transcript) with full context, narrowed by whatever access the caller currently holds, and refuses (rather than interrupts) a child with a turn already in flight. `DelegateList` + `DelegateRead` (`index.mjs:632-714`) let the parent discover and inspect past sub-agents to decide whether to continue one instead of spawning fresh — a UX affordance Claude Code doesn't appear to have (its equivalent is a UI feature, not exposed as a tool the model itself can call to *decide* whether to reuse a prior agent).

**Verdict: Elowen already has this, and arguably more model-visible — no adoption needed, priority: n/a.**

---

## F7 — Model selection per call: plan-mode override, per-agent model inheritance, and cheap models for auxiliary work

**Claude Code.** The main loop resolves its model per iteration via `getRuntimeMainLoopModel()` (`utils/model/model.ts:145-167`) — plan mode forces Opus (or Sonnet, depending on user setting) regardless of the session's normal model, with a 200k-token-context escape hatch. Sub-agents resolve their model via `getAgentModel()` (`utils/model/agent.ts:37-...`), which lets an agent definition pin a model, otherwise inherits the parent's, with a `CLAUDE_CODE_SUBAGENT_MODEL` env override and Bedrock-region-prefix inheritance so a sub-agent doesn't cross data-residency boundaries. Separately, **auxiliary, non-agentic work always goes to Haiku via a dedicated `queryHaiku()` call**: tool-batch summaries for the mobile UI (`services/toolUseSummary/toolUseSummaryGenerator.ts:69-81`) and session titles (`utils/sessionTitle.ts:87-112`) — both fire-and-forget, non-blocking, never touch the main conversation's model.

**Elowen.** Structurally the same idea, independently arrived at: `ConversationTitler` (`src/brain/conversationTitler.ts:44-77`) uses "the same cheap model as the memory curator/categorizer" via a dedicated `InferenceClient`, entirely separate from the conversation's own provider/model — comment at line 43 states this explicitly. Per-session model + `thinkingLevel` selection exists (`src/brain/session/factory.ts:304-321`, `src/brain/service/statusService.ts:258-278`), and a `fast` request profile toggles provider-side priority service tier per session (`src/brain/service/spawner.ts:133`, `channels.ts:593-605`) — note this is a *latency* tier, not a *cheaper model* switch, so it's a different lever from Claude Code's plan-mode model override.

**Verdict: Elowen already has this — no adoption needed, priority: n/a.** One narrow gap worth a look: Claude Code's plan-mode-forces-a-different-model behavior (`model.ts:153-164`) doesn't have an obvious Elowen analogue — Elowen's `mode: 'plan'` governs tool availability, not model choice. If plan-mode answers in Elowen are noticeably worse with the same model as build-mode, this is a cheap, contained change (**ADAPT — priority: low**, only if there's an observed quality gap).

---

## F8 — Retry and fallback: capacity-aware backoff, model fallback on sustained overload, foreground/background retry-worthiness

**Claude Code.** `withRetry()` (`services/api/withRetry.ts:170-517`) is a substantial state machine: exponential backoff with jitter (`getRetryDelay`, `withRetry.ts:530-548`), a hard cap of `MAX_529_RETRIES = 3` consecutive overloads before switching to a `fallbackModel` (throwing `FallbackTriggeredError`, caught and handled back in the main loop at `query.ts:894-951` — the whole in-flight assistant/tool state is discarded and the request is cleanly retried on the fallback model), a **foreground/background distinction** (`FOREGROUND_529_RETRY_SOURCES`, `withRetry.ts:62-82`) where only user-blocking calls (main REPL, SDK, agents) retry on 529 — summaries, titles, classifiers bail immediately rather than amplify load during a capacity cascade — and a separate "persistent unattended retry" mode with periodic heartbeat yields so a long-sleeping retry doesn't look like a hung process (`withRetry.ts:96-104, 486-506`). It also auto-adjusts `max_tokens` and retries on a context-overflow 400 (`withRetry.ts:384-427`).

**Elowen.** Retry/backoff for the actual model call lives in PI (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`), which has its own `maxRetries`/attempt tracking and `auto_retry_start`/`auto_retry_end` events plus a 529/overflow-aware compact-and-retry path. Elowen's own `src/inference/` layer (used for the titler/curator, i.e. the "background/auxiliary" side of F7) has **no visible retry/backoff of its own** — it's a thin client with no matches for retry/backoff/529 in `src/inference/*`. That mirrors Claude Code's foreground/background split by accident rather than by design: main-turn retry is inherited from PI, auxiliary-call retry (titling, memory categorization) appears to be fire-and-forget-and-swallow (`conversationTitler.ts:74-76` catches and logs, never retries).

**Verdict: ADAPT — priority: medium.** The model-fallback-on-sustained-529 behavior (after N consecutive overloads, switch model rather than keep hammering the same one) is worth checking whether PI exposes a fallback-model hook Elowen can wire per-provider; if not, it's a genuine capability gap for a multi-user daemon that will see far more aggregate request volume — and thus far more 529s — than any single CLI user ever would. The foreground/background retry-worthiness split is lower priority (**SKIP** on its own): Elowen's auxiliary calls are already cheap/best-effort and losing one titling attempt is harmless — but the *general* insight (don't retry-storm background work during a capacity incident) is worth keeping in mind if Elowen's auxiliary call volume grows.

---

## F9 — Stop hooks: a per-turn gate that can force continuation or veto stopping, on *every* natural stop

**Claude Code.** Every time the model would naturally stop (no tool_use in its last message), `handleStopHooks()` runs (`query.ts:1267-1279`, implementation in `query/stopHooks.ts:65-473`) before the loop is allowed to return `completed`. A Stop hook (a user- or admin-configured script) can do one of three things: run silently and let the stop proceed; return a **blocking error**, which is appended to the conversation as a meta user message and the loop `continue`s with `stopHookActive: true` so the model gets another turn to react to it (`query.ts:1282-1306`); or `preventContinuation`, a hard veto that ends the query regardless (`query.ts:1278-1280`). This is the generic mechanism Claude Code uses for "did you actually finish" gates — e.g. a project's config can wire a hook that checks "did tests run" and blocks a premature stop. It's not the goal/task system; it fires on **every** turn, autonomous or not.

**Elowen.** The closest analogue is the **goal loop's** judge (`GoalLoopService.afterTurnGoalJudge`, `src/brain/service/goalLoop.ts:248-302`), which reads the assistant's own text for `judgeGoalCompletion`/`judgeGoalBlocked` markers and decides to continue, pause, or complete — but this only runs when an explicit `/goal` is active (`row.status !== 'active'` returns immediately, `goalLoop.ts:250`). An ordinary turn with no goal set has **no equivalent per-turn "should this really stop" gate** — Elowen's plugin system has hooks (`plugins/hookBus.ts`) but nothing was found wired to intercept a natural turn-end and force reconsideration outside the goal loop.

**Verdict: ADOPT — priority: medium.** This is a genuine, general-purpose gap, not a CLI-specific artifact: a plugin-level "before natural stop" hook that can inject a blocking message and force one more model turn (independent of whether `/goal` is active) would let Elowen support things like "verify tests passed before claiming done" or "check todos are all resolved" for *ordinary* turns, not just autonomous goal runs. It composes cleanly with the existing plugin hook bus (`plugins/hookBus.ts`) — this would be a new hook point on that bus, not a new subsystem. Medium priority because the goal loop already covers the highest-value case (autonomous multi-turn work); this extends the same discipline to single-shot turns.

---

## F10 — Intra-turn task-budget nudge: keep working within one `query()` call if there's budget and output left

**Claude Code.** Gated behind a feature flag, this is distinct from `maxTurns`: after a natural stop, if the model hasn't declared done and there's remaining "task budget" (a token allowance passed via `params.taskBudget`, tracked across compaction boundaries at `query.ts:282-291,504-515`), the loop injects a synthetic nudge user message and continues (`checkTokenBudget`/`decision.action === 'continue'`, `query.ts:1308-1341`) rather than stopping — with an explicit "diminishing returns" completion event that can end the budget early if continuing isn't producing new value (`decision.completionEvent.diminishingReturns`, `query.ts:1344-1346`).

**Elowen.** No equivalent found at the single-turn level. Elowen's turn-budget concept (`row.turn_budget`, `goalLoop.ts:277-301`) operates at the **multi-turn goal** granularity (how many full conversational turns an autonomous goal may spend), not at the **intra-call** granularity.

**Verdict: SKIP — priority: low.** This mechanism exists in Claude Code mainly to make a single agentic session self-sufficient without a human in the loop between turns. Elowen already solves "keep working autonomously" at the *turn* level via the goal loop, which is the right granularity for a daemon where a turn is a discrete, observable, replayable unit shown live to the user. Adding a second, finer-grained budget would duplicate that discipline without a clear win — Elowen's step ceiling (F1) already bounds a single turn's tool-loop length.

---

## F11 — `maxTurns`: a hard tool-loop iteration cap per `query()` call

**Claude Code.** `maxTurns` (`query.ts:1705-1712`, checked both on the abort path at `query.ts:1506-1515` and the normal continuation path) is a simple counter cap on how many times the loop may recurse within one `query()` invocation — independent of Stop hooks or task budget, a last-resort circuit breaker.

**Elowen.** Elowen's step ceiling (F1, `spawnEventReducer.ts:118-136`) is the same idea at the same granularity — one turn's tool-calling loop — implemented by watching PI's step events rather than passing a config parameter into the loop. Functionally equivalent.

**Verdict: Elowen already has this — no adoption needed, priority: n/a.**

---

## F12 — Todo/plan state does not mechanically drive the loop in Claude Code

Searched `query.ts` and `stopHooks.ts` for any built-in enforcement tied to incomplete todos (e.g., "don't let the model stop while todos remain") — found none. The todo list (`AppState.todos`, cleaned up per-agent at `runAgent.ts:835-843`) is informational/UI state; the only way it could influence stopping is indirectly, via a *user-configured* Stop hook script that happens to check it (F9's mechanism), not anything built into the loop itself. Plan mode affects tool availability and, per F7, model selection — but not the continue/stop decision either.

**Elowen.** Consistent with this: nothing in `src/brain/` ties a todo tool's state to turn continuation; Elowen's continuation logic (goal loop) is driven by the model's own completion markers in its text, not by inspecting structured todo state.

**Verdict: SKIP — priority: low.** Nothing to adopt; this finding is here to close out the question honestly rather than invent a mechanism neither system actually has. If Elowen ever wants todo-driven stop-gating, it's a natural extension of F9 (a Stop-hook-style check that reads todo state), not a separate mechanism.

---

## Summary table (value-for-effort order)

| # | Finding | Verdict | Priority |
|---|---|---|---|
| F9 | Generic per-turn Stop-hook gate (force continuation / veto stop outside goal loop) | **ADOPT** | medium |
| F8 | Model fallback after sustained capacity errors (529 → fallback model) | **ADAPT** | medium |
| F7-note | Plan-mode-specific model override | ADAPT (conditional) | low |
| F4 | Sub-agent launch (context inheritance, abort scoping) | already have (comparable) | n/a |
| F6 | Sub-agent resume/continuation | already have (better model-visibility) | n/a |
| F7 | Cheap-model auxiliary calls (titling/summaries) | already have | n/a |
| F11 | Hard per-turn iteration cap | already have | n/a |
| F3 | Mid-turn steering | already have (BETTER — durable delivery) | n/a |
| F1 | Main loop continue/stop shape | owned by PI, SKIP | low |
| F2 | Streaming/tool-execution interleaving | owned by PI, SKIP | low |
| F5 | Sub-agent nesting/concurrency depth limits | SKIP (neither system has one; not a proven problem) | low |
| F10 | Intra-turn task-budget nudge | SKIP (goal loop covers this at the right granularity) | low |
| F12 | Todo state driving the loop | SKIP (doesn't exist in either system) | low |

**Bottom line:** Elowen's own orchestration layer is already at or above parity with Claude Code across sub-agent launch, resume, steering, and cheap-model routing — several of those are genuinely better-engineered for a multi-user daemon. The two real gaps are (1) a general Stop-hook-style "verify before stopping" point that isn't scoped to `/goal`, and (2) capacity-aware model fallback for the main conversational path, which matters more for Elowen than for Claude Code precisely because a shared daemon sees far more aggregate 529 exposure than any single local CLI session.

---

*Status note: the Elowen-side claims above were reconciled against this checkout at `0.28.24`; cited paths and line numbers are illustrative and may move.*
