# Changelog

All notable changes to Elowen are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/); the daemon version is the root `package.json` version.

## [Unreleased]

The tmux-agent and missions subsystem — spawning coding agents into tmux, the autopilot mission engine,
the overseer, escalations, and their web pages — now ships as the bundled `agents` plugin, on a plugin
platform any plugin can build on. An existing install is enabled automatically on upgrade (a running
mission continues across it), and disabling the plugin cleanly turns the whole layer off while chat,
tasks, projects and memory keep working.

Task tracking itself now ships the same way, as the bundled `work` plugin: the task tables, the task
API, the task brain tools and the Tasks, Kanban, Timeline and Stats pages are one plugin that owns the
whole domain. Bare Elowen is the agent — chat, memory, projects, users, settings — and everything else
is a plugin that adds a feature.

### Added
- **Plugin platform (daemon).** Plugins can now mount authenticated API routes (including root mounts
  that grandfather formerly-core paths such as `/missions` and `/sessions`; core routes always win and a
  disabled plugin answers 404), contribute host-managed background services, fixed-period intervals and
  idempotent boot reconciles, apply their own versioned database migrations (bookkept per plugin, with
  grandfathering of pre-existing tables), register editable prompt templates that respect existing user
  overrides, declare typed runtime controls, and read a per-plugin config slice with schema-driven
  Settings fields.
- **Plugin platform (web).** A plugin can ship browser pages, sidebar navigation and a Settings section
  as one built ESM bundle: the manifest's `web` block declares entry/nav/settings (localizable per
  locale), the daemon serves the bundle on an immutable content-hash URL, and pages render under
  `/p/<plugin>/…` on the host's `window.ElowenUiRuntime` (the app's React instance plus curated
  components, data hooks and helpers — one react-query cache, one SSE invalidation path). The
  `@elowen/plugin-ui-kit` package builds `plugins/*/web-src/` sources via `npm run build:plugins-web`.
- **Agents subsystem as a plugin.** The whole tmux-agent + missions subsystem moved into
  `plugins/agents`: engine/scheduler/deriver run as plugin services, the `/missions`, `/sessions` and
  ask/guide API surfaces are plugin root mounts on unchanged paths, the eleven worker/pilot/overseer
  prompt templates are plugin prompts (user overrides keep working), `ElowenListMissions` and
  `ElowenListSessions` are plugin tools, and the Sessions + Escalations web pages ship in the plugin's
  bundle (`/sessions` and `/escalations` redirect, deep links included). Plugin-owned settings
  (overseer model, PR base branch/auto-open/verify command) live under the plugin's config slice with a
  one-shot copy migration — `autopilot.*` keeps its values for a lossless rollback — and subsystem log
  lines now reach the admin per-plugin log view. The migration E2E suite proves a DB with a running
  mission upgrades with the plugin auto-enabled and nothing lost.
- **Task tracking as a plugin.** The work domain moved into `plugins/work`: the `tasks`, `task_deps` and
  `task_usage` tables are the plugin's (adopted in place — an existing install keeps every row), the task
  API is served by the plugin on its unchanged paths, the seven `Elowen*` task tools and their MCP twins
  are plugin tools, and the Tasks, Kanban, Timeline and Stats pages ship in the plugin's bundle
  (`/tasks`, `/kanban`, `/timeline` and `/stats` redirect, deep links and query strings included). An
  existing install is enabled automatically on upgrade. With the plugin off the instance is a pure agent:
  the core surfaces that read tasks — today's tile, the decisions pod, the bell's inbox row, the palette's
  create commands — hide rather than reporting an empty register, and the missions layer refuses honestly
  instead of pretending a mission exists.

### Changed
- **Extensions with no daemon dependency moved to the plugin registry.** `formatters`, `dev-commands`,
  `security-scan` and `codebase` are plain extensions the daemon never calls into, so they now live in the
  public plugin registry and install from Settings → Plugins like any other extension instead of shipping
  in the package. A fresh install no longer enables `security-scan` and `codebase` — they are not on disk
  until you ask for them. An instance that had any of them enabled keeps its configuration and its indexed
  data; install the plugin from the registry to get the code back.

### Fixed
- Read-only sub-agent drill-in now survives transient EventSource disconnects, keeps child turn errors in the
  child transcript, and returns cleanly to the parent only when the child cannot be resolved.
- Restart recovery stays visible while the current daemon boot owns it, including turns waiting behind a long
  serial recovery; failed or unsafe recovery is parked as a visible error with a durable parent notice.
- OpenAI Responses cache diagnostics now cover both official and ChatGPT wires, use the provider's maximum
  retention for destructive cold-history transforms, and warn for future major-only GPT identifiers missing native
  tool-search compatibility.

## [0.27.82] - 2026-08-10

Delegated sub-agents now survive a daemon restart. A delegation that was still running is respawned from
its durable transcript and its parent is handed the real result, instead of every restart quietly killing
work that had run for the better part of an hour. Tool loading became configurable and now recognizes
OpenAI's native tool search the same way it already used Anthropic's, you can open a running sub-agent's
transcript from the web and the CLI, and another round of prompt-cache fixes keeps long conversations warm
instead of re-billing them at full price.

### Added
- **A running delegation survives a restart.** A restart used to abort every sub-agent and mark it
  `error`; now the drain lets a runner finish (`KillMode=mixed`), and a child that outlives the drain — or
  a hard crash — is respawned from its durable transcript on the next boot and its result is delivered to
  the parent. A claim uses a boot-scoped lease so two boots can never recover the same row, and a suffix
  that contains an unanswered tool call is flagged `recovery_required` (surfaced to the parent
  through the durable inbox) rather than blindly replayed. `DelegateContinue`/`Status`/`Result`/`Stop` now
  resolve a `dlg-` job id back to its child session, so those handles keep working after a restart too.
