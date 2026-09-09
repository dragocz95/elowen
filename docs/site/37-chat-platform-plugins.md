---
title: Chat Platform Plugins
slug: chat-platform-plugins
order: 37
eyebrow: Plugin reference
group: Plugin reference
---

# Chat Platform Plugins

The Discord, Telegram and WhatsApp plugins turn an Elowen instance into a bot on the matching chat platform. Each plugin ships one platform adapter: it receives platform events, admits senders according to the plugin's own policy settings, hands accepted messages to the conversation pipeline described on [Channels](channels), and renders the reply with the platform's native delivery features. Daily channel operation, commands and per-channel overrides are covered on the platform pages [Discord](channels-discord), [Telegram](channels-telegram) and [WhatsApp](channels-whatsapp). This page is the plugin reference: installation, tools and the full configuration field reference.

Microsoft Teams is a fourth chat platform with additional Microsoft 365 dependencies. It has its own page, [Microsoft Teams & Microsoft 365](microsoft-365-plugin).

## Behaviour shared by every platform adapter

All three plugins are installed from **Settings → Plugins → Available** and configured in the plugin detail view. Installation is refused when the running Elowen core is older than the version each manifest requires, currently 0.28.11. All three also declare shared API version 4, the exact version of the shared adapter library they are built against. Updates arrive through the same registry flow as any other plugin.

Credentials are entered in the plugin's setup view. Discord and Telegram take a bot token in a secret field: Elowen stores it in the encrypted secret store, and the form shows only whether a value is set, never the value itself, not even to administrators. A secret field is write-only. WhatsApp declares no secret field; its credentials are the paired device's session, written by the pairing flow into the plugin's own data and reused across reconnects.

A channel is bound to its conversation by the platform name plus the channel, thread or chat id, and a generation suffix that `/new` bumps to start a fresh conversation on the same surface. The binding, the chosen model, reasoning effort and per-channel display overrides persist in the plugin's data directory and survive restarts. A channel is not pinned to one Project: each turn uses the verified sender's linked Elowen account for project access, tool grants and model restrictions, and `/context` can move one of the sender's own conversations into the channel.

The platform policy, which is role policies on Discord and Telegram and sender policies on WhatsApp, decides admission, the room's extra prompt instructions and trusted shared-channel status. It is not an identity: a sender who matches no policy is ignored, and an admitted sender still needs a linked account for a turn to run.

When an admitted message arrives, the adapter resolves the policy, normalizes attachments against the configured media caps, and passes the turn to the daemon's channel pipeline. The pipeline runs the model and returns the reply; the adapter renders it with a live tool trace, processing reactions, a typing indicator and the configured answer mode. A turn that carries images is routed to the configured vision model. An `AskUserQuestion` is presented with the platform's native controls where they exist and expires after the configured timeout on Telegram and WhatsApp.

Every adapter also contributes a platform prompt: ordered Markdown files carried inside the plugin, which the loader attaches only to the platforms that plugin declares and actually registers. Fragments are capped at 16 files, 8,000 characters per file and 32,000 characters in total. They instruct the model to answer in the current conversation and to reserve the platform tools for explicit operations in other destinations.

Proactive messages such as cron and tick results, escalations and restart notices go to the notification destination each plugin configures. An empty destination disables proactive pushes, and a destination supplied by the host for one specific delivery overrides the fallback.

## Discord

Version 0.3.18. The adapter speaks the Discord Gateway and REST API from inside the plugin, so only the bot token and the Discord-side intents are needed. Setup:

1. In the Discord Developer Portal, create an application and a bot, and copy the token.
2. Enable the Message Content intent under Privileged Gateway Intents. Enable the Server Members intent as well if members will be listed with `DiscordListMembers`.
3. Invite the bot with the permissions for the operations it will be asked to perform.
4. Install the Discord plugin from **Settings → Plugins → Available**, enter the token, and configure at least one role policy. Set the optional guild restriction and notification destination.
5. Enable the plugin. It connects to the gateway and the tools become available.

Without a configured token the enabled plugin registers no platform and no tools. The notification destination picker still works and reports no destinations rather than failing.

### Discord tools

The plugin provides 25 tools: nine read tools, fifteen server-management tools, and the raw escape hatch. Every tool operates within the bot's own Discord permissions and the sender's linked Elowen tool grants.

