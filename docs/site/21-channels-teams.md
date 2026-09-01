---
title: Microsoft Teams
slug: channels-teams
order: 21
eyebrow: Channels
group: Channels
---

# Microsoft Teams

The Microsoft Teams plugin is an Azure Bot Framework adapter. Microsoft sends activities to your Elowen instance over HTTPS at:

```text
https://<domain>/hooks/msteams/messages
```

Your public reverse proxy must route `/hooks/` to the daemon and present a valid certificate. The Teams adapter is released through the plugin registry; once installed, configure it in **Settings → Plugins → Microsoft Teams**.

For shared identity and conversation rules, see [Channels](channels).

## What the plugin provides

The adapter supports personal chats, group chats, and team channels; Adaptive Cards for commands and questions; live tool activity; images; proactive cron/tick messages; and a downloadable Teams app package.

The Bot Connector can reach people and conversations it has already seen. Optional Microsoft Graph lookup lets the bot resolve an unseen person by e-mail and install the Teams app for that person before opening a 1:1 chat.

## Four independent permission surfaces

Teams setup is not one consent flow. These surfaces are independent and are configured or approved in different places.

### 1. Bot identity

Create a single-tenant Entra app registration, then create an Azure Bot resource of type **Single Tenant** using the same application ID. Enable the **Microsoft Teams** channel and set its messaging endpoint to:

```text
https://<domain>/hooks/msteams/messages
```

Enter the app's **Application (client) ID**, client secret, and **Directory (tenant) ID** as `appId`, `appPassword`, and `tenantId`.

Normal bot chat uses the Bot Connector and needs no Microsoft Graph permission or Graph admin consent. The plugin does not connect until all three bot credentials are configured.

### 2. Application Graph permissions

These permissions belong to the **bot app** and require tenant-admin consent. They are needed only when `graphLookup` is enabled, for messaging people the bot has never seen:

- `User.ReadBasic.All` — resolve an e-mail address to a tenant user.
- `TeamsAppInstallation.ReadWriteSelfForUser.All` — install the Teams app for that user so a 1:1 chat can be opened.
- `ProfilePhoto.Read.All` — optional directory avatars; without it, the linked Elowen avatar or initials are used.

`graphCatalogAppId` is the app ID of the uploaded app in **Teams admin center → Manage apps**. It is not the bot app's `appId`. Leave it empty only when a Teams app policy already deploys the app to users.

### 3. Resource-specific consent for team channels

Set `channelMessagesRsc` to `true` to add this application RSC permission to the generated Teams app package:

- `ChannelMessage.Read.Group`

A **team owner**, not a tenant administrator, approves this permission when the package is installed or updated in that team. The setting has no effect until you download the new package, upload it, and update the app in each team.

This makes the bot receive every message in a team channel where the app is installed, without requiring an @mention, and enables `historyLimit` backfill. If `respondWithoutMention` is `false`, the adapter still filters messages that do not address the bot.

### 4. Delegated Microsoft identity and Graph access

Microsoft 365 tools act as the signed-in person's delegated identity. They use a **second single-tenant Entra app registration**, separate from the bot app:

1. Create the second app and add the redirect URI:

   ```text
   https://token.botframework.com/.auth/web/redirect
   ```

2. Add the delegated scopes required by the Microsoft 365 tools and grant tenant-admin consent.
3. On the Azure Bot, create a Connection Setting with provider **Azure Active Directory v2**, using the second app's client ID, secret, tenant, and scopes. Leave **Token Exchange URL** empty.
4. Put the exact connection name in `oauthConnectionName` and enable `accountLinking`.

The connection stores tokens in Bot Framework Token Service, not in Elowen. The tools run with the linked account's Microsoft permissions, so they cannot access data that person cannot access. They are not restricted to the personal Teams chat: the linked Elowen account and its grants apply wherever that account is used, including shared Teams conversations and personal scheduled jobs. `m365AccessMode` controls mutations: `read_only` blocks them; `read_write` still previews each mutation until the agent explicitly commits it.

A practical delegated scope set is:

```text
openid profile email offline_access
User.Read User.Read.All People.Read
Files.ReadWrite.All Sites.ReadWrite.All
Mail.ReadWrite Mail.Send Mail.ReadWrite.Shared Mail.Send.Shared
Calendars.ReadWrite Calendars.ReadWrite.Shared
Contacts.ReadWrite Tasks.ReadWrite
Group.ReadWrite.All Notes.ReadWrite.All
Chat.ReadWrite ChatMessage.Send
Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send
```

`offline_access` is required for a connection that survives token expiry. Add `GroupMember.Read.All` if directory group-membership calls report that permission as missing. `Chat.Read.All` is deliberately not required by the Teams adapter; conversation history is backfilled from Bot Framework state or the team-channel RSC path.

## Connect the bot