- **Configurable tool loading.** Rarely used plugin tools are deferred out of the cached prompt and
  fetched on demand through `ToolSearch`; Settings → Brain → tool loading lets you keep a group immediate,
  defer it, or hand it fully to ToolSearch, with per-source and per-tool overrides. Deferral now works
  natively on OpenAI models (Responses tool search) as well as Anthropic (`defer_loading`), and a startup
  warning flags a GPT-5.4+ model registered without the capability, which would silently degrade to a
  cache-unfriendly fallback.
- **Drill into a sub-agent.** The agents panel opens a running (or finished) sub-agent's own transcript
  live, in the web and the CLI, showing its real model, provider and cards rather than the parent's.
- **A workflow node can grow its own workflow.** A node running inside a runner can call
  `WorkflowAddNodes` over a real host RPC, so a workflow can expand as the work reveals more work.
- **Room to run longer.** The `maxSteps` ceiling was raised to 1000 (edited with a coarse slider), the
  sub-agent stall watchdog timeout became configurable (default 60 minutes), and the three memory-recall
  limits doubled.

### Changed & Fixed
- **Prompt cache stays warm.** A cleared tool result stays cleared across duplicates and respawns, the
  trailing cache breakpoint actually reaches a prior write, a wide fan-out no longer re-caches the whole
  conversation, a string↔text-block content-shape difference stopped faking a "rewritten in place", and
  live memory recall is budgeted per batch so long work keeps its memory.
- **Restarts don't leave a service down.** The web unit exits on `SIGTERM` and its stop is bounded, so a
  web restart can't leave the UI down; the daemon stops admitting new turns once it starts draining, so
  the restart drain converges; and credentials are served from disk so a re-login no longer needs a
  restart.
- **CLI/TUI.** A half-open SSE stream is recovered so a long turn can't freeze the TUI, `/stats` counts
  `cacheWrite` in its cache-hit figure (no more rounding to 100%), and a tool result's tone is read from
  its headline instead of any alarming word in its body.
- **Workflows** stay visible after their anchor row is compacted, and a node is no longer invited to
  expand a workflow it cannot reach.
- **Observability.** The event-loop lag metric no longer averages away the very stall it exists to find,
  and a refused sub-agent runner fork is now visible in `/health` instead of masquerading as an idle pool.
- **Web layout.** Settings group-header actions wrap below the title on narrow (mobile) viewports.

## [0.27.81] - 2026-08-07

Sub-agents moved out of the daemon's single thread: delegated turns now run in a self-sizing pool of
separate worker processes, on by default, so a large fan-out no longer freezes the CLI and the web or
kills parent turns with provider timeouts. Compaction now genuinely frees context instead of silently
keeping a fixed tail, a batch of prompt-cache fixes stops long conversations from being re-billed at
full price, and the agent can finally show you an image instead of only describing one.

### Added
- **The agent can show you a picture, not just talk about one.** `ShareImage` shares a screenshot it
  just took, a chart it rendered or an image file from a repo: the web renders it inline, chat
  platforms upload it as a real attachment, and the terminal names what was shared. It is bounded —
  only files the conversation may read, four per turn, 10 MB each, and the image type is judged from
  the file's content rather than its name.
- **You can see what is filling your context window.** The CLI's `/context` overlay and the web stats
  modal gained a breakdown of the window right now — categories, free space and the heaviest tool
  results — so "why is my context full" has an answer instead of a guess.
- **A conversation can be forked** into a peer that starts with a copy of its history, so you can try
  a different direction without losing the original thread.
- **Phone notifications show what Elowen said.** The turn-finished push now carries a readable preview
  of the actual reply, titled with the conversation name, instead of a generic "finished working" —
  you can tell from the lock screen whether the answer matters.
- **Memory shows how it is being used.** Every recall is logged, so the detail drawer can chart a
  memory's vitality over time and project when it would be evicted; the list gained a sortable "Used"
  column where the never-recalled memories are easy to find. Mid-turn recall now also works on shared
  platform channels, scoped strictly to the verified sender — never the channel owner. The memory
  tuning constants (dedup thresholds, score weights, curator budget) became live runtime settings.

### Changed
- **Delegated turns run in a worker pool by default.** Sub-agents used to execute on the daemon's one
  JS thread, so twenty concurrent children pinned a single core while the CLI froze and parent turns
  died on provider timeouts. They now run in forked worker processes; measured with 20 concurrent
  children, the daemon's own CPU went from ~45% to ~5%. The pool sizes itself to the machine — a
  2-core VPS gets one worker, not a herd — and its workers yield CPU to the daemon. A switch in
  Settings → Runtime turns it off; it is read live, so flipping it applies to the next delegation
  without a restart, and the health report now shows the mode delegated turns actually take rather
  than the one the machine would allow.
- **Fresh installs start at the values a tuned instance actually runs at.** Agent steps per run went
  from 20 to 200, recalled memories from six to ten, auto-compaction is on, and more of the plugins
  that work without configuration are enabled. Session retention now ships on at ten days — note this
  one does delete idle conversations older than that.
- **The dead web onboarding page is gone.** It was unreachable and left a fresh install staring at a
  login form no credentials could pass; a visitor on a box with no account now gets a screen naming
  the installer command to run.
- **Chat fullscreen was removed** — the `/chat` page is the wide view — and background processes are
  reported in the telemetry panel only, instead of also being announced above the composer.

### Fixed
- **A burst of delegations at cold start is queued instead of overflowing.** Firing many delegations
  before the pool's first worker finished booting made most of them fall back in-process — measured,
  12 of 20 — stalling the daemon worse than before the pool existed. A full pool now queues; only a
  pool that genuinely failed to come up still raises.
- **Delegated results are no longer lost to a database conflict.** Under concurrent load, 1 to 6
  completed child results were lost in every run to a write-snapshot conflict between processes, and
  in the worst case a fan-out hung for ten minutes holding a finished child while every health signal
  said fine. The writes now take the lock up front, so the conflict cannot arise; additive database
  migrations were made atomic across processes for the same reason.
