---
title: WhatsApp
slug: channels-whatsapp
order: 17
eyebrow: Channels
group: Extending
---

# WhatsApp

A paired WhatsApp account answers in direct and group chats, with each sender mapped to an Elowen project scope and policy.

For what every channel shares — reactions, reasoning, service language, and the security model — see [Channels](channels).

## Setup

1. In Elowen: **Settings → Plugins → WhatsApp** → enable the plugin.
2. Pair the bot to a WhatsApp account:
   - **QR code** — the plugin prints a QR to its logs; scan it from WhatsApp → Linked devices.
   - **Pairing code** — set `phoneNumber` (international format without +, e.g. `420777123456`) and the plugin prints an 8-character code instead. Enter it in WhatsApp → Linked devices → Link with phone number.
3. Map at least one sender policy (see below).

## Sender policies

Each sender (phone number, JID, or whole group JID) maps to an Elowen project scope and role prompt. First match wins; unmatched senders are ignored.

- **Sender ID** — phone number (`420777123456`), JID (`…@s.whatsapp.net`), or group JID (`…@g.us`)
- **Elowen projects** — which projects this sender can act in
- **Role prompt** — scoped instructions
- **Admin** — grants model switching and group tools
- **Allowed tools** — optional allow-list

A group JID grants access to everyone in that group.

## Text commands

| Command | What it does |
|---------|-------------|
| `/model` | Show a numbered model menu; reply with a number to switch |
| `/new` | Start a fresh conversation |
| `/help` | Show available commands |

## Groups

- `respondWithoutMention` (default on) — in groups, answer every message from a mapped sender. Off = only answer when @mentioned or replied to. Direct chats always get an answer.
- `groupIds` — comma-separated group JIDs to restrict where the bot responds. Empty = respond in every group where a mapped sender writes.

## Streaming

With `streaming` enabled (default), the bot edits its reply in place as it streams — tool calls and text appear progressively. Off = one message at the end.

## Proactive pushes

Set `notifyChat` to a phone number or JID and the bot posts cron/tick results, escalations, and restart notices there. Empty = no proactive pushes.

[Next: Troubleshooting](troubleshooting)
