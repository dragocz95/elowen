---
title: Troubleshooting
slug: troubleshooting
order: 28
eyebrow: Help
group: Help
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

## Stopping takes longer than expected

**Symptom:** `elowen down` takes minutes, or the daemon log shows `Stopping — waiting for N turn(s), M sub-agent(s)…`.

The daemon shuts down gracefully by design: on SIGTERM or SIGINT it first finishes what is in flight — running turns and sub-agents — and only then exits. That drain is deliberate: a deploy's `systemctl restart` or a reboot would otherwise cut a model turn or sub-agent off mid-work and discard its result. The daemon checks every half second and waits up to 10 minutes before giving up; the systemd unit's stop timeout is slightly longer, so systemd waits with it instead of killing it. `elowen down` uses this same path and only reports success once the services have actually exited (up to roughly 11 minutes).

A delegated result that hasn't reached its parent yet gets a shorter window of its own, ten seconds. Handing it over needs another turn from that parent, which the shutdown is already refusing to start, so waiting longer cannot help — and the results are stored, so the daemon delivers them after it comes back up.

If you can't wait:

1. Interrupt the stop again — a second SIGTERM/SIGINT makes the daemon exit immediately, dropping the remaining work.
2. Run `elowen down --force` — it sends SIGKILL directly and never reaches the drain; anything in flight is lost.
3. If the drain never completes on its own, a turn or sub-agent is probably wedged — check the daemon log for what it still reports as running, force the stop, and investigate there.

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
   - `/hooks/` isn't proxied in a hand-written vhost — see [Production & Updates](production-updates).
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
3. The **stuck detector** (see [Autonomy & Safety](autonomy-safety)) should catch this automatically and escalate. If it doesn't fire, check that liveness checks are enabled.
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

**A model I configured doesn't appear in the picker.**
Confirm the provider's API key is valid and the model is enabled in **Settings → Brain → Providers**. If you're not an admin, your account may be restricted to a model allow-list — ask an admin to check your access in **Settings → Users**. OpenRouter `:free` variants are filtered out by design and never appear.

**My plugin config change didn't stick.**
Saving a plugin config reloads the plugin, but a failed schema validation silently keeps the old values — check the field for an inline error. Secrets are write-only: re-entering a secret replaces it, but you can never read the stored value back, so an empty field does not mean the secret is gone. Existing live conversations keep the configuration they started with; changes apply from the next turn.

**The bot ignores me in a group chat.**
Group behavior is intentionally strict: on Discord and WhatsApp the bot only responds when mentioned (or replied to) unless `respondWithoutMention` is enabled, and on Telegram Group Privacy must be disabled in BotFather for the bot to see group messages at all. Check the platform specifics in the "Platform bot is silent" section above.

**Memory exists but the agent doesn't recall it.**
Memory is retrieved per user — facts stored under a different account never surface in your conversations. Without a configured embedding model, retrieval is keyword-only, so loosely worded prompts may miss relevant facts. Also check that the memory wasn't stored in a category scoped to a different project.

**My cron job isn't firing.**
Three common causes: the job was created with `enabled: false`; it has an `hours` window (e.g. `"5-21"`) and the current time falls outside it — the job stays quiet by design; or its `check` guard command printed nothing, which skips the tick entirely without running the model. List jobs with their last run and last result to see which one applies. Scheduling is also admin-only — a non-admin conversation can't create jobs.

**The update fails with a permissions error.**
A global npm update (`npm update -g elowen`) fails with `EACCES` when npm's global prefix is owned by root — either fix the npm prefix ownership or run the update with the same privileges used for the original install. On a server provisioned with `elowen install`, the auto-update timer runs as the dedicated `elowen` system user; don't mix in manual root updates, which can leave files the service user can't overwrite. See [Production & Updates](production-updates).

**Web push notifications aren't arriving.**
Push is per device and opt-in: enable it in **Account → Notifications** on each browser/device you want notified. Push requires the web UI to be served over HTTPS (or localhost) — a plain-HTTP origin can't register the service worker. Also check the browser's own notification permission for the site; a blocked permission in the browser overrides Elowen's setting.

**A keybind doesn't do what I expect.**
A chord can only belong to one action — if two actions share a chord, the earlier one in the `/keybinds` list wins and the editor shows a warning. Open `/keybinds`, press `r` on the affected action to reset its default, or `x` to unbind the conflicting one. To reset everything at once, delete the `keybinds` key in `cli-prefs.json`. See [CLI Keybinds](cli-keybinds).

[Next: Glossary](glossary)
