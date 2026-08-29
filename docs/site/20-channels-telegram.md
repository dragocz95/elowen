---
title: Telegram
slug: channels-telegram
order: 20
eyebrow: Channels
group: Channels
---

# Telegram

The Telegram plugin uses grammY long-polling. The daemon opens an outbound connection to Telegram, so no public webhook or `/hooks/` route is required.

For shared identity and conversation rules, see [Channels](channels).

## Connect the bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram, run `/newbot`, and copy the bot token.
2. If the bot must see every group message, open **BotFather → Bot Settings → Group Privacy** and disable group privacy. With privacy enabled, Telegram limits what the bot receives in groups.
3. In Elowen, open **Settings → Plugins → Telegram** and paste the token into **Bot token**.
4. Configure at least one role policy, then enable or reload the plugin.

## Role policies

Configure policies in **Settings → Plugins → Telegram → Role policies**. The first matching policy wins; an unmatched sender is ignored.

A policy ID can be:

- a numeric Telegram user ID, such as `123456789`;
- an `@username` (case-insensitive);
- a numeric chat ID, including a negative group ID, which admits everyone in that chat; or
- `*` as a final catch-all policy.

Set `admin` on a policy to allow shared-chat controls and Telegram chat administration tools. The sender's linked Elowen account supplies project access, tool permissions, and personal memory.

## Replies and scope

- `respondWithoutMention` is `true` by default. In groups, the bot answers every message from an admitted sender. Set it to `false` to require an @mention or a reply to the bot. Direct chats always receive an answer from an admitted sender.
- `allowedChatIds` optionally restricts responses to a comma-separated list of Telegram chat IDs. Empty means no chat-ID restriction.
- `notifyChatId` optionally selects a numeric chat ID or `@channelusername` for proactive cron, tick, and escalation messages. Empty disables proactive pushes.

## Commands

Telegram renders controls as inline keyboards and paginated menus. The command list comes from the running daemon.

| Command | Purpose |
|---------|---------|
| `/model` | Open a paginated model picker. |
| `/reasoning` | Open the reasoning-effort picker. |
| `/context` | Move one of the invoking sender's own conversations into this chat. |
| `/display` | Configure tool activity, answer delivery, tool output, and tool message layout. |
| `/voice` | Toggle spoken replies; accepts `on`, `off`, or a bare toggle. |
| `/new` | Start a fresh chat conversation. |
| `/stop` | Stop the running turn. |
| `/stats` | Show model, context usage, and usage. |
| `/compact` | Summarize the conversation to free context. |
| `/fast` | Set the linked account Fast preference; its optional value is `on`, `off`, or `status`. |
| `/restart` | Restart the daemon; admin only. |
| `/help` | Show the commands available to the current sender. |

Model, reasoning, display, voice, and context controls are shared chat state. They require an admin policy.

## Presentation

Set defaults in **Settings → Plugins → Telegram** or override them in a chat with `/display`:

- **Tool activity:** `off`, `status`, or `live`.
- **Answer delivery:** `final` or `live`.
- **Tool output:** `hidden`, `summary`, or `tail`.
- **Tool message layout:** `single` or `per_tool`.

`deleteToolActivityAfterTurn` can replace one live progress message with the final answer. `runtimeFooter` appends a small model and context line. `showReasoning` is off by default.

## Images and voice

For images, set `visionModel` to a vision-capable model, or leave it empty to use the chat's normal model. `maxImageBytes` defaults to `5242880` bytes and `maxImages` defaults to `4`. Generated replies use `maxUploadImages`.

Voice uses a configured OpenAI-compatible provider from **Settings → Brain**. In the Telegram plugin settings:

- `voiceProvider` selects the provider.
- `stt` enables transcription of incoming voice messages; it is off by default.
- `sttModel` defaults to `whisper-1`.
- `tts` sets the default for spoken replies; it is off by default.
- `ttsModel` defaults to `gpt-4o-mini-tts`.
- `ttsVoice` defaults to `alloy` and accepts `alloy`, `echo`, `fable`, `onyx`, `nova`, or `shimmer`.

WhatsApp has no voice features; see [WhatsApp](channels-whatsapp).

[Next: Microsoft Teams](channels-teams)
