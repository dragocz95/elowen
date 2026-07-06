# Changelog

All notable changes to Orcasynth are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/); the daemon version is the root `package.json` version.

## [1.8.7] - 2026-07-06

### Added
- **Setup now gets you to a working agent out of the box.** `orca setup` verifies the agent actually
  answers (a real one-shot **chat smoke-test**), points tasks at Orca's **built-in engine**
  (`orca:<provider>/<model>`) so they run on *any* provider without a separate agent CLI, seeds a default
  tool set (files, terminal, askuser, runtime-context, skills, subagent) on a fresh install, and ends with
  a **readiness matrix** plus the web URL and login.
- **`orca doctor`** — an on-demand readiness report (chat, tasks, missions, memory, platforms, plugins),
  each check with a fix hint; exits non-zero when something needs attention.
- **Non-interactive setup** — `orca setup --non-interactive` runs the whole onboarding from flags/env (no
  prompts) for agents and CI, with correct exit codes. See Install → Non-interactive setup.
- **CLI chat redesign** — the `orca chat` terminal UI gets a refreshed layout and switchable colour themes
  (Orca / blue / mono).

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
- `orca setup` in a non-interactive shell now words its guidance for an interactive terminal and honors
  `--reset`; the launcher's "open web UI" prints the URL over SSH instead of claiming a browser opened.

### Changed
- Post-review cleanup: removed dead code (an unused step-result field), de-duplicated the cross-platform
  browser opener between the launcher and the wizard, and simplified slug/id derivation. No wizard
  behavior change.

## [1.8.3] - 2026-07-06

### Changed
- **`orca install` now runs the same onboarding wizard as `orca setup`.** The interactive install used to
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
- **First-install onboarding wizard (`orca setup`)** — a guided terminal wizard so a fresh
  `npm install -g orcasynth` reaches a working setup without hunting through config. Five skippable,
  reversible steps: **account**, **default project**, **AI provider**, **memory**, **review**. The
  launcher offers it once on a fresh install (never re-nagging after completion, with resume for an
  interrupted run) and `orca setup` runs it any time (`--reset` to start over).
  - **AI provider** step covers an API key, a custom OpenAI-compatible endpoint, and OAuth sign-in
    (Claude / GitHub Copilot / Codex-OpenAI) with a cross-platform browser opener and a printed-URL
    fallback for headless boxes; already-connected accounts are offered for reuse.
  - **Memory** step reuses the AI provider's key with a recommended embedding model (or OpenRouter) and
    validates it with the embedding self-test — never blocking completion on a failure.
  - Non-interactive shells (CI / Docker / pipes) never block: the command prints a next step and exits 0.
    No postinstall script. All configuration flows through the daemon API.

## [1.8.0] - 2026-07-06

### Added
- **"Talk to Orca" in the launcher** — running `orca` in a terminal now offers *Talk to Orca* as the first
  menu action, dropping you straight into the interactive terminal chat (still reachable directly via
  `orca chat`).
- **Rewritten user manual** — the documentation site is a full agent-first guide (getting started, install,
  tasks & missions, agents & autonomy, web UI, CLI, brain & chat, plugins, projects, configuration,
  account & security, architecture), now illustrated with screenshots.
- **Plugin illustrations** — each bundled plugin ships an illustration shown on its detail page.
- **MCP bridge plugin (`mcp` 0.1.1)** — connect external Model Context Protocol servers and expose their
  tools to the assistant. Three transports: **stdio** (local process, e.g. `npx …`), **HTTP** (streamable)
  and **SSE** (remote URL). stdio servers run in their own process group and are killed as a group on
  reload/disable, so `npx` child processes are never orphaned. Configured per server in Settings → Plugins
  (name · transport · command/args/env or URL · enabled).
- **Configurable agent step limit** — Settings → Orca AI → *Max agent steps* (1–200, default 20). The turn
  is aborted once the agent exceeds it, preventing runaway loops. Discord shows the live `Step N / MAX`
  counter in the existing status message.
- **Per-model context windows** — Settings → Orca AI lets you pin the max context window (tokens) for each
  Orca AI model, for endpoints that don't report one reliably. Drives the context-usage % and the
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
