---
title: Discord
slug: channels-discord
order: 19
eyebrow: Channels
group: Channels
---

# Discord

The Discord plugin connects an Elowen bot to Discord through the Gateway and Discord REST API. It supports guild channels and threads, slash commands, live tool activity, attachments, voice, proactive notifications, and Discord server-management tools.

For shared identity and conversation rules, see [Channels](channels).

## Connect the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Under **Bot**, create or reset the bot token and store it securely.
3. Enable **Message Content Intent** under **Privileged Gateway Intents**. Enable **Server Members Intent** if you need `DiscordListMembers`.
4. Invite the bot with permission to read and send messages, use application commands, and perform any server operations you plan to request.
5. In **Settings → Plugins → Discord**, enter the token and configure at least one role policy.
6. Enable or reload the plugin.

The adapter serves real members in guild channels and threads. Direct messages and group DMs are ignored because they do not provide a guild member context. System messages, bot messages, and messages from a configured-out guild are also ignored.

## Admission and permissions

Configure **Role policies** in **Settings → Plugins → Discord**. Policies are evaluated in order and the first matching policy wins. A member without a match is ignored. A `*` policy matches every guild member, including members with no additional roles; put it last.

A policy can define a role name and extra room instructions. The Discord role is the admission and room-access mapping; it is not an Elowen account. Personal settings and account-owned conversations require the sender's Discord ID to be linked to an Elowen account; project and tool access come from that linked account.

Set `admin: true` on the effective policy to grant trusted shared-channel status. This is required for shared channel controls such as `/model`, `/reasoning`, `/context`, `/display`, and `/voice`, and for admin-only session controls such as `/restart`. The role alone does not make the sender the Elowen owner or grant owner-only `Elowen*` tools or the owner API token; those depend on the sender's separately linked account. Plugin tools are additionally subject to the current Elowen tool policy and the bot's Discord permissions; destructive Discord operations can still fail with a Discord permission error.

Each guild channel or thread has one shared conversation and shared channel settings. A reply is posted back to the current channel or thread; use Discord tools only when you explicitly need to operate on another destination.

## Replies, threads, and destinations

- `respondWithoutMention` — `true` by default, so an admitted sender's visible message is answered. Set it to `false` to require an @mention.
- `guildId` — optional server ID restriction. Empty means every guild where the bot is installed.
- `threadIds` — optional token list of thread IDs. When non-empty, the bot responds only in those threads. The setting accepts one ID per token and retains compatibility with comma- or newline-separated values.
- `notifyChannelId` — optional notification destination for cron/tick results and escalations. Choose a text channel or active public/private thread in the destination picker; empty disables proactive pushes. Legacy raw IDs remain valid.

The destination picker requires both `botToken` and `guildId`. It lists text channels and active public/private threads, but not categories, voice/news/stage channels, forum/media parents, or archived threads. The plugin also exposes the admin API route `/plugins/discord/channels` for this list.

## Commands

The running daemon supplies the command catalog; Discord renders applicable commands as slash commands, select menus, and buttons. Plugin prompt commands may add further slash commands when their plugin is enabled.

| Command | Purpose |
|---------|---------|
| `/model` | Open a paginated shared-channel model picker; admin policy required. |
| `/reasoning` | Choose the shared-channel reasoning effort; admin policy required. |
| `/context` | Move one of the invoking sender's own linked conversations into this channel; admin policy required. |
| `/display` | Configure shared tool activity, answer delivery, tool output, and message layout; admin policy required. |
| `/voice` | Toggle spoken replies with `on`, `off`, or no value to toggle; admin policy required. |
| `/new` | Start a fresh conversation for this channel or thread. |
| `/stop` | Stop the running turn. |
| `/stats` | Show model, context, and usage information. |
| `/compact` | Summarize the conversation to free context. |
| `/fast` | Set the linked account Fast preference; accepts `on`, `off`, or `status`. |
| `/restart` | Restart the daemon; admin policy required. |
| `/help` | Show commands available on the current surface. |

## Presentation

Set defaults in **Settings → Plugins → Discord** or override them per channel with `/display`:

- **Tool activity:** `off`, `status`, or `live` (live output includes bounded command progress).
- **Answer delivery:** `final` or `live`.
- **Tool output:** `hidden`, `summary`, or `tail`.
- **Tool message layout:** `single` or `per_tool`.

`deleteToolActivityAfterTurn` replaces the live progress message with the final answer. `runtimeFooter` appends a compact model and context line. `reactions` controls processing reactions and is enabled by default. `showReasoning` is disabled by default.

## Conversation, media, and voice settings

- `historyLimit` defaults to `0`; set `0`–`100` to load that many recent messages only when a brand-new channel conversation starts. Ongoing conversations do not re-fetch history.
- `visionModel` selects the model for image turns; empty uses the channel's normal model.
- `maxImageBytes` defaults to `5242880` bytes and `maxImages` to `4`.
- `maxFileBytes` defaults to `26214400` bytes and `maxFiles` to `5`; oversized or excess attachments are noted instead of downloaded.
- `maxUploadImages` defaults to `4` generated images per reply.
- `language` defaults to `en` and controls the bot's service messages; `cs` and `sk` are also available.

Voice uses a configured OpenAI-compatible provider from **Settings → Elowen AI**:

- `voiceProvider` selects the provider; leave it empty to keep voice unavailable.
- `stt` enables incoming voice transcription and is off by default; `sttModel` defaults to `whisper-1`.
- `tts` enables spoken replies when set to `true`; it is off by default. `ttsModel` defaults to `gpt-4o-mini-tts`.
- `ttsVoice` defaults to `alloy` and accepts provider-supported voice IDs, for example `alloy`, `echo`, `fable`, `onyx`, `nova`, or `shimmer`.

`/voice` changes the setting for the current channel and requires an admin policy. Non-image files use the `maxFileBytes` and `maxFiles` limits; audio is handled separately and transcription is limited to 25 MiB per clip. Generated images and shared files are uploaded as Discord attachments.

## Discord tools

The plugin provides `DiscordApi` plus 24 structured tools for server info, channels, threads, members, roles, pins, and message management. Use `DiscordListChannels` first when a request names a channel or thread; it returns IDs and active threads. `DiscordReadChannel` returns message IDs suitable for pinning or deleting.

Raw `DiscordApi` is an escape hatch for REST v10 operations not covered by a structured tool and can make irreversible changes. Prefer the structured tools, verify targets before destructive actions, and remember that Elowen tool policy and Discord bot permissions both apply.

[Next: Telegram](channels-telegram)
