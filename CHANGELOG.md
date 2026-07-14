# Changelog

All notable changes to Elowen are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/); the daemon version is the root `package.json` version.

## [Unreleased]

### Fixed
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
