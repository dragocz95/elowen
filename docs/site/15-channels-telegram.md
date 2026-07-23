---
title: Telegram
slug: channels-telegram
order: 15
eyebrow: Channels
group: Extending
---

# Telegram

Telegram runs over **long-polling** (grammY): the bot fetches updates from Telegram itself, so — unlike Teams — it needs no webhook and no `/hooks/` proxy. Nothing has to be reachable from the internet; the daemon simply opens an outbound connection.

For what every channel shares — reactions, reasoning, service language, and the security model — see [Channels](channels).

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) → `/newbot` and copy the bot token.
2. (Optional) To read every message in groups, turn off **BotFather → Bot Settings → Group Privacy** — with privacy on, the bot only sees commands and mentions.
3. In Elowen: **Settings → Plugins → Telegram** → paste the Bot token.
4. Map at least one role policy (see below).

## Role policies

Each policy maps a Telegram identity to an Elowen project scope and an optional role prompt. First match wins; senders with no mapping are silently ignored. The identity can be:

- **Telegram user ID** — `123456789` (exact match)
- **@username** — case-insensitive
- **Chat ID** — a whole group (negative ID); grants access to everyone in it

Mark a policy **Admin** to allow model switching and the Telegram chat tools. Each policy can also narrow the allowed tools.

Configure in **Settings → Plugins → Telegram → Role policies**.

## Commands

| Command | What it does |
|---------|-------------|
| `/model` | Switch the model for this chat |
| `/context` | Continue one of your existing conversations here |
| `/reasoning` | Toggle extended-thinking output |
| `/fast` | Toggle fast mode (priority processing) |
| `/voice` | Toggle spoken-audio replies (TTS) |
| `/display` | Override tool activity and answer mode |
| `/new` | Start a fresh conversation |
| `/status` | Model + context usage of the live session |
| `/stop` | Stop the current turn |
| `/help` | Show available commands |

**AskUserQuestion** renders as native inline-keyboard buttons: a single-select question is answered with one tap, a multi-select question has a Submit button, plus a free-text "Other" field.

## Groups

- `respondWithoutMention` (default on) — in groups, answer every message from a mapped sender. Off = only answer when @mentioned or replied to. Direct chats always get an answer.
- `allowedChatIds` — comma-separated chat IDs to restrict where the bot responds. Empty = respond in every chat where a mapped sender writes.

## Voice

With an OpenAI-compatible provider configured (Settings → Brain), the bot transcribes incoming voice messages (STT, default `whisper-1`) and can attach a spoken-audio version of replies (TTS, default `gpt-4o-mini-tts`) — toggle per chat with `/voice`.

## Vision

Attach images to a message and the bot sends them to a vision-capable model. Configure `visionModel`, `maxImageBytes`, and `maxImages` in the plugin settings.

## Proactive pushes

Set `notifyChatId` to a numeric chat ID or an `@channelusername` and the bot posts cron/tick results and escalations there. Empty = no proactive pushes.

[Next: Microsoft Teams](channels-teams)