| Tool | What it does |
| --- | --- |
| `DiscordListChannels` | Lists every channel of a guild with its active threads, so a channel named in a request can be resolved to the numeric id the other tools need. Archived threads are not included. |
| `DiscordReadChannel` | Reads a channel or thread's recent history in order, printing the message id first so it can be pinned or deleted; the output is capped and whole oldest lines are dropped rather than cut mid-id. |
| `DiscordServerInfo` | One-screen server summary: name, id, owner, approximate member and online counts, and channel and role totals. |
| `DiscordChannelInfo` | Settings of one channel or thread: type, name, topic, parent, NSFW flag, slowmode, and archive or lock state. |
| `DiscordMemberInfo` | One member's profile: username, server nickname, held role ids and join date. |
| `DiscordSearchMembers` | Prefix search over usernames and nicknames, the fast route from a person's name to their user id. |
| `DiscordListRoles` | All roles of a guild as id and name lines, to resolve a role name before granting or revoking it. |
| `DiscordListMembers` | Member list with held roles, up to 200 entries per call; requires the Server Members intent. |
| `DiscordListPins` | The pinned messages of a channel or thread, each body cut to 120 characters. |
| `DiscordPinMessage` | Pins a message to its channel's pinned list; a channel holds at most 50 pins. |
| `DiscordUnpinMessage` | Removes a pin; the message itself stays in the history. |
| `DiscordDeleteMessage` | Permanently deletes one message; there is no undo, so the target should be verified first. |
| `DiscordPurgeMessages` | Bulk-deletes recent messages, up to 5,000, keeping pinned ones unless asked otherwise, and expects a dry run first. Messages younger than 14 days go through the bulk endpoint in chunks of 100, older ones are deleted one by one, both throttled. |
| `DiscordAssignRole` | Grants a role to a member; the bot's highest role must outrank the granted role. |
| `DiscordRemoveRole` | Revokes a role, stripping the access it carried. |
| `DiscordCreateThread` | Opens a public thread in a text channel, optionally anchored to an existing message. |
| `DiscordArchiveThread` | Closes or reopens a thread; reversible and deletes nothing. |
| `DiscordLockThread` | Locks or unlocks a thread so only moderators can post. |
| `DiscordAddThreadMember` | Adds a guild member to a thread so it appears in their thread list. |
| `DiscordRemoveThreadMember` | Removes a member from a thread without touching roles or messages. |
| `DiscordCreateChannel` | Creates a text, voice, news, stage or forum channel, optionally nested under a category. |
| `DiscordCreateCategory` | Creates a category; existing channels are not moved into it. |
| `DiscordRenameChannel` | Renames a channel, thread or category; Discord rate-limits renames to roughly two per ten minutes per channel. |
| `DiscordDeleteChannel` | Permanently deletes a channel, thread or category; deleting a category leaves its channels in place. |
| `DiscordApi` | Raw escape hatch: any Discord REST v10 call with the bot token when no structured tool covers the operation. The body must be valid JSON, output is truncated at 4,000 characters, and rate-limited calls are retried automatically. |

