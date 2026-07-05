# Changelog

All notable changes to Orcasynth are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/); the daemon version is the root `package.json` version.

## [Unreleased]

### Added
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

### Fixed
- **`/compact`** — no longer surfaces an opaque error when there is nothing to compact (too small / already
  compacted); it reports a friendly notice instead, and the owner-chat path is now serialized against the
  running turn (parity with channel sessions). Works across Discord, CLI and web.
- **Vision-fallback reasoning leak** — inline `<think>…</think>` chain-of-thought some vision models emit in
  the text stream is now stripped before it reaches any user-visible reply (single source in `extractText`).
- **Discord output** — generated images (`image_gen` / `image_edit`) are posted as their own message above
  the final status/footer message instead of pinned under the usage stats; the todo checklist renders as a
  visually separated block rather than another tool line.
