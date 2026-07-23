---
title: Channels
slug: channels
order: 13
eyebrow: Connect
group: Extending
---

# Channels

Channels let you talk to the same Elowen agent from Discord, Telegram, Microsoft Teams, or WhatsApp. They are platform plugins that adapt inbound messages into the same brain-turn pipeline the Web UI and CLI use — one runtime, one memory, one policy behind every surface.

A sender must be mapped to an Elowen role policy before the bot answers. Unmapped senders are silently ignored. This is deny-by-default: nobody gets agent access until you grant it.

## Pick your channel

- **[Discord](channels-discord)** — a bot in your server, role-mapped per Discord role.
- **[Telegram](channels-telegram)** — a long-polling bot you message directly or in groups.
- **[Microsoft Teams](channels-teams)** — a webhook bot for your org, identity-mapped via Entra.
- **[WhatsApp](channels-whatsapp)** — a paired account for direct and group chats.

## Shared behavior

All channels share these traits:

- **Reactions** — 👀 while thinking; ✅/❌ when done on Discord and WhatsApp, 👍/👎 on Telegram (its reaction emoji set is limited). Toggle with `reactions`.
- **Runtime footer** — a small "model · context %" line under the final reply (toggle with `runtimeFooter`)
- **Reasoning** — stream extended-thinking output into the progress bubble (toggle with `showReasoning`, off by default)
- **AskUserQuestion** — when the agent needs a decision, it posts a prompt and waits for a reply (button click on Discord, inline-keyboard tap on Telegram, Adaptive Card tap on Teams, numbered reply on WhatsApp). `askTimeoutMs` controls how long it stays open.
- **Language** — service messages (`/new`, `/model`, placeholders) in `en`, `cs` or `sk`, selectable from a dropdown in the plugin settings.

## Security model

- Sender identity is resolved before any turn runs. No mapping = no access.
- Each policy can restrict tools, models, and project scope independently.
- Provider credentials stay on the daemon; they are never exposed to the chat platform.
- The same RBAC, approval gates, and autonomy levels apply regardless of which surface the message arrives on.

[Next: Discord](channels-discord)
