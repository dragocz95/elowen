---
title: Troubleshooting
slug: troubleshooting
order: 28
eyebrow: Help
group: Help
---

# Troubleshooting

Use this page when Elowen is not starting, the web UI is unavailable, a chat turn fails, or a tool cannot run. Start with the readiness check, then inspect the service and daemon logs.

## Start with `elowen doctor`

Run:

```bash
elowen doctor
```

`doctor` is read-only. It checks whether the daemon is healthy, whether an AI model can answer, whether plugin secrets are readable, and which optional plugins and platforms are enabled. A terminal prompts for an admin login. For scripts or CI, provide a bearer token instead:

```bash
ELOWEN_TOKEN='…' elowen doctor
```

The daemon must already be running; `doctor` does not start it. If the health check fails, start Elowen first:

```bash
elowen up
```

The same readiness information is available to an authenticated administrator at `GET /system/readiness`.

## The services are down

Elowen has two processes:

- the daemon, normally on `127.0.0.1:4400`;
- the web UI, normally on `http://localhost:4500`.

Check both:

```bash
elowen status
```

Start or stop them with:

```bash
elowen up
elowen down
```

`elowen down` waits for running turns and sub-agents to finish. To stop immediately instead:

```bash
elowen down --force
```

The forced stop drops work that is still running. Use it only when the normal drain is not acceptable.

### The daemon exits immediately

Check the daemon log and the port:

```bash
ss -ltnp | grep -E ':(4400|4500)\\b'
journalctl -u elowen-daemon -n 100 --no-pager
```

Common causes:

- **Port conflict.** Another process owns the daemon port. Stop that process or configure a different `ELOWEN_PORT`.
- **Unsupported Node.js.** The package requires Node.js 22 or newer: `node --version`.
- **Database or secret mismatch.** The database and `plugin-secrets.key` must come from the same backup; restoring only one can make plugin secrets unavailable.
- **Missing terminal dependency.** `tmux` is needed for terminal sessions. It is not required for the embedded brain to answer ordinary chat messages.
- **A source build is incomplete.** `npm run build` builds the daemon; build the web bundle separately with `npm run build:web`. Starting `node dist/daemon/index.js` does not start the web UI.

For an installation managed by systemd, inspect both units:

```bash
systemctl status elowen-daemon elowen-web
journalctl -u elowen-daemon -f
journalctl -u elowen-web -f
```

## Stopping is taking a long time

A normal stop drains in-flight turns and delegated sub-agents before exiting. This can take several minutes. The daemon logs the remaining running work while it waits.

If the drain is stuck:

1. Check the daemon log for the turn or sub-agent that is still active.
2. Send `/stop` in the affected conversation when possible.
3. Use `elowen down --force` only if the process must stop now; unfinished work is lost.

## Chat does not answer

First check the provider and model configuration:

1. Run `elowen doctor`.
2. In **Settings → Elowen AI**, check that at least one provider account or API-key provider is connected.
3. In **Settings → Models**, check that the model is available and enabled.
4. In **Account → Elowen AI**, check the account's selected model. An empty account override means “use the server default”.
5. Check the daemon log for the provider's error, rate limit, expired credential, or invalid endpoint.

For an interactive conversation, `/stats` shows the active model and usage. `/model` opens the model picker where that surface supports it.

If the web chat shows a spinner indefinitely, check both the browser console and the daemon log. A broken reverse proxy, a closed SSE connection, or a daemon restart can interrupt the stream; reload the page and verify the daemon health before retrying.

## A tool is denied or asks repeatedly

Tool access is controlled per account. Open **Account → Elowen AI → Permissions** and inspect the rule for the command or tool. Rules can be `allow`, `ask`, or `deny`; the last matching rule wins.

Other relevant controls:

- `/yolo on` or `/yolo off` changes automatic approval for the current CLI session.
- The persistent YOLO default is edited in **Account → Elowen AI**. It is separate from the session override.
- In unattended runs, **Unattended asks** controls whether an unanswered approval is allowed or denied.
- A delegated child receives a captured permission boundary. Changing the parent account's settings does not grant an already-running child wider access.

A permission error is not fixed by retrying the same prompt. Change the rule only when the command is genuinely authorized.

## A project or workspace is wrong

Projects define the directories an account may access. Check the project in **Projects**, then confirm that the conversation is using the intended project.

If the account uses Sandbox workspaces:

- the active workspace is an account-owned Git worktree, not the project directory itself;
- a workspace is visible only for projects the account can access;
- a dirty workspace, untracked files, unique commits, or active processes can prevent workspace removal;
- a delegated child inherits the relevant account and workspace scope, but cannot widen it.

For shell and terminal problems, confirm `tmux` is installed and inspect the terminal panel or the daemon log. Sandbox isolation is a security boundary for execution; plan mode's write restrictions are a separate guardrail.

## Memory is missing or search returns nothing

Memory is optional. Without an embedding provider, Elowen can still use keyword retrieval; semantic search requires an embedding model.

Check:

1. **Settings → Memory** for the embedding and categorization configuration.
2. The memory's account and project scope. Memories belong to the account that stored them and may be filed under a project category.
3. Whether the fact was saved. Automatic save is off by default; explicit memory operations are more reliable for important decisions.
4. Whether the query uses the same terms when retrieval is keyword-only.

Do not expect a memory from another account to appear in the current conversation. Compaction can shorten active context, but durable memories remain stored separately.

## A channel bot is silent

Run `elowen doctor` and check the **Platforms** row. Then check the channel plugin's own settings and logs:

- the plugin is enabled in **Settings → Plugins**;
- credentials are still valid;
- the sender, server, chat, or thread is allowed by that platform's configuration;
- group replies are permitted by the platform settings, including mention requirements where applicable;
- the sender is linked or admitted according to the channel plugin's access rules.

For inbound webhooks behind a reverse proxy, verify that `/hooks/` is forwarded to the daemon. A hand-written virtual-host configuration can omit this route even when the web UI works. Re-run the managed setup or add the `/hooks/` proxy location as described in [Production & Updates](production-updates).

If a platform reports that a credential is invalid, fix it in that plugin's settings and reconnect. Do not paste provider tokens into chat or logs.

## GitHub actions are unavailable

GitHub is account-scoped. Check the GitHub panel for the current account:

- the Elowen account is linked to GitHub;
- the connection does not show **reconnect required**;
- the current project has an active repository mapping;
- the account can access that project.

A GitHub connection or mapping from another Elowen account is not reused. If a device-login flow expired, start a new connection from the GitHub panel.

## The web UI does not load

Check the service status and web log:

```bash
elowen status
journalctl -u elowen-web -n 100 --no-pager
```

Then verify:

- the browser is using the configured web port, normally `http://localhost:4500`;
- the web process can reach the daemon on its configured `ELOWEN_DAEMON_URL`;
- a reverse proxy forwards the web UI and the daemon's streaming and webhook paths;
- the browser is not serving stale assets after an update.

The daemon binds to localhost by default. Do not expose port 4400 directly to the internet: a daemon bearer token can control powerful operations. Put the web app or a deliberate reverse proxy in front of it instead.

Authentication is open during first-user setup only. After an account exists, ordinary daemon requests require a bearer token. `ELOWEN_ALLOW_OPEN=1` is not a general authentication bypass.

## Conversations lose context

Long conversations eventually approach the model context limit. Elowen can compact older messages into a summary. This is expected behavior, but a summary may omit nuance from very old turns.

Use:

- `/stats` to inspect model and context usage;
- `/context` in the CLI for a context breakdown;
- `/compact` to compact deliberately;
- `/new` to start a fresh conversation;
- `/clear` in the web or CLI to empty the current conversation while keeping its identity.

Store durable decisions in Memory rather than relying on an old conversation remaining in the active context.

## Logs and persistent data

The default state directory is `~/.config/elowen`. Override the database and log locations with `ELOWEN_DB` and `ELOWEN_LOG_DIR`.

Important locations include:

```text
~/.config/elowen/elowen.db
~/.config/elowen/plugin-secrets.key
~/.config/elowen/logs/daemon-YYYY-MM-DD.log
~/.config/elowen/logs/web-YYYY-MM-DD.log
~/.config/elowen/brain/          # provider and OAuth credentials
~/.config/elowen/plugins/
~/.config/elowen/plugins-data/
```

The logger writes daily daemon and web files and also writes to the console, which systemd captures in the journal. Set `ELOWEN_LOG_LEVEL=debug` for more detail, then restore `info` after diagnosis.

The database is not the whole installation. Back up the complete configuration directory when possible. At minimum, keep the SQLite database and its matching `plugin-secrets.key` together. There is no built-in backup/restore command; an external SQLite backup can use:

```bash
sqlite3 ~/.config/elowen/elowen.db ".backup /backup/elowen-$(date +%Y%m%d).db"
```

## Updates and migrations

Use the lifecycle command for an installed instance:

```bash
elowen update
```

A plain global npm update changes package files but does not restart already-running services. Auto-update is opt-in; when enabled, it runs through the provisioned service account.

Database migrations run automatically when the daemon boots. If an update fails:

1. Save the daemon and web logs.
2. Check that the service user can read the installation, database, and `plugin-secrets.key`.
3. Check disk space and file ownership.
4. Restart only after the failed state is understood.

If `elowen doctor` reports plugin secrets as unavailable, restore the database and matching key from the same backup or reconnect the affected plugins.

## Reset and recovery

- **Conversation:** use `/new`, or start another conversation from the web or CLI. Existing history is preserved.
- **Memory:** remove individual memories or categories from the Memory page. Do not delete the whole state directory to remove one fact.
- **Setup:** `elowen setup` can be run again to fill missing configuration.
- **Full reset:** stop Elowen and make a verified backup before removing the complete `~/.config/elowen` directory (or the directory containing `ELOWEN_DB`). This destroys conversations, memory, plugin data, credentials, plans, attachments, and settings. Run `elowen setup` again only after confirming the backup is usable.

[Next: Glossary](glossary)