- **Sub-agent workers no longer each launch their own browser at boot.** External MCP servers (such as
  browser automation) are connected on first use instead of at worker start, saving ~2.5 s of boot and
  the memory of a browser per worker that never browses.
- **A delegated turn that goes silent is aborted** instead of holding its slot forever, the parent is
  told it stalled (still recoverable with `DelegateContinue`), and a child's result is no longer
  delivered to the parent twice when several children finish close together.
- **The daemon stays responsive even without the pool.** Coalescing a streamed answer was quadratic in
  its own length — 5083 ms of blocked event loop over 4000 chunks, now 17 ms — and the health endpoint
  now reports event-loop latency percentiles so saturation is visible instead of inferred.
- **Compaction actually frees context now.** The retained recent tail was always the runtime's fixed
  default (20 000 tokens) regardless of your threshold, so setting auto-compact early did not leave
  you with less context. The tail is now sized from the trigger, so an early threshold genuinely means
  a smaller context after compaction.
- **A compaction threshold the model can never reach no longer burns money forever.** On a small
  window, system prompt and tools alone can sit above the threshold, so every "successful" compaction
  left the context above its own trigger and the next turn paid for another summarization — every
  turn, with nothing detecting it. Such a compaction is now refused with one notice, and a breaker
  trips after three consecutive failures; a manual `/compact` is never blocked.
- **A compaction cut no longer kills the conversation on the next restart.** A cut landing between a
  tool call and its result left an orphaned result that made every respawn fail with a provider error;
  orphans are now skipped on replay, which also heals conversations already carrying one. Tools
  fetched via `ToolSearch` also survive a compaction instead of silently vanishing from the advertised
  set.
- **Switching work modes no longer re-bills the whole conversation.** Entering plan mode narrowed the
  advertised tool set, which rewrote the cached prompt prefix — measured at ~$2.97 and 287 608
  re-written tokens per switch, paid again on the way back. The tool set now stays stable and plan
  restrictions are enforced when a tool is actually called (including built-ins, which the deny list
  previously never checked at execute time).
- **Cleared tool results stay cleared across a restart.** The record of already-trimmed results lived
  only in memory, so a warm conversation's first request after a daemon restart re-sent everything
  whole and paid a full re-cache — $3.04 measured against ~$0.12 for a normal turn. Results are now
  also budgeted per group, so eight parallel 30 kB searches cannot add 240 kB to the window just
  because each is individually under the limit.
- **Cache diagnostics tell the truth.** Tool registration order is now deterministic across restarts
  (it used to follow directory listing and MCP connect latency, breaking the cache for no reason),
  a cache-drop warning names its session and the module that rewrote history, activating a deferred
  tool is no longer misreported as the cause of a break, and a tool activation that silently failed is
  reported instead of leaving the model calling a tool that is not there.
- **An image the provider refuses no longer poisons the conversation.** A refused image was re-sent in
  every later request, so the conversation returned the same error forever at full cost; it is now
  dropped with a plain explanation and the chat continues. Phone photos also just work: HEIC/AVIF/BMP
  are converted, an oversized photo is shrunk instead of refused (providers downscale anyway), an
  attachment stays visible after a reload, it is served only to its owner, and the vision fallback no
  longer takes a photo away from a model that reads images itself.
- **The phone push actually fires.** Two gates each excluded essentially every real turn — in three
  days of logs, not one of 220 finished turns produced a push. A backgrounded iPhone now reports
  itself reliably, the device you sent from decides whether you are watching (an idle desktop terminal
  no longer speaks for a locked phone), and building the preview can no longer freeze the daemon on a
  long answer.
- **Smaller fixes.** Daemon lifecycle announcements ("Stopping", "Back online") arrive in your
  configured language; the web session cookie match is anchored, so a cookie planted by a sibling
  subdomain can no longer substitute the session; memory dedup thresholds were calibrated against the
  real embedding model (both sat above every score the store produces, so they had never fired once);
  whole-word matching is Unicode-aware, so accented category names like "práce" stop misfiling Czech
  memories; some memory limit settings were silently dropped on save while the UI reported "saved";
  skill and agent files saved with CRLF line endings or a BOM parse instead of silently disappearing;
  and the language menu is reachable on a phone again.

## [0.27.80] - 2026-08-04

Memory grew up in this release: it now belongs to your projects, keeps recalling while a turn is still
working, and looks after its own size. A prompt-cache bug that made long conversations roughly ten times
more expensive than they should be is also fixed.

### Added
- **Memories belong to your projects.** A memory category can be bound to a project, and recall then only
  surfaces that project's memories plus your global ones — work on one client no longer bleeds into
  another. The category picker shows the bound project's icon, and a memory written while you work in a
  project lands in that project's category by default.
- **Every memory has a vitality score, and the store keeps itself tidy.** Vitality (0–100) rises with use
  and decays with time; the decay half-life is set per importance, importance 5 never decays. A memory that
  falls below the floor after a grace period moves to the trash — recoverable, never a hard delete. Tune it
  all, or switch it off, in Settings → Memory retention. The memory list gained a Vitality column and the
  detail view a Vitality metric.
- **Recall keeps working during a turn.** Elowen now searches memory again mid-turn, not only when the turn
  starts, so a fact that only becomes relevant halfway through still reaches the answer. It never blocks the
  model: the search runs in the background and lands on a later step. Operators can budget it (passes, count
  and characters) in Settings, and users can switch it off.
- **Recalled memories say how old they are**, so a stale fact is visible as stale instead of being read as
  current, and each one is rendered as its own tagged element rather than a single blob.
- **The curator learns how you want to be worked with**, capturing standing "work like this" feedback as
  memory instead of only factual notes.
- **`elowen uninstall`.** A clean removal path for the CLI, and a missing entry script no longer sends the
  daemon into a crash loop.
- **Read-only sub-agents get the full reading toolset** plus a deny-list shell, so an exploration agent can
  actually explore without being handed the ability to change anything.
- **`DelegateContinue` can resume a sub-agent on a different model**, and a continued sub-agent otherwise
  stays on its own model instead of silently switching.
