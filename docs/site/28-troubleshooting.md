---
title: Troubleshooting
slug: troubleshooting
order: 28
eyebrow: Help
group: Help
---

# Troubleshooting

Use this page when a service is unavailable, a session does not answer, a tool is missing, or an update behaves unexpectedly. Start with the readiness check, then inspect the affected service and session.

## Start with `elowen doctor`

Run:

```bash
elowen doctor
```

`doctor` checks the daemon health endpoint and the authenticated readiness report for providers, memory, and plugins. In a TTY it asks for administrator credentials. For scripts and CI, provide a bearer token:

```bash
ELOWEN_TOKEN='…' elowen doctor
```

The daemon must already be running; `doctor` does not start it. If the health check fails:

```bash
elowen up
```

The authenticated readiness report is also available at `GET /system/readiness`.

## A service is down

Elowen runs two managed services:

- **daemon** — API, brain sessions, storage, plugin registry, and background work; normally `127.0.0.1:4400`;
- **web** — the separate browser application; normally `http://localhost:4500`.

Check both services and their health:

```bash
elowen status
```

Start, stop, or restart them with:

```bash
elowen up
elowen down
elowen restart all
```

`elowen down` drains active sessions and delegated work. Use `elowen down --force` only when that work must be abandoned.

For systemd installations:

```bash
systemctl status elowen-daemon elowen-web
journalctl -u elowen-daemon -n 100 --no-pager
journalctl -u elowen-web -n 100 --no-pager
```

### The daemon exits immediately

Check the port, Node.js version, and daemon log:

```bash
ss -ltnp | grep -E ':(4400|4500)\b'
node --version
journalctl -u elowen-daemon -n 100 --no-pager
```

Common causes include:

- another process owns `ELOWEN_PORT`;
- Node.js is older than the required version (`>=22`);
- the SQLite database and `plugin-secrets.key` came from different backups;
- a source checkout has built the daemon but not the web bundle (`npm run build` and `npm run build:web` are separate);
- a required local dependency, such as `tmux` for terminal sessions, is unavailable.

The embedded brain does not require `tmux` for ordinary chat. The forked sub-agent runner is a separate child-process pool; runner failures affect delegated work, not the daemon's ability to answer ordinary turns.

## A turn or session does not answer

First establish whether the problem is the service or the live session:

1. Run `elowen doctor` and `elowen status`.
2. In interactive chat, run `/stats` to inspect the active model, usage, and context; `/context` opens the context breakdown in the CLI.
3. Check `GET /brain/status` for the current authenticated conversation. It reports live-session state, queued work, parked questions, and runtime diagnostics.
4. Check the daemon log for provider errors, rate limits, expired credentials, or a session recovery message.

If the session is waiting for a question or approval, answer it in the same interactive surface. Headless runs, scheduled jobs, and delegated children cannot answer interactively; their unattended policy decides whether an approval ask is blocked or allowed. Channel adapters that implement interactive prompts, such as Discord, Telegram, Microsoft Teams, and WhatsApp, can render and settle supported questions in the channel.

If a session is stuck on an old context window, use `/compact` or start a fresh conversation with `/new`. Compaction preserves the durable conversation but summarizes older context, so important decisions should also be stored in Memory.

A browser spinner can also indicate a broken reverse proxy or closed SSE stream. Check both the browser console and daemon log before retrying.

## A tool or plugin is missing

Tool availability is the result of the live plugin registry plus the account's access boundary. Check in this order:

1. The plugin is enabled in **Settings → Plugins → Installed**.
2. The account has its required per-user plugin grant.
3. Required plugin configuration and credentials are complete.
4. The plugin's **Capabilities** and **Activity** views show no load error.
5. Run `/tools` in a new turn.

A plugin install, update, enable, or disable can be **pending** while active work settles. Do not repeat it; wait for the registry reload result. A successful live reload changes future turns without restarting the daemon.

For MCP tools, inspect the server in the **MCP** page. Reconnect the server after fixing its endpoint or command. Deferred MCP tools are intentionally advertised without their full schema until `ToolSearch` loads them; this is not a permission failure.

## A tool is denied or asks repeatedly

Open **Account → Elowen AI → Command permissions**. Rules are `allow`, `ask`, or `deny`, and the last matching rule wins. `/yolo` changes only the current CLI session; it cannot override a deny rule or an unattended block.

A delegated child receives a captured permission boundary. Changing the parent account's settings does not widen an already-running child. A read-only child also has a narrower tool set and is not a filesystem sandbox.

## Delegated work or the runner failed

`Delegate` creates a child session. The forked sub-agent runner normally executes delegated turns in a separate process pool so a child cannot monopolize the daemon event loop. Check the parent conversation's delegated-work view and the daemon log for messages such as `sub-agent runner exited`, `no live runner`, or a build mismatch.