### Discord configuration

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Connection | `sec_connection` | section | not set | Groups the connection settings. A section carries no value. |
| Bot token | `botToken` | secret | not set | Token from the Discord Developer Portal. Required; enable the Message Content intent. Write-only. |
| Guild ID | `guildId` | string | not set | Restricts the bot to one server; empty means every server the bot is in. Also the default guild for the server tools. |
| Allowed threads | `threadIds` | token list | not set | Thread IDs where the bot may respond; empty means respond wherever else allowed. |
| Notification destination | `notifyChannelId` | destination | not set | Channel or thread for proactive messages; empty disables them. The destination picker needs the token and guild id. |
| Replies and behavior | `sec_replies` | section | not set | Groups the reply settings. |
| Respond without mention | `respondWithoutMention` | boolean | `true` | On, the bot answers every message in channels it can see; off, only when @mentioned. |
| Tool activity | `toolActivity` | enum | `status` | `off`, `status` for live status, or `live` to also stream bounded command progress. Per-channel override with `/display`. |
| Answer delivery | `answerMode` | enum | `final` | `final` posts one complete answer below the tool trace; `live` edits the answer while it is written. |
| Tool output detail | `toolOutput` | enum | `summary` | `hidden`, `summary` or `tail`; how much bounded tool output appears under each status. Full raw output is never posted. |
| Tool message layout | `toolMessageMode` | enum | `single` | `single` keeps one live message; `per_tool` gives each tool call its own message. |
| Replace tool activity with answer | `deleteToolActivityAfterTurn` | boolean | `false` | The progress message is replaced in place by the final answer; overrides the live-answer and per-tool layouts. |
| Processing reactions | `reactions` | boolean | `true` | Shows processing status as reactions on the incoming message. |
| Runtime footer | `runtimeFooter` | boolean | `true` | Appends a small model and context line under the final reply. |
| Show reasoning | `showReasoning` | boolean | `false` | Streams extended-thinking reasoning into the progress bubble. |
| Service language | `language` | enum | `en` | Language of the bot's own service messages: `en`, `cs` or `sk`. |
| Conversation | `sec_conversation` | section | not set | Groups the conversation settings. |
| Channel history backfill | `historyLimit` | number | `0` | Loads up to 100 recent channel messages as context when a brand-new conversation starts; ongoing conversations never re-fetch. |
| Vision model | `visionModel` | model | not set | Model for turns that carry image attachments; empty uses the channel's normal model. |
| Media limits | `sec_media` | section | not set | Advanced group for the media caps. |
| Max inbound image size | `maxImageBytes` | number | `5242880` | Largest image attachment downloaded for vision, 1 to 20 MiB in 1 MiB steps; bigger ones are noted instead. |
| Max images per message | `maxImages` | number | `4` | Image attachments per incoming message sent to the vision model, 1 to 10. |
| Max file size (bytes) | `maxFileBytes` | number | not set | Largest non-image attachment stored in the sender's project; unset falls back to 25 MiB. |
| Max files per message | `maxFiles` | number | not set | Non-image attachments stored per message, 1 to 10; unset falls back to 5. |
| Max images per reply | `maxUploadImages` | number | `4` | Generated images attached to one outgoing reply, 1 to 10. |
| Voice | `sec_voice` | section | not set | Groups the voice settings. |
| Voice provider | `voiceProvider` | provider | not set | OpenAI-compatible provider that powers transcription and speech; reuses that provider's key. Empty keeps voice off. |
| Transcribe voice messages | `stt` | boolean | `false` | Transcribes incoming voice messages and audio with Whisper. |
| Speech-to-text model | `sttModel` | string | `whisper-1` | Whisper transcription model. |
| Speak replies (default) | `tts` | boolean | `false` | Default spoken-audio version of replies; toggled per channel with `/voice`. |
| Text-to-speech model | `ttsModel` | string | `gpt-4o-mini-tts` | Text-to-speech model. |
| TTS voice | `ttsVoice` | string | `alloy` | Voice ID such as `alloy`, `echo`, `fable`, `onyx`, `nova` or `shimmer`. |
| Role policies | `sec_roles` | section | not set | Groups the role policy settings. |
| Role policies | `rolePolicies` | rolePolicies | not set | Maps Discord role IDs, or `*` last, to admission, trusted status and room instructions. Projects and tools come from the sender's linked account. |

## Telegram

Version 0.2.14. The adapter uses the Bot API through grammY long-polling: Elowen opens an outbound connection, so no public webhook route is needed. Setup:

1. In Telegram, create the bot with @BotFather and copy the token. Disable BotFather's Group Privacy setting if the bot must receive every group message.
2. Install the Telegram plugin from **Settings → Plugins → Available** and enter the token.
3. Optionally restrict responses to specific chat ids and set the notification chat.
4. Configure at least one role policy and enable the plugin. The bot connects and publishes its command menu when the plugin loads.

Messages are sent as plain text without a markup mode, so model output never needs escaping and cannot break the send with stray markup.

### Telegram tools

The plugin provides 16 tools: three read tools, twelve messaging and moderation tools, and the raw escape hatch. Bot API operations additionally require the rights the bot holds on the target chat.