- **The daemon announces every boot on your chat platforms**, not only an operator-triggered restart, and a
  finished workflow leaves a marker in the timeline.
- **More operator settings instead of hardcoded values** — chat constants, stream-silence limits, plugin
  limits and several runtime values are now configurable in Settings.

### Changed
- **Stopping the daemon drains running work first.** A stop announces itself, lets in-flight turns and
  delivered results finish within a budget, and only then exits.
- **A conversation remembers its working directory across a cold restart**, so a respawn resumes where the
  work actually was.
- **The web shares the daemon's DTOs** instead of mirroring them by hand, with a test that catches drift.
- **The chat's bottom status line stays on one line on a phone.** Model, context, tokens and cost no longer
  wrap onto a second row and push the composer down; the model name truncates instead, with the full id on
  hover.

### Fixed
- **Long conversations cost roughly ten times less.** Recalled memories were being inserted at a moving
  point in the request, which broke Anthropic's prompt cache between turns: every call re-wrote the whole
  context instead of reading it. Recall is now anchored to a fixed message, so the cache holds across turns
  (measured: cache reads up from ~56k to ~374k tokens, cache writes down from ~220k to ~8k).
- **Recall no longer leaks another project's memories.** Mid-turn recall resolved its scope from ambient
  async context, which could hand it the wrong project; it now receives the turn's scope explicitly.
- **The retrieval inspector searches across your projects again** and stops claiming "embeddings
  unconfigured" when embeddings are configured and simply nothing cleared the relevance threshold.
- **Recall survives steering.** Sending a message mid-turn no longer drops the memories already recalled for
  that turn, and compaction is detected by a shrinking history rather than a message count.
- **Recall falls back to keyword search when the vector pass finds nothing**, instead of returning nothing at
  all for a query too thin to score.
- **Phone notifications reach Apple again.** The VAPID contact is a real, configurable address (Settings →
  System) instead of a placeholder Apple rejects, a push is sent when the tab is merely backgrounded, and the
  daemon logs why a turn produced no notification.
- **Failed requests are no longer counted as prompt-cache drops**, so the cache-health signal means what it
  says.
- **"Reset usage" actually clears the charts.**
- **A dismissed plan stays dismissed**, and a large operator ruleset no longer breaks read-only delegation or
  trips the boundary cap.
- **Workflow nodes no longer show as "unknown" with no model.**

## [0.27.73] - 2026-07-20

### Added
- **The CLI shows what a long tool call is doing while it streams.** Instead of a generic "working" hint, a short action label in your language (e.g. "Píšu soubor readme.md…") appears next to the spinner while a long-running tool call is being written. Quick tools are unchanged.
- **Chat-adapter service language is now a dropdown.** Telegram, Discord and WhatsApp pick their service-message language (English / Čeština) from a styled picker in Settings, instead of typing a language code.

### Changed
- **Conversation auto-cleanup moved to Settings → Elowen AI.** The "delete idle conversations older than N days" control now lives with the other Elowen AI settings, rendered as a normal settings row, instead of floating on the sessions list.
- **Reasoning-effort changes settle before they're recorded.** Cycling quickly through reasoning levels no longer drops a marker into the transcript for every intermediate step — one marker lands once you settle on a level. The level itself still applies immediately.
- **Self-scheduled wake-ups keep their conversation and its context.** A wake-up (`ScheduleWakeup`) scheduled from a conversation now clearly resumes that same thread with its full context — to check back on a deploy, a CI run or any state that changes without notifying you — and the conversation is no longer auto-deleted while a wake-up into it is still pending.

### Fixed
- **Screenshots and images no longer bloat the conversation context.** Images read earlier in a session (screenshots, image files) are replaced with a placeholder in the model's context on later turns while staying visible on the turn they're used, so long sessions stay lean. MCP tool screenshots are now forwarded as real images instead of being stored as unreadable text.
- **Reasoning effort works for Qwen on Alibaba/DashScope.** Selecting low/medium/high on Qwen thinking models now takes effect — mapped to the endpoint's thinking budget with a matching completion cap — instead of being ignored or failing on medium/high.
- **Tool activity no longer shows "[exit 0]" for successful commands.** In the Discord/Telegram/WhatsApp chat adapters a clean command's result line surfaced a noisy `[exit 0]`; the exit status is now driven by structured signals, so a success shows its output (or nothing) and only a failure shows its exit code.

## [0.27.72] - 2026-07-20

### Added
- **Elowen AI can run as a task worker.** Any Elowen AI model enabled in Settings → Models can now be chosen as your Default worker in Account, and as a task or autopilot executor — not only as the chat model. The embedded brain runs the work in-process.
- **`/chat` goes fullscreen and works on mobile.** The full-page chat expands to a distraction-free fullscreen view and lays out responsively on small screens.

### Changed
- **The chat now loads long conversations lazily.** Opening a conversation fetches only the most recent messages and loads older ones as you scroll up, so a long history opens fast and stays responsive. Your reading position is preserved when older messages load, and scrolling up no longer jumps you back to the newest message while a reply is streaming.
- **The web chat renders tool activity and session changes inline**, matching the CLI: grouped tool calls, session-event markers (model or mode switches) and workflow runs now appear in the transcript.
- **Elowen AI is branded consistently in every model and worker picker** — one "Elowen AI" group carrying the Elowen mark, alongside Claude Code, Codex and OpenCode, with the underlying provider and auth source shown per model.

### Removed
- **OpenRouter free models are no longer listed.** The zero-cost `:free` catalog variants are dropped from the model pickers across the daemon, CLI and web.

### Fixed
- **A fresh install can complete setup from the browser.** First-run onboarding — detecting tooling, saving config and creating the first admin — is reachable again through the web app; previously the proxy rejected the tokenless setup requests, so the first admin could only be created from the CLI.
- **A completed tool's output renders live in the web chat**, instead of only after the conversation is reloaded.
- **Scheduled jobs (crons) fire on Windows.** The job's check no longer assumes a POSIX shell.

