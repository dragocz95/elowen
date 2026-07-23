---
title: Channels
slug: channels
order: 13
eyebrow: Connect
group: Extending
---

# Channels

Channels let you talk to the same Elowen agent from Discord, Microsoft Teams, or WhatsApp. They are platform plugins that adapt inbound messages into the same brain-turn pipeline the Web UI and CLI use — one runtime, one memory, one policy behind every surface.

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

## Microsoft Teams

Unlike Discord and WhatsApp, Teams delivers messages by **webhook**: Microsoft POSTs each activity to your Elowen instance over HTTPS. That means the daemon's `/hooks/` path must be reachable from the internet on your domain with a valid certificate. Installs provisioned by `elowen setup` already route `/hooks/` to the daemon in the generated nginx/Apache vhost; for a hand-written proxy config, add the location from the [Deployment guide](../DEPLOYMENT.md).

### 1. Register the app in Microsoft Entra

1. Open the [Entra admin center](https://entra.microsoft.com) → **App registrations** → **New registration**.
2. Name it (e.g. "Elowen"), pick **Accounts in this organizational directory only** (single tenant), and register.
3. From the Overview page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
4. Under **Certificates & secrets** → **New client secret**, create a secret and copy its **value** (shown only once).

### 2. Create the Azure Bot

1. In the [Azure portal](https://portal.azure.com), create an **Azure Bot** resource.
2. Under **Type of app**, choose **Single Tenant** and enter the Application (client) ID from step 1 — the bot identity must be the same app registration.
3. In the bot's **Configuration**, set the **Messaging endpoint** to:
   ```
   https://<your-domain>/hooks/msteams/messages
   ```
4. Under **Channels**, add the **Microsoft Teams** channel.

### 3. Configure the plugin

In Elowen: **Settings → Plugins → Microsoft Teams** →

1. Paste the **Microsoft App ID**, **Client secret**, and **Tenant ID**.
2. Map at least one role policy (see below).
3. Enable the plugin. It validates the credentials immediately — a typo'd secret shows up in the plugin logs right away.

### 4. Install the bot in Teams

Teams only talks to bots installed from an app package. The plugin builds one for you:

1. On the plugin's Connection card, click **Download app package** (a ZIP with the Teams manifest and icons, including the slash-command list for the compose box).
2. Upload it in the [Teams admin center](https://admin.teams.microsoft.com) → **Teams apps → Manage apps → Upload new app** (org-wide), or sideload it into a single team via **Apps → Manage your apps → Upload an app** if sideloading is allowed.
3. Add the bot to a personal chat, group chat, or team channel and say hello.

### Role policies

Each policy maps a sender to an Elowen project scope and an optional role prompt. First match wins; unmapped senders are silently ignored. The ID can be:

- **Entra object ID** — the user's directory GUID (exact match)
- **UPN / email** — `alex@contoso.com` (case-insensitive)
- **Conversation ID** — a whole chat or channel; grants access to everyone in it

Mark a policy **Admin** to allow model switching and the Teams chat tools. Each policy can also narrow the allowed tools.

### Commands and cards

| Command | What it does |
|---------|-------------|
| `/model` | Pick the model for this chat (Adaptive Card picker) |
| `/reasoning` | Pick the reasoning effort |
| `/display` | Configure live tool activity and answer delivery |
| `/context` | Continue one of your existing conversations in this chat |
| `/new` | Start a fresh conversation |
| `/status` | Model + context usage of the live session |
| `/help` | Show available commands |

**AskUserQuestion** renders as an Adaptive Card with tappable options (single-select answers on tap, multi-select with a Submit button, plus a free-text "Other" field). Only the person the question was addressed to — or an admin — can answer.

### Mentions

Team-channel posts always require an **@mention** — Teams only delivers mentioned messages to bots. In group chats, `respondWithoutMention` (default on) makes the bot answer every message from a mapped sender; personal chats always get an answer.

### Proactive pushes

Set **Notification conversation** to a conversation ID the bot has already seen and cron/tick results are posted there. A user's Entra object ID also works — the bot opens the personal chat itself.

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

All channels share these traits:

- **Reactions** — 👀 while thinking, ✅/❌ when done (Discord and WhatsApp; toggle with `reactions`)
- **Runtime footer** — a small "model · context %" line under the final reply (toggle with `runtimeFooter`)
- **Reasoning** — stream extended-thinking output into the progress bubble (toggle with `showReasoning`, off by default)
- **AskUserQuestion** — when the agent needs a decision, it posts a prompt and waits for a reply (button click on Discord, Adaptive Card tap on Teams, numbered reply on WhatsApp). `askTimeoutMs` controls how long it stays open.
- **Language** — service messages (`/new`, `/model`, placeholders) in `en`, `cs` or `sk`, selectable from a dropdown in the plugin settings.

## Security model

- Sender identity is resolved before any turn runs. No mapping = no access.
- Each policy can restrict tools, models, and project scope independently.
- Provider credentials stay on the daemon; they are never exposed to the chat platform.
- The same RBAC, approval gates, and autonomy levels apply regardless of which surface the message arrives on.

[Next: Troubleshooting](troubleshooting)
