---
title: Troubleshooting
slug: troubleshooting
order: 18
eyebrow: Reference
group: Reference
---

# Troubleshooting

When something isn't working, start here. Most issues fall into a handful of categories and have quick fixes.

## elowen doctor

The fastest diagnostic. Run it any time:

```bash
elowen doctor
```

It checks daemon health, chat provider, tasks, missions, memory, platforms, and plugins — printing `[ok]` or `[fail]` with a hint for each. In a TTY it prompts for admin credentials; set `ELOWEN_TOKEN` for non-interactive use.

The same readiness data powers the setup wizard's finish screen and `GET /system/readiness`.

## Daemon won't start

**Symptom:** `elowen status` shows the daemon down, or `elowen up` exits immediately.

1. Check the port isn't taken: `ss -tlnp | grep 4400`
2. Check the log: `journalctl -u elowen-daemon -n 50 --no-pager` (systemd) or the tmux pane if running manually.
3. Common causes:
   - **Port conflict** — another process on `:4400`. Kill it or change `ELOWEN_PORT`.
   - **Corrupt database** — the SQLite file in the data directory is locked or damaged. Stop the daemon, back up `elowen.db`, and restart. If it still fails, restore from backup.
   - **Node version** — Elowen needs Node ≥22. Check with `node -v`.
   - **Missing tmux** — agents need tmux ≥3.x. Install it: `apt install tmux`.

## Chat doesn't respond

**Symptom:** you send a message (web, CLI, or channel) and get nothing back, or an error about the provider.

1. Run `elowen doctor` — the **Chat** check tells you if a provider is configured.
2. **Settings → Brain → Providers** — confirm at least one provider has a valid API key and a default model is selected.
3. Check the model isn't rate-limited or the key expired. The daemon log shows the raw provider error.
4. If the web chat shows a spinner forever, check the browser console and the daemon log for a timeout or connection reset.

## Tasks won't run

**Symptom:** a task stays `open` or `in_progress` with no agent activity.

1. `elowen doctor` — the **Tasks** check confirms an executor is configured.
2. Check tmux sessions: `tmux ls`. If the agent's session exists but is stuck, attach to it: `tmux attach -t <session>`.
3. The **Sessions** page in the web UI shows live terminal output — open it and look for errors.
4. Common causes:
   - **No executor** — configure one in Settings → Brain (the built-in engine uses the brain provider).
   - **tmux missing** — install tmux ≥3.x.
   - **Project not registered** — the task's project must be registered in Settings → Projects.
   - **Permission denied** — the user's tool allow-list may block the tools the agent needs.

## Memory isn't working

**Symptom:** the agent doesn't remember things across conversations, or memory search returns nothing.

1. `elowen doctor` — the **Memory** check shows whether it's enabled and if an embedding model is configured.
2. Memory is opt-in. Enable it in **Settings → Memory**.
3. Semantic search needs an embedding model configured in the same section. Without one, search falls back to keyword matching (and says so).
4. If memories exist but don't resurface, check that the conversation's project and user match where the memories were stored.

## Platform bot is silent

**Symptom:** you message the Discord, Telegram, Microsoft Teams, or WhatsApp bot and get no reply.

1. `elowen doctor` — the **Platforms** check lists active messaging platforms.
2. **Sender not mapped** — the most common cause. The bot ignores unmapped senders by design. Add a role policy (Discord, Telegram) or sender policy (WhatsApp) for your account. See [Channels](channels).
3. **Discord specifics:**
   - Message Content Intent not enabled in the Developer Portal.
   - `guildId` set to a different server.
   - `threadIds` set and you're posting outside those threads.
   - `respondWithoutMention` is off and you didn't @mention the bot.
4. **Telegram specifics:**
   - Invalid or wrong bot token from @BotFather.
   - Group Privacy enabled in **BotFather → Bot Settings → Group Privacy** — the bot can't see group messages.
   - The chat isn't in `allowedChatIds`.
   - No role policy mapped for the sender — unmapped senders are ignored by design.
