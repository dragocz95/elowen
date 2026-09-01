---
title: WhatsApp
slug: channels-whatsapp
order: 22
eyebrow: Channels
group: Channels
---

# WhatsApp

The WhatsApp plugin uses Baileys WhatsApp Web multi-device. Pair one WhatsApp account, then map senders or groups to Elowen access.

For shared identity and conversation rules, see [Channels](channels).

## Pair an account

1. In Elowen, open **Settings → Plugins → WhatsApp** and enable the plugin.
2. Open **Pairing** and choose **Pair device**.
3. Pair using one of these methods:
   - **QR code:** open WhatsApp → **Linked devices → Link a device** and scan the displayed code.
   - **Phone pairing code:** set `phoneNumber` to the bot's international number (digits are sufficient; `+`, spaces, and dashes are ignored). Enter the displayed 8-character code in WhatsApp → **Linked devices → Link with phone number**.
4. Configure at least one sender policy.

The pairing screen exposes the current QR code or pairing code and whether the account is connected. Credentials persist across reconnects. **Unpair device** logs the linked device out, removes local credentials, and requires pairing again.

## Sender policies and JIDs

Configure policies in **Settings → Plugins → WhatsApp → Sender policies**. The first matching policy wins; an unmatched sender is ignored. Policy matching compares identifiers by their digits, so a bare number, a formatted number, and its personal JID are equivalent.

A policy ID can be:

- a phone number, such as `420777123456`;
- a personal JID ending in `@s.whatsapp.net`;
- a group JID ending in `@g.us`, which admits every sender in that group; or
- `*` as a final catch-all policy. Put it after named policies.

WhatsApp can address personal chats with an internal `@lid` JID. When Baileys supplies the corresponding phone-number JID in its alternate field, the plugin prefers that stable phone identity; otherwise the LID remains a separate inbound identifier and must not be treated as a phone-number account link.

Set `admin` to allow shared-chat controls. WhatsApp tools are separately governed by the sender's linked Elowen tool grants and by the paired account's WhatsApp rights, such as being an administrator of a group. Project access and personal memory also come from the linked Elowen account.

## Direct chats and groups

- A direct chat is identified by its personal chat JID (`@s.whatsapp.net` or `@lid`) and is marked as a one-person conversation. An admitted sender can use it without a mention.
- A group chat is identified by its `@g.us` JID. The sender is matched by their personal identifier, and the group JID is also available for a group-wide policy.
- `respondWithoutMention` is `true` by default. In groups, the bot answers every message from an admitted sender. Set it to `false` to require an @mention or a reply to the bot.
- `groupIds` optionally restricts responses to a list of group JIDs. Empty means every group where an admitted sender writes. Direct chats remain allowed for admitted senders.

## Commands and asks

WhatsApp does not rely on native buttons or lists. Model, reasoning, context, and agent questions use numbered text prompts; reply with the requested number.

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

Model, reasoning, and context pickers require an admin policy. Session controls follow their command gates, and `/fast` requires a linked account. WhatsApp has no `/display` or `/voice` command.

An `AskUserQuestion` is posted as a numbered prompt with up to four questions and up to 25 options per question. For a single question, reply with one option number; multi-select accepts comma-separated numbers. Unless `custom` is disabled, free text is also accepted. Multi-question prompts can be submitted with `submit`; numbered option selection is supported only for single-question prompts, while free text is collected for the first question when allowed. The default timeout is 6 minutes, configurable with `askTimeoutMs` from 30 seconds to 30 minutes; the same timeout applies to numbered menus. Expired or cancelled prompts are closed and can no longer consume a later number reply.

## Live messages and notifications

`streaming` defaults to `true`. The plugin edits one progress message while the agent works; the trace can include tool calls and results, diffs, sub-agent summaries, and retry notices. The final answer is sent as one separate message. Set `streaming` to `false` to send only the final answer. With `deleteToolActivityAfterTurn`, the progress message is replaced in place by the final answer; it is not deleted.

Processing reactions (`👀`, `✅`, `❌`) are enabled by default. `reactions: false` disables them.

`notifyChat` selects the default destination for proactive cron/tick results, escalations, and restart notices. It accepts a bare phone number, a personal JID, or a group JID; bare numbers are converted to `@s.whatsapp.net`. An explicit destination supplied by the host takes precedence over `notifyChat`. An empty destination disables the push. Notification messages are not sender-policy-gated, but the WhatsApp connection must be paired.

WhatsApp has no speech-to-text, text-to-speech, or `/voice` support. A voice message arrives as an untranscribed audio attachment.

For images, set `visionModel` to a vision-capable model, or leave it empty to use the chat's normal model. `maxImageBytes` defaults to `5242880` bytes, `maxImages` defaults to `4`, and `maxUploadImages` defaults to `4`.

[Next: Plugins](plugins)