| Tool | What it does |
| --- | --- |
| `TelegramChatInfo` | Profile of one chat: id, type, title, username, description, whether topics are enabled, and the currently pinned message. |
| `TelegramGetMembersCount` | Member count of a group, supergroup or channel; the Bot API cannot enumerate members. |
| `TelegramMemberInfo` | One participant by numeric user id: name, username, membership status, and the rights an administrator holds. |
| `TelegramSend` | Sends a plain-text message to any chat the bot can reach; to answer in the current chat, reply normally instead. |
| `TelegramPinMessage` | Pins a message so members see it; requires the pin right and notifies the chat. |
| `TelegramUnpinMessage` | Removes a pin; the message stays in the history. |
| `TelegramDeleteMessage` | Permanently deletes one message for everyone; deleting other people's messages needs the delete right and is refused after 48 hours in many chat types. |
| `TelegramBanMember` | Bans a user, removing them and blocking their return until unbanned; requires the restrict right. |
| `TelegramUnbanMember` | Lifts a ban; the person still has to join again on their own. |
| `TelegramPromoteMember` | Sets a member's administrator rights; the call is absolute rather than additive, so omitted rights are taken away. |
| `TelegramSetChatTitle` | Renames a group, supergroup or channel, at most 128 characters; requires the change-info right. |
| `TelegramSetChatDescription` | Sets or clears the chat's profile description, at most 255 characters. |
| `TelegramCreateForumTopic` | Creates a topic in a forum-enabled supergroup and returns its thread id. |
| `TelegramEditForumTopic` | Renames an existing forum topic. |
| `TelegramCloseForumTopic` | Closes or reopens a forum topic; reversible and deletes nothing. |
| `TelegramApi` | Raw escape hatch: any Bot API method by name with a JSON parameter object, for methods without a dedicated tool such as restricting a member, media messages or invite links. Output is truncated at 4,000 characters. |

### Telegram configuration

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Connection | `sec_connection` | section | not set | Groups the connection settings. A section carries no value. |
| Bot token | `botToken` | secret | not set | Token from @BotFather. Required; disable Group Privacy to receive every group message. Write-only. |
| Allowed chats | `allowedChatIds` | token list | not set | Numeric user or group chat ids the bot responds in; empty means no additional allowlist. |
| Notification chat ID | `notifyChatId` | string | not set | Numeric chat id or @channelusername for proactive messages; empty disables them. |
| Replies and behavior | `sec_replies` | section | not set | Groups the reply settings. |
| Respond without mention | `respondWithoutMention` | boolean | `true` | On, the bot answers every message from a mapped sender in groups; off, only when @mentioned or replied to. Direct chats always get an answer. |
| Tool activity | `toolActivity` | enum | `status` | `off`, `status`, or `live` with bounded command progress. Per-chat override with `/display`. |
| Answer delivery | `answerMode` | enum | `final` | `final` posts one complete answer below the tool trace; `live` edits the answer while it is written. |
| Tool output detail | `toolOutput` | enum | `summary` | `hidden`, `summary` or `tail`; full raw output is never posted. |
| Tool message layout | `toolMessageMode` | enum | `single` | `single` keeps one live message; `per_tool` gives each tool call its own message. |
| Replace tool activity with answer | `deleteToolActivityAfterTurn` | boolean | `false` | The progress message is replaced in place by the final answer. |
| Processing reactions | `reactions` | boolean | `true` | Shows processing status using supported reactions on the incoming message. |
| Runtime footer | `runtimeFooter` | boolean | `true` | Appends a small model and context line under the final reply. |
| Show reasoning | `showReasoning` | boolean | `false` | Streams extended-thinking reasoning into the progress message. |
| Service language | `language` | enum | `en` | Language of the bot's own service messages: `en`, `cs` or `sk`. |
| Conversation | `sec_conversation` | section | not set | Groups the conversation settings. |
| Vision model | `visionModel` | model | not set | Model for turns that carry image attachments; empty uses the chat's normal model. |
| Media limits | `sec_media` | section | not set | Advanced group for the media caps. |
| Max inbound image size | `maxImageBytes` | number | `5242880` | Largest image attachment downloaded for vision, 1 to 20 MiB; bigger ones are noted instead. |
| Max images per message | `maxImages` | number | `4` | Image attachments per incoming message sent to the vision model, 1 to 10. |
| Max images per reply | `maxUploadImages` | number | `4` | Generated images attached to one outgoing reply, 1 to 10. |
| Question timeout (ms) | `askTimeoutMs` | number | `360000` | How long a pending question or picker stays open, 30 seconds to 30 minutes in 30-second steps. |
| Voice | `sec_voice` | section | not set | Groups the voice settings. |
| Voice provider | `voiceProvider` | provider | not set | OpenAI-compatible provider that powers transcription and speech; reuses that provider's key. Empty keeps voice off. |
| Transcribe voice messages | `stt` | boolean | `false` | Transcribes incoming voice messages and audio with Whisper. |
| Speech-to-text model | `sttModel` | string | `whisper-1` | Whisper transcription model. |
| Speak replies (default) | `tts` | boolean | `false` | Default spoken reply, delivered as a voice note; toggled per chat with `/voice`. |
| Text-to-speech model | `ttsModel` | string | `gpt-4o-mini-tts` | Text-to-speech model. |
| TTS voice | `ttsVoice` | string | `alloy` | Voice ID such as `alloy`, `echo`, `fable`, `onyx`, `nova` or `shimmer`. |
| Role policies | `sec_roles` | section | not set | Groups the role policy settings. |
| Role policies | `rolePolicies` | rolePolicies | not set | Maps a Telegram user id, @username or whole chat id, or `*` last, to admission, trusted status and room instructions. A chat id admits everyone in that chat. |