If the runner pool is disabled or unavailable, the daemon may run a delegated turn in-process when that fallback is permitted. Otherwise the child remains failed or parked for recovery. Do not retry blindly: inspect whether the child already completed, is still running in another runner, or was interrupted.

`WorkflowStart` runs a DAG: independent nodes run in parallel and dependent nodes wait. Use `WorkflowResume` for unfinished nodes after an interruption; completed nodes are not replayed.

## A project or workspace is wrong

Projects are registered access boundaries. Confirm the selected Project in **Projects** and the active Sandbox workspace. A workspace is an account-owned Git worktree, not the Project directory itself.

A delegated child inherits the relevant project and workspace scope and cannot widen it. A dirty worktree, untracked file, unique commit, or active process can prevent workspace removal. Plan mode and read-only mode are additional execution guardrails, not replacements for Project or Sandbox isolation.

## Memory or semantic search returns nothing

Memory is account-scoped and may be organized under a project category. Check **Settings → Memory** for the embedding and categorization models, then verify that the fact exists and is categorized. Without an embedding model, keyword retrieval can still work, but semantic search is unavailable.

Compaction affects the active conversation context, not durable Memory. Do not expect another account's memories to appear.

## A channel integration is silent

Run `elowen doctor`, then inspect the channel plugin:

- it is enabled and its credentials are valid;
- the sender, server, chat, or thread is allowed;
- group replies and mention requirements are satisfied;
- the sender is linked or admitted according to the plugin's access rules.

For a reverse-proxied webhook, forward `/hooks/` to the daemon. The web UI can work while webhook routing is missing. See [Production & Updates](production-updates).

Never paste provider tokens into chat or logs.

## The web UI does not load

```bash
elowen status
journalctl -u elowen-web -n 100 --no-pager
```

Then verify the configured web port, `ELOWEN_DAEMON_URL`, reverse-proxy streaming routes, and browser asset freshness. The daemon binds to localhost by default; do not expose port `4400` directly to the internet.

After an update, confirm both services and the daemon health endpoint:

```bash
systemctl is-active elowen-daemon elowen-web
curl -fsS http://127.0.0.1:4400/health
```

## Compaction and lost context

Long sessions are compacted when they approach the configured context threshold. Use `/stats` or `/context` to inspect usage and `/compact` to request compaction deliberately. A compaction summary is not a verbatim copy of every old turn; store durable decisions in Memory and use `/new` for a clean investigation.

If automatic compaction repeatedly fails, inspect the daemon log and the account's selected compaction model. The brain limit **Compaction failure limit** stops repeated retries after three consecutive failures.

## Logs and persistent data

The default state directory is `~/.config/elowen`; `ELOWEN_DB` can move the database and matching secret key, while `ELOWEN_LOG_DIR` can override the log directory. Other state directories continue to follow the data directory.

```text
~/.config/elowen/elowen.db
~/.config/elowen/plugin-secrets.key
~/.config/elowen/logs/daemon-YYYY-MM-DD.log
~/.config/elowen/logs/web-YYYY-MM-DD.log
~/.config/elowen/brain/
~/.config/elowen/plugins/
~/.config/elowen/plugins-data/
~/.config/elowen/plans/
~/.config/elowen/tool-results/
```

The database is not the whole installation. Back up the complete configuration directory when possible; always keep the database and matching `plugin-secrets.key` together. Increase `ELOWEN_LOG_LEVEL` to `debug` temporarily, then restore `info`.

## Updates, releases, and migrations

For an installed instance, use the lifecycle command:

```bash
elowen update
```

It checks the npm registry, installs the latest published Elowen package, and restarts the managed services. A plain `npm update -g elowen` changes package files but does not restart already-running services. Automatic updates are opt-in.

A source checkout can contain a newer version than npm. Check the local package with `elowen --version`; do not treat a local version or git commit as published until the public registry and release repository say so.

Database migrations run automatically when the daemon boots. Before a version jump, create a recoverable backup. If the new daemon fails to start, preserve the logs and inspect the journal before attempting another update; never delete migration or lock files as a workaround.

## Reset and recovery

- **Conversation:** `/new` starts another durable conversation; `/clear` empties the current history while keeping its identity.
- **Memory:** remove individual memories or categories from the Memory page.
- **Setup:** `elowen setup` can fill missing configuration.
- **Full reset:** stop Elowen and make a verified backup before removing the normal state directory. If `ELOWEN_DB` points elsewhere, also remove that database and the matching `plugin-secrets.key` beside it. A custom database path does not move plugin data, OAuth credentials, plans, attachments, or logs out of the normal state directory. This destroys all persisted Elowen state.

[Next: Glossary](glossary)
