---
title: Microsoft Teams
slug: channels-teams
order: 16
eyebrow: Channels
group: Extending
---

# Microsoft Teams

Unlike Discord and WhatsApp, Teams delivers messages by **webhook**: Microsoft POSTs each activity to your Elowen instance over HTTPS. That means the daemon's `/hooks/` path must be reachable from the internet on your domain with a valid certificate. Installs provisioned by `elowen install` already route `/hooks/` to the daemon in the generated nginx/Apache vhost; for a hand-written proxy config, add the location from the [Deployment guide](../DEPLOYMENT.md).

For what every channel shares — reactions, reasoning, service language, and the security model — see [Channels](channels).

## 1. Register the app in Microsoft Entra

1. Open the [Entra admin center](https://entra.microsoft.com) → **App registrations** → **New registration**.
2. Name it (e.g. "Elowen"), pick **Accounts in this organizational directory only** (single tenant), and register.
3. From the Overview page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
4. Under **Certificates & secrets** → **New client secret**, create a secret and copy its **value** (shown only once).

## 2. Create the Azure Bot

1. In the [Azure portal](https://portal.azure.com), create an **Azure Bot** resource.
2. Under **Type of app**, choose **Single Tenant** and enter the Application (client) ID from step 1 — the bot identity must be the same app registration.
3. In the bot's **Configuration**, set the **Messaging endpoint** to:
   ```
   https://<your-domain>/hooks/msteams/messages
   ```
4. Under **Channels**, add the **Microsoft Teams** channel.

## 3. Configure the plugin

In Elowen: **Settings → Plugins → Microsoft Teams** →

1. Paste the **Microsoft App ID**, **Client secret**, and **Tenant ID**.
2. Map at least one role policy (see below).
3. Enable the plugin. It validates the credentials immediately — a typo'd secret shows up in the plugin logs right away.

## 4. Install the bot in Teams

Teams only talks to bots installed from an app package. The plugin builds one for you:

1. On the plugin's Connection card, click **Download app package** (a ZIP with the Teams manifest and icons, including the slash-command list for the compose box).
2. Upload it in the [Teams admin center](https://admin.teams.microsoft.com) → **Teams apps → Manage apps → Upload new app** (org-wide), or sideload it into a single team via **Apps → Manage your apps → Upload an app** if sideloading is allowed.
3. Add the bot to a personal chat, group chat, or team channel and say hello.

## Role policies

Each policy maps a sender to an Elowen project scope and an optional role prompt. First match wins; unmapped senders are silently ignored. The ID can be:

- **Entra object ID** — the user's directory GUID (exact match)
- **UPN / email** — `alex@contoso.com` (case-insensitive)
- **Conversation ID** — a whole chat or channel; grants access to everyone in it

Mark a policy **Admin** to allow model switching and the Teams chat tools. Each policy can also narrow the allowed tools.

## Commands and cards

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

## Mentions

Team-channel posts always require an **@mention** — Teams only delivers mentioned messages to bots. In group chats, `respondWithoutMention` (default on) makes the bot answer every message from a mapped sender; personal chats always get an answer.

## Proactive pushes

Set **Notification conversation** to a conversation ID the bot has already seen and cron/tick results are posted there. A user's Entra object ID also works — the bot opens the personal chat itself.

[Next: WhatsApp](channels-whatsapp)