## [0.27.71] - 2026-07-19

### Added
- **A native web chat.** The `/chat` page and the docked chat now share one session-bound controller — the same brain `elowen chat` talks to — so switching between the dock, the full page and the CLI never drops your draft or a running answer. The transcript renders inline with lighter diffs and collapsible tool output.
- **A real `elowen chat` terminal inside the web (admins only).** From the dock's terminal picker an administrator can open the current conversation as a genuine CLI TUI, attached to the same brain session both ways. It launches over a per-terminal token that never leaves the daemon; detach, explicit stop and pop-out are all wired.
- **A visible model picker.** The active model is shown and switchable from the chat header and the dock, applied live to the bound conversation without losing history.
- **Cross-platform conversation resume (`/context`).** Discord, WhatsApp, Telegram and the web can re-bind a channel to any of your existing conversations through a paginated picker and continue with full history.
- **Elowen can search its own manual.** The bundled `ElowenDocs` tool finds the relevant shipped user-guide sections before the agent guesses about a setting or feature. It uses semantic search when memory embeddings are configured and a clearly labelled keyword search otherwise; it is deliberately separate from `CodebaseSearch`, which searches your projects.
- **`/cd [path]` changes the CLI working directory.** With no argument it shows the current directory; with a path it updates the local CLI context used by later prompts, `!` commands, attachments, exports, and history without widening daemon project access.
- **Old brain conversations can be cleaned up automatically.** Administrators can opt in to hourly cleanup of stale user conversations. It leaves active/running conversations, channel and task sessions, delegated children, and conversations with running children alone.
- **A foreground `Bash` command can be backgrounded with `Ctrl+B`.** Like a foreground sub-agent, it keeps running and sends its completion back asynchronously instead of holding the terminal chat open.
- **Proxied and custom models can show an estimated cost.** Elowen consults the bundled models.dev catalog when a provider does not report cost; provider-reported usage remains authoritative.

### Changed
- **The chat's Send button becomes a Stop button while a turn is running.** The separate "working" spinner is gone — the button itself signals the live state and stops the streaming answer on click.
- **One global personality.** Per-platform personality profiles collapse into a single global body, so Elowen reads the same way across the CLI, web and every chat platform.
- **A single source of truth for Discord slash commands.** The registered command list is derived directly from the daemon's command registry instead of a hand-maintained copy.
- **The CLI gives clearer live-work feedback.** It shows an activity indicator while a tool call streams and only shows the writing-tool-call hint after the call has genuinely spent time being composed.
- **OAuth providers disappear from the model picker once disconnected.** A saved provider entry no longer leaves a dead selectable account behind.
- **The focused sub-agent view includes its own context and cost.** A parent turn's failure no longer consumes the child delivery budget.

### Fixed
- **Fresh installs work again.** The `@earendil-works/pi-*` packages are now pinned to an exact version (`0.80.10`) instead of a caret range, so a fresh `npm install` no longer pulls a newer, incompatible PI release that crashed on start.
- **Duplicate Discord slash commands are gone.** A stuck global-command clear left `/status`, `/compact`, `/context` and friends registered twice; registration now self-heals.
- **A message arriving during compaction is rendered once.** It no longer appears twice when the compacted turn settles.
- **The CLI's transient notices expire instead of lingering above the composer.**
- **ElowenDocs results render as a compact tool marker in plugin presentations, rather than showing the full search result inline.**

## [0.27.6] - 2026-07-17

### Fixed
- **The image tools are named `GenerateImage` and `EditImage`**, not the `ImageGenerate` / `ImageEdit` that
  0.27.5 briefly migrated saved rules onto. A prefix is what a family of tools earns (`CronAdd`,
  `MemorySearch`, `Mem0Search`); image-gen and image-edit are one tool each, and a plugin like that reads
  verb-first — the same shape as `CreateSkill` and `ScanCode`. A rule 0.27.5 moved onto the prefix-first
  spelling is repaired on first start; the tools never answered to those names, so such a rule was matching
  nothing at all. Only relevant if you updated during 0.27.5.

## [0.27.5] - 2026-07-17

### Changed
- **The plugins you install from the registry now name their tools in TitleCase too**, finishing what
  0.27.4 started in the box: `todo_write` → `TodoWrite`, `web_search` → `WebSearch`,
  `generate_image` → `ImageGenerate`, and so on. Saved tool permissions, deny-lists and role allow-lists
  are migrated on first start, as they were for the built-ins.
  - mem0's tools are namespaced rather than renamed to `Memory*`: `add_memory` → `Mem0Add`,
    `search_memory` → `Mem0Search`. `MemorySearch` already belongs to Elowen's own memory, which mem0
    replaces rather than extends, and one name answering for two backends is how a call reaches the wrong
    store.
  - **Update the plugin to match.** The rename lands in the plugin's own release (todo 0.5.0, web 0.2.0,
    mem0 0.2.0, image-gen 0.2.0, image-edit 0.2.0), so between updating Elowen and updating the plugin your
    saved rule names the new tool while the installed plugin still offers the old one — and a rule that
    matches nothing is not enforced. Settings → Plugins shows what has an update.

### Fixed
- **The todo checklist works in Plan mode again**, along with mem0's recall. Plan mode now asks a tool to
  declare that it is safe rather than guessing from its name (0.27.4), and the registry plugins had not
  been taught to declare it — so the agent could no longer write its checklist while planning, which is
  exactly when it wants to.

## [0.27.4] - 2026-07-17

### Added
- **Sign in with a Kimi Code subscription.** Kimi (kimi.com) joins Claude, ChatGPT and GitHub Copilot as an
  account you sign in to instead of pasting an API key: pick it in `elowen setup` or under Settings →
  Elowen AI, approve the code your browser shows, and the subscription pays for the turns. Access renews
  itself in the background, so a signed-in account keeps working without you touching it. K3 and the rest
  of the Kimi Code catalog are available once you are in.
