---
title: Discord
slug: channels-discord
order: 19
eyebrow: Channels
group: Channels
---

# Discord

The Discord plugin connects an Elowen bot to a Discord server. It uses the Discord Gateway for messages and registers slash commands with Discord.

For shared identity and conversation rules, see [Channels](channels).

## Connect the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Open **Bot**, create or reset the bot token, and copy it to a secure location.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
4. Invite the bot to the server with the permissions required for guild messages and registered application commands.
5. In Elowen, open **Settings → Plugins → Discord** and paste the token into **Bot token**.
6. Configure at least one role policy, then enable or reload the plugin.

The bot only handles guild messages. Direct messages do not contain a guild member role set, so they cannot match a Discord role policy.

## Role policies

Configure policies in **Settings → Plugins → Discord → Role policies**. The first matching policy wins; a member with no matching policy is ignored.

A policy matches a Discord role ID. Use `*` as a final catch-all policy for members who do not have a more specific mapped role. The `admin` flag makes the policy an operator policy for shared-channel controls and Discord administration features.

A role policy can also provide a role name and additional room instructions. Project access, tool permissions, and personal memory come from the sender's linked Elowen account, not from the Discord role.

## Replies and scope

- `respondWithoutMention` — `true` by default, so the bot answers every message it can see from an admitted sender. Set it to `false` to require an @mention.
- `guildId` — optional server ID restriction. Empty means every server where the bot is installed.
- `threadIds` — optional comma-separated thread IDs. When set, the bot responds only in those threads.
- `notifyChannelId` — optional channel ID for proactive cron, tick, escalation, and restart messages. Empty disables proactive pushes.

## Commands

The running daemon supplies the command list. The Discord adapter renders the controls as slash commands, select menus, and buttons.

| Command | Purpose |
|---------|---------|
| `/model` | Open a paginated model picker. |
| `/reasoning` | Open the reasoning-effort picker. |
| `/context` | Move one of the invoking sender's own conversations into this channel. |
| `/display` | Configure tool activity, answer delivery, tool output, and tool message layout. |
| `/voice` | Toggle spoken replies; accepts `on`, `off`, or a bare toggle. |
| `/new` | Start a fresh channel conversation. |
| `/stop` | Stop the running turn. |
| `/stats` | Show model, context usage, and usage. |
| `/compact` | Summarize the conversation to free context. |
| `/fast` | Set the linked account Fast preference; its optional value is `on`, `off`, or `status`. |
| `/restart` | Restart the daemon; admin only. |
| `/help` | Show the commands available to the current sender. |

Model, reasoning, display, voice, and context controls are shared channel state. They require an admin policy.

## Presentation

Set defaults in **Settings → Plugins → Discord** or override them in a channel with `/display`:

- **Tool activity:** `off`, `status`, or `live`.
- **Answer delivery:** `final` or `live`.
- **Tool output:** `hidden`, `summary`, or `tail`.
- **Tool message layout:** `single` or `per_tool`.

`deleteToolActivityAfterTurn` can replace one live progress message with the final answer. `runtimeFooter` appends a small model and context line. `showReasoning` is off by default.

## Channel history and media

`historyLimit` is `0` by default. Set it from `0` to `100` to load that many recent Discord messages when a **brand-new** channel conversation starts. Ongoing conversations do not fetch history again.

For images, set `visionModel` to a vision-capable model, or leave it empty to use the channel's normal model. `maxImageBytes` defaults to `5242880` bytes and `maxImages` defaults to `4`. Non-image attachments use `maxFileBytes` and `maxFiles`; generated replies use `maxUploadImages`.

## Voice

Voice uses a configured OpenAI-compatible provider from **Settings → Brain**. In the Discord plugin settings:

- `voiceProvider` selects the provider.
- `stt` enables transcription of incoming voice messages; it is off by default.
- `sttModel` defaults to `whisper-1`.
- `tts` sets the default for spoken replies; it is off by default.
- `ttsModel` defaults to `gpt-4o-mini-tts`.
- `ttsVoice` defaults to `alloy` and accepts `alloy`, `echo`, `fable`, `onyx`, `nova`, or `shimmer`.

`/voice` changes the setting for the current channel and requires an admin policy.

[Next: Telegram](channels-telegram)
