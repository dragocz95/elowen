---
title: WhatsApp
slug: channels-whatsapp
order: 22
eyebrow: Channels
group: Channels
---

# WhatsApp

The WhatsApp plugin uses Baileys WhatsApp Web multi-device. Pair a WhatsApp account, then map senders or groups to Elowen access.

For shared identity and conversation rules, see [Channels](channels).

## Pair an account

1. In Elowen, open **Settings → Plugins → WhatsApp** and enable the plugin.
2. Open **Pairing** and choose **Pair device**.
3. Pair using one of these methods:
   - **QR code:** open WhatsApp → **Linked devices → Link a device** and scan the displayed code.
   - **Phone pairing code:** set `phoneNumber` to the bot's international number without `+`, spaces, or dashes (for example, `420777123456`). Enter the displayed 8-character code in WhatsApp → **Linked devices → Link with phone number**.
4. Configure at least one sender policy.

Pairing state is kept by the plugin. To disconnect the account, use the pairing UI's **Unpair device** action.

## Sender policies

Configure policies in **Settings → Plugins → WhatsApp → Sender policies**. The first matching policy wins; an unmatched sender is ignored.

A policy ID can be:

- a phone number, such as `420777123456`;
- a personal JID ending in `@s.whatsapp.net`;
- a group JID ending in `@g.us`, which admits everyone in that group; or
- `*` as a final catch-all policy.

Set `admin` to allow shared-chat controls and WhatsApp group tools. Project access, tool permissions, and personal memory come from the sender's linked Elowen account.

## Groups and scope

- Direct chats always respond for an admitted sender.
- `respondWithoutMention` is `true` by default. In groups, the bot answers every message from an admitted sender. Set it to `false` to require an @mention or a reply to the bot.
- `groupIds` optionally restricts responses to a comma-separated list of group JIDs. Empty means every group where an admitted sender writes.
- `notifyChat` optionally selects a phone number or JID for proactive cron, tick, escalation, and restart messages. Empty disables proactive pushes.

## Commands

WhatsApp does not rely on native buttons or lists. Model, reasoning, and context pickers are numbered text menus; reply with the requested number.

| Command | Purpose |
|---------|---------|
| `/model` | Show a numbered model picker. |
| `/reasoning` | Show a numbered reasoning-effort picker. |
| `/context` | Show a numbered picker of the invoking sender's own conversations. |
| `/new` | Start a fresh conversation. |
| `/stop` | Stop the running turn. |
| `/stats` | Show model, context usage, and usage. |
| `/compact` | Summarize the conversation to free context. |
| `/fast` | Set the linked account Fast preference; its optional value is `on`, `off`, or `status`. |
| `/restart` | Restart the daemon; admin only. |
| `/help` | Show the commands available to the current sender. |

The controls that change shared chat state require an admin policy. WhatsApp has no `/display` or `/voice` command.

## Streaming and media

`streaming` defaults to `true`. With it enabled, the plugin edits one progress message while the agent works; the final answer is sent as one message. Set it to `false` to send only the final answer. `deleteToolActivityAfterTurn` can replace the progress message with the final answer.

WhatsApp has no speech-to-text, text-to-speech, or `/voice` support. A voice message arrives as an untranscribed audio attachment.

For images, set `visionModel` to a vision-capable model, or leave it empty to use the chat's normal model. `maxImageBytes` defaults to `5242880` bytes, `maxImages` defaults to `4`, and `maxUploadImages` defaults to `4`.

[Next: Plugins](plugins)