## WhatsApp

Version 0.2.17. The adapter pairs one WhatsApp account to Elowen over the WhatsApp Web multi-device protocol, then maps senders and groups to access. Setup:

1. Install the WhatsApp plugin from **Settings → Plugins → Available** and enable it.
2. Open the plugin's **Pairing** panel and select **Pair device**. Scan the QR in WhatsApp → Linked devices → Link a device, or set the pairing phone number and enter the displayed 8-character code under Link with phone number. The QR is also rendered into the plugin logs.
3. Configure at least one sender policy: a phone number, a personal JID, a whole group JID, or `*` last.
4. The bot then answers direct chats and groups of mapped senders. Newsletters and broadcast lists are not supported.

Credentials persist across reconnects. **Unpair device** logs the linked device out, removes the stored credentials, and requires pairing again. Native buttons and lists are unreliable on personal accounts, so every interactive prompt also carries a numbered text body and answers by number are always accepted.

### WhatsApp tools

The plugin provides 6 tools: two read tools and four messaging and group-management tools. There is no raw escape hatch; these six tools cover the whole surface the adapter exposes. Group changes require the paired account to be an administrator of that group.

| Tool | What it does |
| --- | --- |
| `WhatsappGroupList` | Lists every group the paired account participates in, with the group JIDs the other tools need. |
| `WhatsappGroupInfo` | Full metadata of one group: subject, description, owner, and the participant list with admin marks. |
| `WhatsappSend` | Sends a plain-text message from the paired account to any phone number, personal JID or group JID; a sent message cannot be recalled. |
| `WhatsappGroupCreate` | Creates a new group with a subject and initial participants; numbers not on WhatsApp are silently skipped by the platform. |
| `WhatsappGroupAdd` | Adds people to an existing group; the paired account must be a group administrator. |
| `WhatsappGroupRemove` | Removes participants from a group; announced to the group and undone only by adding them back. |

