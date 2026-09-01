---
title: Telegram
slug: channels-telegram
order: 20
eyebrow: Channels
group: Channels
---

# Telegram

The Telegram plugin uses grammY long-polling. Elowen opens an outbound connection to Telegram, so no public webhook or `/hooks/` route is required.

For shared identity and conversation rules, see [Channels](channels).

## Install and connect the bot

1. In Telegram, open [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the bot token.
2. If the bot must receive every group message, open **BotFather → Bot Settings → Group Privacy** and disable group privacy. Otherwise Telegram limits group updates to messages addressed to the bot.
3. In Elowen, open **Settings → Plugins → Available**, install **Telegram**, then open its settings and enter the token in **Bot token**.
4. Configure at least one role policy and enable the plugin. The bot connects and publishes its command menu when the plugin loads.

## Identity and role policies

A Telegram sender must both match a role policy and be linked to an Elowen account. Set the numeric **Telegram ID** in **Account → Profile → Linked accounts**; you can obtain it by sending `/start` to `@userinfobot`. The linked account supplies project access, tool permissions, account settings, and personal memory. One platform identity can belong to only one Elowen account.

Configure policies in **Settings → Plugins → Telegram → Role policies**. The first matching policy wins; an unmatched sender is ignored. A policy ID can be:

- a numeric Telegram user ID, such as `123456789`;
- an `@username` (case-insensitive);
- a numeric chat ID, including a negative group or channel ID, which admits everyone in that chat; or
- `*` as a catch-all policy, placed after named entries.

Set `admin` on the effective policy to allow shared-chat controls such as model, reasoning, context, display, and voice controls. Telegram chat tools are governed by the linked account's tool permissions; they are not granted merely by matching a policy.

## Replies, destinations, and scope

- `respondWithoutMention` defaults to `true`. In groups and supergroups, the bot answers every message from an admitted sender. Set it to `false` to require an @mention or a reply to the bot. Direct chats always receive an answer from an admitted sender.
- `allowedChatIds` is a token list of numeric user or chat IDs. Empty means no additional chat allowlist. Older comma- or newline-separated values remain accepted.
- `notifyChatId` is an optional open destination: a numeric user/group/channel ID or public `@channelusername`. It receives proactive cron, tick, and escalation messages; empty disables the fallback destination. A host-supplied destination can override it for a specific delivery.

## Commands

Telegram renders controls as inline keyboards and paginated menus. The running daemon supplies the command catalog, so plugin prompt commands may also appear. The built-in Telegram menu includes:

| Command | Purpose |
|---------|---------|
| `/model` | Open a paginated model picker. |
| `/reasoning` | Open the reasoning-effort picker. |
| `/context` | Move one of the invoking sender's own conversations into this chat. |
| `/display` | Configure tool activity, answer delivery, tool output, and message layout. |
| `/voice` | Toggle spoken replies; accepts `on`, `off`, or a bare toggle. |
| `/new` | Start a fresh chat conversation. |
| `/stop` | Stop the running turn. |
| `/stats` | Show model, context usage, and usage. |
| `/compact` | Summarize the conversation to free context. |
| `/fast` | Set the linked account's Fast preference; accepts `on`, `off`, or `status`. A linked account is required. |
| `/restart` | Restart the daemon; admin only. |
| `/help` | Show commands available to the current sender. |

`/model`, `/reasoning`, `/context`, `/display`, and `/voice` require an admin policy. `/stop`, `/stats`, `/compact`, and `/restart` are also operator-gated where the command is available. The exact menu is always the running daemon's catalog; unsupported or unavailable commands are not advertised.

## Presentation

Set defaults in **Settings → Plugins → Telegram** or override them in a chat with `/display`:

- **Tool activity:** `off`, `status`, or `live`.
- **Answer delivery:** `final` or `live`.
- **Tool output:** `hidden`, `summary`, or `tail`.
- **Tool message layout:** `single` or `per_tool`.

`deleteToolActivityAfterTurn` can replace one live progress message with the final answer. `runtimeFooter` appends a small model and context line. `showReasoning` is off by default.

## Questions, images, files, and voice

`AskUserQuestion` appears as an inline-keyboard message. A single-select question is answered immediately by clicking an option. Multi-select or multi-question prompts use **Submit**; a single-question prompt can also offer **Other**, after which the next text message from the addressed sender is used as the answer. Only the addressed sender or an admin policy can answer. Buttons and pickers expire after `askTimeoutMs` (default `360000` ms, six minutes). The core elicitation timeout is configurable from 30 seconds to 6 hours and defaults to 6 hours, so the Telegram control normally expires first.

For images, set `visionModel` to a vision-capable model, or leave it empty to use the chat's normal model. `maxImageBytes` defaults to `5242880` bytes and `maxImages` defaults to `4`; generated replies attach at most `maxUploadImages` images (default `4`). Shared files sent by the agent are capped at four per reply. Telegram messages are split for the platform's limits, and generated images and supported files are sent as attachments.

Voice uses a configured OpenAI-compatible provider from **Settings → Elowen AI**:

- `voiceProvider` selects the provider.
- `stt` enables transcription of incoming voice messages or audio; it is off by default.
- `sttModel` defaults to `whisper-1`.
- `tts` enables spoken replies when set to `true`; it is off by default and can be toggled per chat with `/voice`.
- `ttsModel` defaults to `gpt-4o-mini-tts`.
- `ttsVoice` defaults to `alloy` and accepts provider-supported voice IDs, for example `alloy`, `echo`, `fable`, `onyx`, `nova`, or `shimmer`.

The plugin provides `TelegramSend`, `TelegramChatInfo`, `TelegramGetMembersCount`, `TelegramMemberInfo`, pin/unpin and delete-message tools, member ban/unban and promotion, chat title/description updates, forum-topic create/edit/close, and the raw `TelegramApi` escape hatch. Availability follows the linked account's tool permissions; Bot API operations additionally require the bot's relevant Telegram rights. `TelegramSend` can target a numeric user/group/channel ID or public `@channelusername`.

[Next: Microsoft Teams](channels-teams)
