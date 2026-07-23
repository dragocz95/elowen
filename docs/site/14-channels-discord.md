---
title: Discord
slug: channels-discord
order: 14
eyebrow: Channels
group: Extending
---

# Discord

A Discord bot answers in your server, with each Discord role mapped to an Elowen project scope and policy.

For what every channel shares — reactions, reasoning, service language, and the security model — see [Channels](channels).

## Setup

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications) → Bot → **Reset Token**. Copy the token.
2. Under **Privileged Gateway Intents**, enable **Message Content Intent** (required for the bot to read messages).
3. Invite the bot to your server with the `bot` and `applications.commands` scopes.
4. In Elowen: **Settings → Plugins → Discord** → paste the bot token.
5. Map at least one Discord role to an Elowen policy (see below).

## Role policies

Each Discord role maps to an Elowen project scope and an optional role prompt. First matching role wins; users with no mapped role are ignored. A policy can also restrict which tools the bot may use for that role.

Configure in **Settings → Plugins → Discord → Role policies**:

- **Discord role ID** — the role to match
- **Elowen projects** — which projects this role can act in
- **Role prompt** — system-level instructions scoped to this role
- **Admin** — grants access to server tools (channel management, member search, etc.)
- **Allowed tools** — optional allow-list narrowing the bot's toolset for this role

## Slash commands

| Command | What it does |
|---------|-------------|
| `/model` | Switch the model for this channel |
| `/reasoning` | Toggle extended-thinking output |
| `/display` | Override tool activity and answer mode per channel |
| `/new` | Start a fresh conversation |
| `/voice` | Toggle spoken-audio replies (TTS) |
| `/help` | Show available commands |

## Per-channel display

Each channel can override how the bot presents its work:

- **Tool activity** — Off (hide trace), Live status (tool start/completion), Live output (also streams bounded Bash progress)
- **Answer mode** — Final (one complete answer below the trace) or Live (edits the answer as it's written)
- **Tool message mode** — one compact live message, or one bubble per tool call

Override with `/display` or set defaults in the plugin config.

## Voice

With an OpenAI-compatible provider configured (Settings → Brain), the bot can:

- **STT** — transcribe incoming voice messages so the agent understands them
- **TTS** — attach a spoken-audio version of replies (toggle per channel with `/voice`)

Configure the voice provider, STT model (default `whisper-1`), TTS model (default `gpt-4o-mini-tts`), and voice (alloy, echo, fable, onyx, nova, shimmer) in the plugin settings.

## Vision

Attach images to a message and the bot sends them to a vision-capable model. Configure `visionModel`, `maxImageBytes`, and `maxImages` in the plugin settings.

## Proactive pushes

Set `notifyChannelId` to a channel ID and the bot posts cron/tick results, escalations, and restart notices there. Empty = no proactive pushes.

[Next: Telegram](channels-telegram)
