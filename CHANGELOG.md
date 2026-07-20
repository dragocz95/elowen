# Changelog

All notable changes to Elowen are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/); the daemon version is the root `package.json` version.

## [Unreleased]

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