- **A sampling temperature per provider** (Settings → Elowen AI → the provider's Edit). Left empty, Elowen
  sends no temperature at all — which stays the default, because several models accept only their own: Kimi
  K3 answers `only 1 is allowed for this model`, and Claude Opus 4.7 and newer refuse a non-default value.
  Set it and every turn on that endpoint carries it.
- **Workflow mode, a third way to work alongside Build and Plan.** shift+tab now cycles Build → Plan →
  Workflow, or type `/workflow`. It primes the agent to break the task into a dependency graph and run it
  across sub-agents, while keeping the full toolset — unlike Plan mode it still does the small things
  itself. The prompt is user-overridable like the others.
- **Sub-agent workflows.** `WorkflowStart` / `WorkflowAddNodes` / `WorkflowStatus` build a declarative DAG
  the agent can extend while it runs. Each node runs as a sub-agent once its dependencies clear, inheriting
  the caller's access and never widening it. Live state shows in the telemetry rail and in a navigable
  modal where Enter drills into a node's own conversation — and a workflow is now kept with the
  conversation it ran in, so you can reopen it from history instead of losing it at the next reconnect.
- **The Telegram plugin** — optional, grammY-based, mirroring the Discord feature set: live streaming, tool
  trace, media, inline model and reasoning pickers, and account identity linking.
- **`/model <name>` takes an argument**, with autocomplete and fuzzy correction. A unique match applies
  straight away; anything ambiguous falls back to the picker.
- **`Delegate` can hand a sub-agent context.** An optional `context` param the parent passes down as a
  cache-friendly system-prompt block, so the child need not re-derive what the parent already established.
- **`/compact` takes an instruction**, so you can say what the summary must keep.
- **Changing a conversation's settings is recorded in it.** Switching model, work mode or reasoning effort
  mid-thread — or renaming the conversation — used to be invisible: the transcript said nothing and the
  agent carried on under settings it had no idea had changed. Each change is now a marker in the transcript
  and a one-shot note to the agent under your next message. The markers live outside the message history,
  so they never enter the model's context or disturb compaction.

### Changed
- **MCP tools are now named `mcp__<server>__<tool>`** (double underscores), matching the convention used
  elsewhere. The old single-underscore form could not be read back: a server called `chrome-devtools`
  offering `click` produced `mcp_chrome_devtools_click`, which is indistinguishable from a server called
  `chrome` offering `devtools_click`. Existing per-user disabled-tool lists and permission rules are
  migrated on first start. A rule for a server you have since removed from your config cannot be split
  back apart and is left as-is.
- **Plan mode now works from what tools declare, not from what they are called.** It used to guess which
  tools were safe to offer while the agent planned by reading the name — anything starting with `read_`,
  `list_`, `get_` and so on was assumed harmless. A tool called `get_and_purge` was assumed harmless too.
  Each tool now states whether it only reads, and Plan mode offers exactly those; anything that has not
  said so is withheld. No bundled tool changes behaviour. Plugin authors: declare `planSafe` in your
  manifest (see `docs/PLUGIN_DEV.md`) — until you do, your tools stay out of Plan mode.
- **Tools are now named in TitleCase.** Every tool the assistant calls was renamed from `snake_case` to
  TitleCase, and the frequently used ones lost their redundant suffix: `read_file` → `Read`,
  `write_file` → `Write`, `edit_file` → `Edit`, `search_files` → `Search`, `run_command` → `Bash`.
  Tools that belong to one service keep their family prefix (`MemorySearch`, `DiscordListChannels`,
  `WorkflowStart`). Everything you had already configured is migrated automatically on first start —
  saved tool permissions, per-user disabled-tool lists, and platform role tool allow-lists — so nothing
  you switched off comes back on, and no role loses its tools.
  - Tools reached over MCP are unchanged: both the ones Elowen exposes to other MCP clients and the
    `mcp_*` tools bridged in from a remote server keep their names, so existing MCP setups keep working.
  - **Breaking for scripts:** tool names appear in `elowen run --json` events, on the `/brain/stream`
    SSE feed and in exported sessions. Anything matching on a specific tool name needs updating.
  - **Breaking for plugin authors:** third-party plugins keep working with `snake_case` names, but
    TitleCase is now the documented convention (see `docs/PLUGIN_DEV.md`).
- **The plugin detail page is rebuilt in the settings card language.** Capabilities, Data and Logs are now
  discrete cards with their content shown inline, instead of collapsed hairline accordions that read as a
  stack of stray lines; the schema-driven config editor renders one card per declared section; and the hero
  states version, source and tools as chips.
- **The CLI's activity spinner sits next to the mode label**, where you are already looking, instead of far
  off to the right of it.

### Fixed
- **Kimi K3's thinking was invisible to Elowen.** K3 always reasons, but Elowen believed it did not reason
  at all and would not let you set its effort. The model catalog Elowen refreshes from covers the endpoints
  it ships — except that Moonshot and Kimi Code had been left off the list, so their models arrived with no
  capabilities at all. Both are now included.
- **Kimi and GitHub Copilot models show their brand icon** in the web UI, rather than the generic glyph.
- **Over-wide diff lines wrap under the gutter** in the CLI instead of being truncated.
- **The stats usage table's headers line up with their columns** again.
- **One keypress no longer fires twice** in terminals that report Kitty keyboard-protocol release events —
  notably the VS Code integrated terminal, where arrow and reasoning actions triggered in pairs.

## [0.27.3] - 2026-07-15

### Fixed
- **A long scheduled report arrives in full instead of clipped.** A cron reply that ran past one message's
  limit was cut off mid-content; it is now split across messages, so a large report — a full list, a long
  digest — comes through complete. How much of a guard `check`'s output is fed into the run is configurable
  too (Settings → Plugins → cronjob), for collectors that emit a lot of data.
- **The cron editor saves one job at a time.** Saving from a page that had gone stale used to rewrite the
  whole jobs array and could silently drop jobs added in the meantime by the scheduler or the assistant's
  own cron tools; each row now persists on its own, and a corrupt jobs file is left untouched rather than
  rebuilt from empty.
- **No more black patches in the CLI panels.** An ANSI reset inside a coloured row wiped the row's
  background, so padding and the gaps between coloured words fell through to the terminal default as black
  stripes; every row now re-applies its background after each reset.
- **Repeated tool calls collapse in Discord.** Consecutive calls to the same tool now fold into a single
  "tool ×N" line instead of one line each.
- **The editor's file list and code pane scroll again and fit the window.** The editor had lost its
  scrollbars and stopped adapting to the screen height when its wrapper carried no height of its own.
- **Scheduled jobs now run on YOUR clock, not the server's.** "daily 07:30" meant 07:30 wherever the daemon
  happened to be hosted — so a Prague user on a US server got their morning report in the afternoon. Every
  schedule (`daily`, `weekly`, cron expressions, active-hours windows, and `at HH:MM` wake-ups) is now read
  in the timezone configured under Settings → Plugins → runtime-context, which is the single place the
  assistant's clock is set: the same value that stamps the date and time into every turn. An empty setting
  means the server's own timezone (previously it silently assumed Europe/Prague).
- **A job in the repeated hour of the autumn clock change fires once, not twice.** That hour genuinely
  happens twice, so a job matched on the instant alone ran twice; it is now keyed on the wall-clock minute.
  (In spring, a time the clock skips is skipped for that day — standard cron behaviour.)

### Changed
- **`elowen chat` now opens a blank conversation.** Launching the CLI used to silently resume whatever was
  last said in that directory, which made every launch a guess about your intent. Nothing is lost: `-c` /
  `--continue` resumes the directory's last conversation, `--session <id>` reopens a specific one, and
  `/resume` reaches any of them from inside the chat. Blank conversations left behind by a launch you never
  typed into are swept away, so the resume picker does not fill up with nothing.
- **An idle conversation a terminal still has open is no longer rolled over.** The idle cutoff exists to
  avoid re-sending a stale context at full price once the prompt cache has expired — fair for a conversation
  nobody is watching, wrong for one you are sitting in front of. Step away, come back, type: your thread is
  still there. Web, Discord and cron are unaffected.

### Added
- **`read_file` reads PDFs.** Pass `pages` ("3", "1-5", "1,3,5"; max 20 per call). Pages with a text layer
  come back as text; a scanned page with no text layer is rendered and returned as an image. Requires
  poppler (`pdftotext`/`pdftoppm`), and says so plainly when it is missing.
- **`delegate` can hand a sub-agent a narrower toolset.** `read_only: true` gives it look-but-don't-touch
  tools (no writing, no shell, no further delegation); `tools: [...]` gives it exactly the tools you name.
  Either way it can only ever narrow your own access, never widen it.
- **Editing a file you have not read is refused.** `edit_file` / `write_file` now require that the
  conversation has actually read an existing file, and that it still holds the bytes you saw — writing from
  assumption, or over content that moved under you, is how work gets silently discarded. Creating a new file
  is unaffected.
- **`run_command` takes a `timeout`** (seconds, up to 600), so a slow but finite command — an install, a full
  build — can finish in the foreground instead of being pushed to the background just to survive the clock.
- **`read_process_output` can block.** `block: true` waits for a background process to finish (bounded by
  `timeout`) instead of making the agent poll it in a loop.
- **`cron_add` accepts standard 5-field cron expressions** (`0 9 * * 1-5`) alongside the plain forms
  ("every 15m", "daily 07:30"). The format is detected automatically.
- **`ask_user_question` options can carry a `preview`** — an ASCII mockup, a code snippet, a diagram. The
  picker then shows the focused option's preview beside the list, in the CLI and the web UI, so a choice
  between layouts or shapes can be seen rather than described.
- **`elowen_update_task`** — move a task through its lifecycle, rename it, or revise its description. The
  brain could open a task but never advance it.

## [1.8.7] - 2026-07-06

### Added
- **Setup now gets you to a working agent out of the box.** `elowen setup` verifies the agent actually
  answers (a real one-shot **chat smoke-test**), points tasks at Elowen's **built-in engine**
  (`elowen:<provider>/<model>`) so they run on *any* provider without a separate agent CLI, seeds a default
  tool set (files, terminal, askuser, runtime-context, skills, subagent) on a fresh install, and ends with
  a **readiness matrix** plus the web URL and login.
- **`elowen doctor`** — an on-demand readiness report (chat, tasks, missions, memory, platforms, plugins),
  each check with a fix hint; exits non-zero when something needs attention.
- **Non-interactive setup** — `elowen setup --non-interactive` runs the whole onboarding from flags/env (no
  prompts) for agents and CI, with correct exit codes. See Install → Non-interactive setup.
- **CLI chat redesign** — the `elowen chat` terminal UI gets a refreshed layout and switchable colour themes
  (Elowen / blue / mono).

### Changed
- New daemon endpoints back the above: `POST /brain/test` (one-shot completion) and `GET /system/readiness`.

## [1.8.6] - 2026-07-06

### Added
- **More AI-provider presets in the setup wizard.** The AI step's "Use an API key" list now covers the
  common providers out of the box, each with its base URL prefilled: OpenAI, Anthropic, OpenRouter, Google
  Gemini, xAI (Grok), DeepSeek, Groq, Mistral, Together AI, Fireworks AI, Cerebras, Perplexity, DeepInfra,
  Moonshot (Kimi), Z.AI (GLM), NVIDIA NIM, Hugging Face, Baseten, Ollama Cloud. Anything else still goes
  through "Custom OpenAI-compatible endpoint". Listed under Brain & Chat → Supported providers in the docs.

## [1.8.5] - 2026-07-06

### Fixed
- **OpenAI (Codex) sign-in now completes over SSH / on a remote box.** The setup wizard used OpenAI's
  browser OAuth, which redirects to a `localhost:1455` loopback the remote box can't receive — the page
  just kept "loading" and the sign-in never finished. It now uses OpenAI's **device-code** flow: it shows
  a short code and `auth.openai.com/codex/device`, you enter the code, and it polls to completion — no
  loopback, no copy-pasting a redirect URL. Anthropic keeps its paste-back flow, and the waiting spinner
  is always stopped before any prompt so it never obscures it.

### Changed
- `POST /brain/oauth/:type/start` accepts a `method` (e.g. `device_code`) so a caller can pick a provider's
  login sub-flow instead of always taking the first.

## [1.8.4] - 2026-07-06

### Fixed
- Complete the 1.8.3 install/setup unification in the source tree — the `v1.8.3` tag was missing the file
  moves (the published npm package was already complete); `v1.8.4` has the full, buildable tree.
- `elowen setup` in a non-interactive shell now words its guidance for an interactive terminal and honors
  `--reset`; the launcher's "open web UI" prints the URL over SSH instead of claiming a browser opened.

### Changed
- Post-review cleanup: removed dead code (an unused step-result field), de-duplicated the cross-platform
  browser opener between the launcher and the wizard, and simplified slug/id derivation. No wizard
  behavior change.

## [1.8.3] - 2026-07-06

### Changed
- **`elowen install` now runs the same onboarding wizard as `elowen setup`.** The interactive install used to
  have its own first-run wizard (admin + autopilot + GitHub) that overlapped the setup wizard; there is now
  a single onboarding path — account, project, AI provider, memory. The autopilot CLI-engine choice and the
  GitHub PR-workflow prompt live in the web Settings; unattended (flag-driven) installs are unchanged.

## [1.8.2] - 2026-07-06

### Fixed
- **Setup-wizard OAuth no longer looks stuck.** The AI-provider OAuth step ran a spinner while showing the
  authorization URL and the paste-code prompt, which hid them — the sign-in appeared frozen and never
  surfaced the field to paste the redirect URL back. It now uses the same linear paste-back flow as the web
  dialog: show the URL (open the browser best-effort), then prompt for the pasted redirect URL / code with
  nothing competing for the screen.

## [1.8.1] - 2026-07-06

### Added
- **First-install onboarding wizard (`elowen setup`)** — a guided terminal wizard so a fresh
  `npm install -g elowen` reaches a working setup without hunting through config. Five skippable,
  reversible steps: **account**, **default project**, **AI provider**, **memory**, **review**. The
  launcher offers it once on a fresh install (never re-nagging after completion, with resume for an
  interrupted run) and `elowen setup` runs it any time (`--reset` to start over).
  - **AI provider** step covers an API key, a custom OpenAI-compatible endpoint, and OAuth sign-in
    (Claude / GitHub Copilot / Codex-OpenAI) with a cross-platform browser opener and a printed-URL
    fallback for headless boxes; already-connected accounts are offered for reuse.
  - **Memory** step reuses the AI provider's key with a recommended embedding model (or OpenRouter) and
    validates it with the embedding self-test — never blocking completion on a failure.
  - Non-interactive shells (CI / Docker / pipes) never block: the command prints a next step and exits 0.
    No postinstall script. All configuration flows through the daemon API.

## [1.8.0] - 2026-07-06

### Added
- **"Talk to Elowen" in the launcher** — running `elowen` in a terminal now offers *Talk to Elowen* as the first
  menu action, dropping you straight into the interactive terminal chat (still reachable directly via
  `elowen chat`).
- **Rewritten user manual** — the documentation site is a full agent-first guide (getting started, install,
  tasks & missions, agents & autonomy, web UI, CLI, brain & chat, plugins, projects, configuration,
  account & security, architecture), now illustrated with screenshots.
- **Plugin illustrations** — each bundled plugin ships an illustration shown on its detail page.
- **MCP bridge plugin (`mcp` 0.1.1)** — connect external Model Context Protocol servers and expose their
  tools to the assistant. Three transports: **stdio** (local process, e.g. `npx …`), **HTTP** (streamable)
  and **SSE** (remote URL). stdio servers run in their own process group and are killed as a group on
  reload/disable, so `npx` child processes are never orphaned. Configured per server in Settings → Plugins
  (name · transport · command/args/env or URL · enabled).
- **Configurable agent step limit** — Settings → Elowen AI → *Max agent steps* (1–200, default 20). The turn
  is aborted once the agent exceeds it, preventing runaway loops. Discord shows the live `Step N / MAX`
  counter in the existing status message.
- **Per-model context windows** — Settings → Elowen AI lets you pin the max context window (tokens) for each
  Elowen AI model, for endpoints that don't report one reliably. Drives the context-usage % and the
  (auto-)compaction trigger; falls back to a default when unset.
- **Open a session in the web chat** — clicking a conversation in Sessions opens it in the web chat dock and
  continues it with full history.

### Changed
- **Consistent "+N more" pills** — every collapsed pill row (plugin config, cron channel/model pickers, user
  tool access, model catalog) now uses one shared pill control instead of a mix of pills, links and dashed
  variants.
- **Step counter is a stall hint now** — on Discord and WhatsApp the `Step N / MAX` line no longer shows on
  every turn; it surfaces only after ~60 s with no visible progress (so a slow step doesn't read as a stuck
  agent) and clears again on the next tool call or reply.

### Fixed
- **`/compact`** — no longer surfaces an opaque error when there is nothing to compact (too small / already
  compacted); it reports a friendly notice instead, and the owner-chat path is now serialized against the
  running turn (parity with channel sessions). Works across Discord, CLI and web.
- **Vision-fallback reasoning leak** — inline `<think>…</think>` chain-of-thought some vision models emit in
  the text stream is now stripped before it reaches any user-visible reply (single source in `extractText`).
- **Discord output** — generated images (`image_gen` / `image_edit`) are posted as their own message above
  the final status/footer message instead of pinned under the usage stats; the todo checklist renders as a
  visually separated block rather than another tool line.