### WhatsApp configuration

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Connection | `sec_connection` | section | not set | Groups the pairing and destination settings. A section carries no value. |
| Pairing phone number | `phoneNumber` | string | not set | The bot's own number in international format without a plus sign. When set, the plugin shows an 8-character pairing code instead of a QR; empty pairs by QR. |
| Allowed groups | `groupIds` | token list | not set | Group JIDs where the bot may respond; empty means every group where a mapped sender writes. Direct chats stay allowed. |
| Notification chat | `notifyChat` | string | not set | Phone number or JID for proactive messages; empty disables them. |
| Replies and behavior | `sec_replies` | section | not set | Groups the reply settings. |
| Respond without mention | `respondWithoutMention` | boolean | `true` | On, the bot answers every message from a mapped sender in groups; off, only when @mentioned or replied to. Direct chats always get an answer. |
| Live progress trace | `streaming` | boolean | `true` | Edits one progress message with the tool trace while the agent works; the answer always arrives as one final message. Off sends only the final answer. |
| Replace tool activity with answer | `deleteToolActivityAfterTurn` | boolean | `false` | The progress message is replaced in place by the final answer. |
| Processing reactions | `reactions` | boolean | `true` | Shows processing status as reactions on the incoming message. |
| Runtime footer | `runtimeFooter` | boolean | `true` | Appends a small model and context line under the final reply. |
| Show reasoning | `showReasoning` | boolean | `false` | Streams extended-thinking reasoning into the progress message. |
| Service language | `language` | enum | `en` | Language of the bot's own service messages: `en`, `cs` or `sk`. |
| Conversation | `sec_conversation` | section | not set | Groups the conversation settings. |
| Vision model | `visionModel` | model | not set | Model for turns that carry image attachments; empty uses the chat's normal model. |
| Media limits | `sec_media` | section | not set | Advanced group for the media caps. |
| Max inbound image size | `maxImageBytes` | number | `5242880` | Largest image attachment downloaded for vision, 1 to 20 MiB; bigger ones are noted instead. |
| Max images per message | `maxImages` | number | `4` | Image attachments per incoming message sent to the vision model, 1 to 10. |
| Max images per reply | `maxUploadImages` | number | `4` | Generated images attached to one outgoing reply, 1 to 10. |
| Question timeout (ms) | `askTimeoutMs` | number | `360000` | How long a pending numbered question or menu stays open, 30 seconds to 30 minutes. |
| Sender policies | `sec_senders` | section | not set | Groups the sender policy settings. |
| Sender policies | `senderPolicies` | rolePolicies | not set | Maps a phone number, personal JID, whole group JID, or `*` last, to admission, trusted status and room instructions. A group id admits everyone in that group. |

## Permissions and limits

None of the three plugins is user-grantable, and none declares a consent capability, runtime controls, or per-account settings, so there is no per-user grant to manage. Their tools follow the sender's linked Elowen account tool permissions. All configuration lives in **Settings → Plugins**, an administrator surface. Discord exposes one administrator-only API route, `/plugins/discord/channels`, which backs the notification destination picker. WhatsApp exposes three administrator-only pairing routes and the **Pairing** panel, its only Web UI surface. Telegram declares neither API routes nor a Web UI panel.

Platform-side, every tool runs within the bot's or paired account's own rights, and a missing right returns a platform permission error:

- Discord: the Message Content intent is required to read message text and the Server Members intent to list members. Deleting or purging other people's messages, renaming or deleting channels, and locking threads need the matching manage permissions, and the bot's highest role must outrank any role it grants or revokes.
- Telegram: the bot must be a chat administrator with the right the operation needs, such as pin, delete, restrict, promote or change info. It can grant only rights it holds itself, cannot touch the chat creator, and cannot delete other people's messages older than 48 hours in many chat types.
- WhatsApp: group membership changes require the paired account to be a group administrator, and the paired account's own WhatsApp rights bound everything else.

Real limits observed in the adapters:

| Limit | Value |
| --- | --- |
| Outgoing message chunks | Discord 1,990 characters against a platform cap of 2,000; Telegram 4,000 against 4,096; WhatsApp 4,000. Telegram photo captions are capped at 1,024 characters. |
| Outgoing shared files | 4 per reply on every platform; this bound has no setting. |
| Spoken reply input | 4,000 characters; longer text is cut before synthesis. |
| Voice transcription | Clips over 25 MiB are not transcribed. |
| Discord rate limiting | A rate-limited response is waited out with the platform's retry-after value, up to three retries per call. |
| Telegram command menu | At most 100 commands; an entry that exceeds the platform's name or description limits is dropped rather than failing the whole menu. |
| Question timeout | Telegram and WhatsApp, `askTimeoutMs`, 6 minutes by default, 30 seconds to 30 minutes. |

The adapters refuse rather than guess. An unmapped sender is ignored silently. Discord ignores direct messages and group DMs, which carry no member context, along with bot and system messages and any server the guild restriction excludes. The Telegram tools return an error until the bot is connected, and the WhatsApp tools until the device is paired, rather than pretending to act.

[Next: Microsoft Teams & Microsoft 365](microsoft-365-plugin)