5. **Microsoft Teams specifics:**
   - The webhook endpoint `https://<domain>/hooks/msteams/messages` isn't reachable from the internet.
   - `/hooks/` isn't proxied in a hand-written vhost — see [Deployment guide](../DEPLOYMENT.md).
   - Missing or invalid TLS certificate.
   - The bot isn't installed from the app package — Teams only talks to installed bots.
   - Typo in the credentials — the plugin validates them immediately, so the error shows in the plugin log.
6. **WhatsApp specifics:**
   - Pairing expired — re-pair via QR or pairing code in the plugin logs.
   - `groupIds` restricts the bot to specific groups.
   - `respondWithoutMention` is off in a group and you didn't mention or reply to the bot.

## Web UI won't load

**Symptom:** `http://localhost:4500` shows a connection error or blank page.

1. `elowen status` — confirm both `elowen-daemon` and `elowen-web` are running.
2. Check the web service log: `journalctl -u elowen-web -n 30 --no-pager`.
3. If behind a reverse proxy, verify the proxy is forwarding to `:4500` and the daemon to `:4400`.
4. Clear the browser cache — stale assets after an update can cause a blank page.

## Context lost mid-conversation

**Symptom:** the agent suddenly "forgets" what you were discussing.

1. Long conversations hit the context window limit. Elowen compacts older context into a summary — this is normal, but very long sessions can lose nuance.
2. Check the runtime footer (if enabled) for the context usage percentage. Above ~85%, compaction kicks in.
3. Start a fresh conversation (`/new` on channels, new chat in web/CLI) when the thread is too long to be useful.
4. Persistent facts survive compaction if they're in **memory** — store important decisions there.

## Agent is stuck in a loop

**Symptom:** the agent repeats the same tool call or retries endlessly.

1. Open the **Sessions** page and attach to the terminal — you can interrupt with Ctrl+C.
2. Check if a permission denial is causing the retry (the agent retries a blocked command). Adjust the tool permissions or approve the action.
3. The **stuck detector** (see [Agents & Autonomy](agents-autonomy)) should catch this automatically and escalate. If it doesn't fire, check that liveness checks are enabled.
4. Cancel the task/mission and rephrase the goal more concretely.

## Logs

Where to look:

| Surface | Location |
|---------|----------|
| Daemon (systemd) | `journalctl -u elowen-daemon -f` |
| Web UI (systemd) | `journalctl -u elowen-web -f` |
| Agent sessions | `tmux attach -t <session>` or the Sessions page |
| Plugin logs | daemon log, prefixed with the plugin name |
| Manual start | the terminal where you ran `elowen up` |

Set `ELOWEN_LOG_LEVEL=debug` for verbose output when diagnosing.

## Reset and recovery

- **Reset a conversation** — `/new` on channels, or start a new chat in web/CLI. The old conversation is preserved in history.
- **Clear memory** — Settings → Memory → delete individual facts or categories. There's no "wipe all" button by design; memory is deliberate.
- **Re-run setup** — `elowen setup` is safe to re-run; it detects existing config and only fills gaps.
- **Full reset** — stop the daemon, delete the data directory (default `~/.elowen/`), and run `elowen setup` fresh. This destroys all data.

## FAQ

**Does Elowen work offline?**
The daemon and web UI run fully locally. You need internet only for the AI provider API calls.

**Can I run multiple instances?**
Each instance needs its own port pair and data directory. Set `ELOWEN_PORT` and `ELOWEN_DATA_DIR` to avoid conflicts.

**How do I update Elowen?**
`npm update -g elowen` for the npm install, or the auto-update timer if you used `elowen install`. Restart the services after updating. See [Install](install) for details.

**Where is my data?**
Everything lives in a single SQLite database file in the data directory (default `~/.elowen/elowen.db`). Conversations, memory, tasks, settings — all in one file. Nothing leaves your machine except provider API calls.

**The bot answered in the wrong language.**
Set the `language` field in the channel plugin config (`en`, `cs` or `sk`) for service messages. For the agent's reply language, add an instruction to the role/sender policy's prompt.

[Back to start](getting-started)