1. In the [Entra admin center](https://entra.microsoft.com), open **App registrations → New registration**.
2. Choose **Accounts in this organizational directory only** and register the bot app.
3. Copy the **Application (client) ID** and **Directory (tenant) ID**.
4. Under **Certificates & secrets**, create a client secret and copy its value.
5. In the [Azure portal](https://portal.azure.com), create an **Azure Bot** with **Single Tenant** selected and the same application ID.
6. Set its messaging endpoint to `https://<domain>/hooks/msteams/messages` and enable the Microsoft Teams channel.
7. In Elowen, enter `appId`, `appPassword`, and `tenantId` under **Settings → Plugins → Microsoft Teams**.
8. Download the app package from the plugin workspace and upload it through **Teams admin center → Manage apps**, or sideload it where permitted.
9. Add the app to a personal chat, group chat, or team, then configure `rolePolicies`.

Download the package again whenever package-related settings change, especially `channelMessagesRsc`, `agentName`, `productName`, or `appIconPath`.

## Microsoft sign-in, direct linking, and provisioning

There are two separate Microsoft identity paths:

- **Personal-chat account linking (`accountLinking`)** uses the Azure Bot OAuth connection and delegated Microsoft 365 scopes. An enabled member of the configured tenant can sign in from a personal chat. The durable identity is the immutable Entra object ID; names and e-mail addresses are not used as the permanent key.
- **Web sign-in (`ssoEnabled`)** uses the bot app's own OIDC flow. Set `ssoRedirectBase` to the public HTTPS origin and register `<ssoRedirectBase>/api/auth/sso/microsoft/callback` on the bot app. `ssoLinkByEmail` may link one existing Elowen account by matching e-mail on first sign-in; after linking, the Entra object ID is durable.

Web sign-in can link a Microsoft identity to exactly one existing Elowen account by its e-mail claim when `ssoLinkByEmail` is enabled. To associate a known Teams identity with a different existing account, use the administrator-only **Link Elowen account** action in the Teams workspace; ambiguous or conflicting links are refused rather than guessed.

Set `ssoProvision` to `tenant` to create an Elowen account for an enabled member of the configured tenant when no existing link is found. This requires the bot app's **application** permission `User.Read.All` with tenant-admin consent. Provisioning rejects guests, disabled accounts, and identities outside the configured tenant.

Provisioning defaults apply only when a new account is created:

- `ssoDefaultProjects`
- `ssoDefaultModels`
- `ssoDefaultModel`
- `ssoDefaultPlugins`
- `ssoAllowedTools`
- `ssoDefaultYolo`

Unknown projects, models, plugins, and tools are ignored with warnings. Existing accounts are never re-provisioned, so administrator changes remain authoritative.

## Role policies

Configure `rolePolicies` in **Settings → Plugins → Microsoft Teams**. For shared chats, the first matching policy wins and a sender matching no policy receives no brain turn. When `accountLinking` is enabled, an unmapped sender in a personal chat may instead receive the Microsoft sign-in card and continue after successful onboarding.

A policy ID can be:

- an Entra object ID;
- a Teams account ID in the `29:…` form;
- a UPN or e-mail address, such as `alex@contoso.com`;
- a whole conversation ID, which admits everyone in that chat; or
- `*` as a final catch-all policy.

Set `admin` to enable room-administration behavior and trusted-room context. It does not grant an Elowen account, project access, tool permissions, Microsoft delegated access, or instance-operator access. Those come from the sender's linked Elowen account and its grants.

## Replies, history, and files

- Personal chats use the same identity gate as other turns. With `accountLinking` enabled, a sender who is not yet signed in first receives a sign-in card; without a linked Elowen account, no brain turn runs.
- In group chats, `respondWithoutMention` defaults to `true`; set it to `false` to require an @mention.
- Without `channelMessagesRsc`, Teams normally delivers only team-channel messages that @mention the bot. With the team owner's consent and an updated package, `channelMessagesRsc` makes the bot receive all channel messages; `respondWithoutMention: false` can still filter non-mention messages in the adapter.
- `historyLimit` defaults to `0` and accepts `0`–`100`. The adapter keeps an opt-in rolling transcript of messages it witnessed. With RSC consent, a new channel-thread conversation can also read that thread through Microsoft Graph.
- Bot file offers work only in personal 1:1 chats. They do not complete in group chats or team channels.
- `notifyConversationId` selects where proactive cron and tick messages are posted. It may be a known conversation ID or a person identified by e-mail, Entra object ID, `29:` account ID, or an unambiguous display name. Empty disables proactive pushes.

## Commands and cards

Teams renders model, reasoning, display, and context controls as Adaptive Cards. The command list comes from the running daemon.

| Command | Purpose |
|---------|---------|
| `/model` | Open an Adaptive Card model picker. |
| `/reasoning` | Open the reasoning-effort picker. |
| `/display` | Configure tool activity, answer delivery, tool output, and message layout. |
| `/context` | Move one of the invoking sender's own conversations into this chat. |
| `/new` | Start a fresh conversation. |
| `/stop` | Stop the running turn. |
| `/stats` | Show model, context usage, and usage. |
| `/compact` | Summarize the conversation to free context. |
| `/fast` | Set the linked account Fast preference; its optional value is `on`, `off`, or `status`. |
| `/restart` | Restart the daemon; admin only. |
| `/help` | Show the commands available to the current sender. |

`/model`, `/reasoning`, `/display`, and `/context` require an admin role policy; `/restart` is also admin-only. Other commands follow the running daemon's command catalog and session controls.

Microsoft 365 tools are not chat commands. They become available through the linked account, delegated OAuth connection, plugin grant, and per-user tool permissions.

[Next: WhatsApp](channels-whatsapp)
