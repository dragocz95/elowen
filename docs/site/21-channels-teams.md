---
title: Microsoft Teams
slug: channels-teams
order: 21
eyebrow: Channels
group: Channels
---

# Microsoft Teams

The Microsoft Teams plugin is an Azure Bot Framework webhook. Microsoft sends activities to your Elowen instance over HTTPS at:

```text
https://<domain>/hooks/msteams/messages
```

Your public reverse proxy must route that path to the daemon and present a valid certificate.

For shared identity and conversation rules, see [Channels](channels).

## Four independent Microsoft permission surfaces

Teams setup is not one consent flow. These four surfaces are independent, and each is approved in a different place.

### 1. Bot identity

Create a single-tenant Entra app registration, create an Azure Bot resource of type **Single Tenant** using the same app ID, add the **Microsoft Teams** channel, and set the messaging endpoint to `https://<domain>/hooks/msteams/messages`.

This surface requires **no Microsoft Graph permission and no admin consent**. It is enough for working chat, but the bot can reach only people it has already seen.

### 2. Application Graph permissions for directory lookup

These permissions belong to the **bot app** and are consented once by a tenant administrator. Enable them by setting `graphLookup` to `true`:

- `User.ReadBasic.All` — resolve an e-mail address to a tenant user.
- `TeamsAppInstallation.ReadWriteSelfForUser.All` — install the Teams app for that user so a 1:1 chat can be opened.
- `ProfilePhoto.Read.All` — optional; used only for directory avatars. Without it, the plugin logs one warning and the rest continues to work.

The install flow also needs `graphCatalogAppId`. This is the app ID in the organisation's Teams catalog under **Teams admin center → Manage apps**. It is a different GUID from the bot app's ID.

### 3. Resource-specific consent for team channels

Set `channelMessagesRsc` to `true` to add this permission to the generated Teams app package:

- `ChannelMessage.Read.Group` (type: `Application`)

A **team owner** approves this resource-specific consent when the app is installed or updated in that team. A tenant administrator is not involved. It is the least-privileged option for the team-channel use case.

The setting alone changes nothing. Re-download the app package, install or update it in each team, and have the team owner accept the new prompt. Even with consent, Teams delivers a team-channel message to the bot only when the bot is @mentioned.

### 4. Delegated Graph access for Microsoft 365 tools

Microsoft 365 tools use a **second Entra app registration**, separate from the bot app. Configure its redirect URI as:

```text
https://token.botframework.com/.auth/web/redirect
```

Wire that app to the Azure Bot as a Connection Setting with provider **Azure Active Directory v2**. Leave **Token Exchange URL** empty. Put the connection's name in `oauthConnectionName` and switch `accountLinking` on.

The Microsoft 365 tools then act as the signed-in person and are available only in that person's personal Teams chat. Delegated access is separate from the bot identity, application Graph permissions, and team-level resource-specific consent.

## Connect the bot

1. In the [Entra admin center](https://entra.microsoft.com), open **App registrations → New registration**.
2. Choose **Accounts in this organizational directory only** and register the app.
3. Copy the **Application (client) ID** and **Directory (tenant) ID**.
4. Under **Certificates & secrets**, create a client secret and copy its value.
5. In the [Azure portal](https://portal.azure.com), create an **Azure Bot** with **Single Tenant** selected and the same application ID.
6. Set its messaging endpoint to `https://<domain>/hooks/msteams/messages` and enable the Microsoft Teams channel.
7. In Elowen, open **Settings → Plugins → Microsoft Teams** and enter **Microsoft App ID**, **Client secret**, and **Tenant ID**.
8. Download the app package from the plugin's **Connection** card and upload it through the Teams admin center or sideload it where permitted.
9. Add the app to a personal chat, group chat, or team, then configure a role policy.

The generated package contains the Teams manifest and icons. Download it again whenever you change package-related settings, including `channelMessagesRsc`.

## Role policies

Configure policies in **Settings → Plugins → Microsoft Teams → Role policies**. The first matching policy wins; an unmapped sender receives no brain turn.

A policy ID can be:

- an Entra object ID;
- a UPN or e-mail address, such as `alex@contoso.com`;
- a whole conversation ID, which admits everyone in that chat; or
- `*` as a final catch-all policy.

Set `admin` to enable room-administration slash commands and trusted-channel context. It does **not** grant an Elowen account, project access, tool permissions, or instance-operator access. Those come from the sender's linked Elowen account.

## Replies, history, and files

- Personal chats always work for an admitted sender.
- Group-chat behavior follows `respondWithoutMention`, which defaults to `true`; set it to `false` to require an @mention.
- Team-channel messages require an @mention, including when `channelMessagesRsc` is enabled.
- `historyLimit` defaults to `0` and accepts `0`–`100`. The Bot Connector cannot read arbitrary past activities, so the plugin keeps an opt-in rolling transcript of messages it witnessed. With RSC consent, a brand-new conversation in a channel thread can additionally read that thread through Microsoft Graph.
- Bot file offers work only in personal 1:1 chats. They do not complete in group chats or team channels.
- `notifyConversationId` selects where proactive cron and tick messages are posted. Empty disables proactive pushes.

## Commands and cards

Teams renders model, reasoning, display, and context controls as Adaptive Cards. The command list comes from the running daemon.

| Command | Purpose |
|---------|---------|
| `/model` | Open an Adaptive Card model picker. |
| `/reasoning` | Open the reasoning-effort picker. |
| `/display` | Configure tool activity and answer delivery. |
| `/context` | Move one of the invoking sender's own conversations into this chat. |
| `/new` | Start a fresh conversation. |
| `/stop` | Stop the running turn. |
| `/stats` | Show model, context usage, and usage. |
| `/compact` | Summarize the conversation to free context. |
| `/fast` | Toggle OpenAI OAuth priority processing; its optional value is `on` or `off`. |
| `/restart` | Restart the daemon; admin only. |
| `/help` | Show the commands available to the current sender. |

Microsoft 365 tools are not chat commands. They become available through the linked account and delegated connection described above.

[Next: WhatsApp](channels-whatsapp)
