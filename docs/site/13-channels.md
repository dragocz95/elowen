---
title: Channels
slug: channels
order: 13
eyebrow: Connect
group: Extending
---

# Channels

Channels let you talk to the same Elowen agent from Discord or WhatsApp. They are platform plugins that adapt inbound messages into the same brain-turn pipeline the Web UI and CLI use — one runtime, one memory, one policy behind every surface.

A sender must be mapped to an Elowen role policy before the bot answers. Unmapped senders are silently ignored. This is deny-by-default: nobody gets agent access until you grant it.

## Discord

### Setup

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications) → Bot → **Reset Token**. Copy the token.
2. Under **Privileged Gateway Intents**, enable **Message Content Intent** (required for the bot to read messages).
3. Invite the bot to your server with the `bot` and `applications.commands` scopes.
4. In Elowen: **Settings → Plugins → Discord** → paste the bot token.
5. Map at least one Discord role to an Elowen policy (see below).

### Role policies

Each Discord role maps to an Elowen project scope and an optional role prompt. First matching role wins; users with no mapped role are ignored. A policy can also restrict which tools the bot may use for that role.

Configure in **Settings → Plugins → Discord → Role policies**:

- **Discord role ID** — the role to match
- **Elowen projects** — which projects this role can act in
- **Role prompt** — system-level instructions scoped to this role
- **Admin** — grants access to server tools (channel management, member search, etc.)
- **Allowed tools** — optional allow-list narrowing the bot's toolset for this role

### Slash commands

| Command | What it does |
|---------|-------------|
| `/model` | Switch the model for this channel |
| `/reasoning` | Toggle extended-thinking output |
| `/display` | Override tool activity and answer mode per channel |
| `/new` | Start a fresh conversation |
| `/voice` | Toggle spoken-audio replies (TTS) |
| `/help` | Show available commands |

### Per-channel display

Each channel can override how the bot presents its work:

- **Tool activity** — Off (hide trace), Live status (tool start/completion), Live output (also streams bounded Bash progress)
- **Answer mode** — Final (one complete answer below the trace) or Live (edits the answer as it's written)
- **Tool message mode** — one compact live message, or one bubble per tool call

Override with `/display` or set defaults in the plugin config.

### Voice

With an OpenAI-compatible provider configured (Settings → Brain), the bot can:

- **STT** — transcribe incoming voice messages so the agent understands them
- **TTS** — attach a spoken-audio version of replies (toggle per channel with `/voice`)

Configure the voice provider, STT model (default `whisper-1`), TTS model (default `gpt-4o-mini-tts`), and voice (alloy, echo, fable, onyx, nova, shimmer) in the plugin settings.

### Vision

Attach images to a message and the bot sends them to a vision-capable model. Configure `visionModel`, `maxImageBytes`, and `maxImages` in the plugin settings.

### Proactive pushes

Set `notifyChannelId` to a channel ID and the bot posts cron/tick results, escalations, and restart notices there. Empty = no proactive pushes.

## WhatsApp

### Setup

1. In Elowen: **Settings → Plugins → WhatsApp** → enable the plugin.
2. Pair the bot to a WhatsApp account:
   - **QR code** — the plugin prints a QR to its logs; scan it from WhatsApp → Linked devices.
   - **Pairing code** — set `phoneNumber` (international format without +, e.g. `420777123456`) and the plugin prints an 8-character code instead. Enter it in WhatsApp → Linked devices → Link with phone number.
3. Map at least one sender policy (see below).

### Sender policies

Each sender (phone number, JID, or whole group JID) maps to an Elowen project scope and role prompt. First match wins; unmatched senders are ignored.

- **Sender ID** — phone number (`420777123456`), JID (`…@s.whatsapp.net`), or group JID (`…@g.us`)
- **Elowen projects** — which projects this sender can act in
- **Role prompt** — scoped instructions
- **Admin** — grants model switching and group tools
- **Allowed tools** — optional allow-list

A group JID grants access to everyone in that group.

### Text commands

| Command | What it does |
|---------|-------------|
| `/model` | Show a numbered model menu; reply with a number to switch |
| `/new` | Start a fresh conversation |
| `/help` | Show available commands |

### Groups

- `respondWithoutMention` (default on) — in groups, answer every message from a mapped sender. Off = only answer when @mentioned or replied to. Direct chats always get an answer.
- `groupIds` — comma-separated group JIDs to restrict where the bot responds. Empty = respond in every group where a mapped sender writes.

### Streaming

With `streaming` enabled (default), the bot edits its reply in place as it streams — tool calls and text appear progressively. Off = one message at the end.

### Proactive pushes

Set `notifyChat` to a phone number or JID and the bot posts cron/tick results, escalations, and restart notices there. Empty = no proactive pushes.

## Shared behavior

Both channels share these traits:

- **Reactions** — 👀 while thinking, ✅/❌ when done (toggle with `reactions`)
- **Runtime footer** — a small "model · context %" line under the final reply (toggle with `runtimeFooter`)
- **Reasoning** — stream extended-thinking output into the progress bubble (toggle with `showReasoning`, off by default)
- **AskUserQuestion** — when the agent needs a decision, it posts a prompt and waits for a reply (button click on Discord, numbered reply on WhatsApp). `askTimeoutMs` controls how long it stays open.
- **Language** — service messages (`/new`, `/model`, placeholders) in `en` or `cs`, selectable from a dropdown in the plugin settings.

## Security model

- Sender identity is resolved before any turn runs. No mapping = no access.
- Each policy can restrict tools, models, and project scope independently.
- Provider credentials stay on the daemon; they are never exposed to the chat platform.
- The same RBAC, approval gates, and autonomy levels apply regardless of which surface the message arrives on.

[Next: Troubleshooting](troubleshooting)
