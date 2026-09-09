---
title: Microsoft Teams & Microsoft 365
slug: microsoft-365-plugin
order: 38
eyebrow: Plugin reference
group: Plugin reference
---

# Microsoft Teams & Microsoft 365

The Microsoft Teams plugin is two things in one package. As a chat platform it runs an Azure Bot Framework bot that answers in personal chats, group chats and team channels, with Adaptive Cards, slash commands and proactive messages. As a tool provider it equips the agent with outbound Teams messaging and directory tools for the bot, plus a Microsoft 365 suite that acts with a linked person's delegated Microsoft identity. This page is the plugin reference for installation, identity, tools, configuration fields, permissions, and limits. Channel-side setup and day-to-day behavior are described in [Microsoft Teams](channels-teams).

## Where it appears

**Plugin card.** The plugin appears in **Settings → Plugins → Installed** as **Microsoft Teams**. Its detail view carries the standard plugin tabs, and the required bot credentials stay flagged until they are complete.

**Web UI.** The plugin contributes an administrator-only workspace to the Web UI, titled **Microsoft Teams** and reached from the main navigation. It has **People & access** and **Settings** tabs, shows the people the bot knows together with their linked Elowen accounts, links or changes the Elowen account behind a Microsoft identity, signs a person's Microsoft session out, and serves the downloadable Teams app package. The workspace and every API route behind it are restricted to administrators. It requires web API version 12.

**Chat platform and destinations.** The plugin registers itself as the `msteams` chat platform, receives Microsoft's activities on the instance webhook, and offers its chats and channels as proactive notification destinations for scheduled jobs.

**Shared identity control.** The plugin publishes the `microsoftIdentity` control so other plugins can build on a linked person's Microsoft identity without talking to Teams. A consumer can ask whether an Elowen account has a linked identity, and can obtain a Graph client that is restricted to that person's OneDrive and SharePoint drive namespace. The control is registered only while personal-chat account linking is configured and working.

**Tools.** Seventeen tools in four groups.

Teams messaging:

- `TeamsSend` posts a markdown message into a conversation the bot already participates in, converting `<@id>`, an e-mail or an exact display name into a real Teams mention.
- `TeamsMessagePerson` writes to a person by e-mail, Entra object ID, Teams account ID or display name and opens or reuses their private 1:1 chat; an ambiguous display name is refused rather than guessed.
- `TeamsSendFile` offers a local file to a person in their 1:1 chat. The upload into the recipient's OneDrive happens only after they accept the consent card.

Directory and people, all read-only:

- `TeamsFindPerson` searches the people the bot has actually met, by e-mail, ID, account ID or partial name, and is the safe pre-check before writing to someone.
- `TeamsChatInfo` shows a conversation's ID, type, tenant and member count.
- `TeamsMembers` lists a conversation's roster, and reading the roster teaches the bot who those people are so they can be messaged afterwards.
- `TeamsMemberInfo` resolves one member's identity inside one conversation.
- `TeamsListConversations` lists the conversations the bot can reach, with paging.

Connector escape hatch:

- `TeamsApi` calls the Bot Connector REST API directly with any method and path the bot credentials allow, for endpoints no dedicated tool covers.

Microsoft 365, delegated. Each tool acts as the signed-in person, and the access tokens remain in the Bot Framework Token Service:

- `MicrosoftDirectory` reads the signed-in user, relevant people, Entra users, the organization chart and group memberships.
- `MicrosoftSharePoint` searches and manages SharePoint sites, lists, list items and modern pages.
- `MicrosoftFiles` searches and manages OneDrive and SharePoint drive items, including upload, download, versions and sharing links.
- `MicrosoftOutlook` covers mail, calendar and contacts, including attachments, drafts, replies and event responses.
- `MicrosoftTasks` covers To Do lists and Planner plans, buckets and tasks.
- `MicrosoftOneNote` reads and manages notebooks, sections and pages.
- `MicrosoftExcel` reads and updates worksheets, tables and ranges in a workbook stored in Microsoft 365.
- `MicrosoftTeams` reads and posts in chats and channels as the signed-in human rather than as the bot.

The five directory and people tools are declared plan-safe and may run in plan mode; every other tool of this plugin counts as mutating for planning.

## Install and connect

1. Check the version prerequisites. The manifest requires core 0.28.23 or newer, and the marketplace refuses the install on an older core. The plugin also pins the shared plugin API exactly at version 4, and its Web UI workspace requires web API version 12.
2. Install from **Settings → Plugins → Available**. Elowen lands a validated copy disabled and enables it in the same operation when no further approval is required. Because the manifest declares that the plugin reads stores and project files and mutates users, review and acknowledge those capabilities when prompted.
3. Register the bot on the Microsoft side. This means a single-tenant Entra app registration, an Azure Bot resource of type Single Tenant bound to the same application ID, the Microsoft Teams channel, and the messaging endpoint pointing at the instance webhook `/hooks/msteams/messages`. Download the app package from the workspace and upload it in the Teams admin center. The full walkthrough is in [Microsoft Teams](channels-teams).
4. Enter the three bot credentials in the plugin settings: the application client ID, a client secret and the tenant ID. The plugin does not connect until all three are present.
5. Optional, for the Microsoft 365 tools and personal-chat sign-in: create a second, separate Entra app registration, add an OAuth connection of the Entra ID v2 provider on the Azure Bot with the delegated Microsoft 365 scopes, enter the exact connection name in the plugin settings, and enable personal-chat sign-in. Tenant-admin consent for the delegated scopes happens on the Microsoft side.
6. Link identities. When account linking is on, an enabled tenant member signs in from a personal chat. An administrator can also link an existing Elowen account to a person from the People & access tab. The durable identity is the immutable Entra object ID, never a name or e-mail address.

To sign in to the Elowen web interface with a Microsoft account as well, enable the single sign-on group in the settings and register the redirect URI on the bot app. [Microsoft Teams](channels-teams) documents the exact redirect and the provisioning behavior.

## Configuration

Settings live in the plugin detail view and are saved without a daemon restart. The schema has 48 entries: 8 group headings, which only label the form, and 40 settings. Fields noted as conditional appear only when their switch is on. The client secret is a secret field and therefore write-only: Elowen stores it in the encrypted secret store and shows only whether it is set, including to administrators.

### Connection

Schema group `sec_connection`.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Microsoft App ID | `appId` | string | not set | Required. Application client ID of the single-tenant Entra app registration, also the bot ID of the Azure Bot resource. |
| Client secret | `appPassword` | secret | not set | Required and write-only. A client secret from the app registration, used to call the Bot Connector API. |
| Tenant ID | `tenantId` | string | not set | Required. Entra Directory (tenant) ID; the bot authenticates against this tenant. |
| Personal-chat Microsoft sign-in | `accountLinking` | boolean | `false` | Lets enabled member accounts sign in from a personal chat and use their own account's projects and tool permissions wherever that person writes. |
| OAuth connection name | `oauthConnectionName` | string | not set | Conditional, shown when account linking is on. The exact name of the Azure Bot OAuth connection that uses the Entra ID v2 provider. |

### Microsoft single sign-on

Schema group `sec_sso`.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Enable Microsoft sign-in | `ssoEnabled` | boolean | `false` | Shows Microsoft sign-in on the Elowen login page when the public redirect base is configured correctly. |
| Public Elowen URL | `ssoRedirectBase` | string | `""` | Conditional. Absolute public HTTPS URL without a path; the redirect URI `<base>/api/auth/sso/microsoft/callback` must be registered on the bot app. |
| Account provisioning | `ssoProvision` | enum: `off`, `tenant` | `off` | Conditional. Entire tenant creates an account on first sign-in for enabled tenant members and requires the application permission User.Read.All with tenant-admin consent. |
| Link existing accounts by e-mail | `ssoLinkByEmail` | boolean | `true` | Conditional. On first sign-in the identity may link to one existing account with the same e-mail; afterwards the Entra object ID is the durable identity. |
| Default projects for new accounts | `ssoDefaultProjects` | projects | not set | Conditional. Projects assigned only when a new account is provisioned. |
| Allowed models for new accounts | `ssoDefaultModels` | models | not set | Conditional. Model allow-list for provisioned accounts; empty leaves it unrestricted. |
| Preferred model for new accounts | `ssoDefaultModel` | model | `""` | Conditional. Preferred model for provisioned accounts; empty leaves it unset. |
| Granted plugins for new accounts | `ssoDefaultPlugins` | plugins | not set | Conditional. Grant-gated plugins available to provisioned accounts. |
| Granted tools for new accounts | `ssoAllowedTools` | tools | not set | Conditional. Tools for provisioned accounts; empty grants none until an administrator grants some. |
| YOLO for new accounts | `ssoDefaultYolo` | boolean | `false` | Conditional, marked high risk. Auto-approves tool and command prompts in new conversations for provisioned accounts; deny rules still apply. Existing accounts are never changed. |

### Microsoft 365 access

Schema group `sec_m365`.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Microsoft 365 access | `m365AccessMode` | enum: `read_only`, `read_write` | `read_only` | Conditional, shown when account linking is on. Read only blocks every external mutation; read and write still previews each mutation until the agent commits the exact operation. |
| Microsoft file transfer limit | `m365MaxTransferBytes` | number | `20971520` | Advanced. Transfer cap in bytes per tool call, between 1048576 and 262144000. Larger uploads use a resumable Microsoft upload session. |

### App package and notifications

These fields have no group heading of their own and sit between the Microsoft 365 and proactive groups.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| App name in Teams | `agentName` | string | not set | Name of the app and bot in the downloadable package; empty uses Elowen. Set it when the name collides with another app in the organization's Teams catalog. |
| Publisher name in Teams | `productName` | string | not set | Publisher shown on the app package; empty uses the configured app name. |
| App icon in Teams | `appIconPath` | string | not set | Server-side path to a PNG of exactly 192 by 192 pixels for the package icon. A missing or wrong-size file fails the package download with the reason. |
| Notification conversation | `notifyConversationId` | destination | not set | Where proactive cron and tick messages are posted; empty disables proactive pushes. Destinations are learned from real Teams traffic. |

### Reaching people first

Schema group `sec_proactive`.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Microsoft Graph lookup | `graphLookup` | boolean | `false` | Lets the bot resolve an unknown e-mail against the tenant directory and install the Teams app for that person so a 1:1 chat can open. Requires the application permissions User.ReadBasic.All and TeamsAppInstallation.ReadWriteSelfForUser.All with tenant-admin consent; directory avatars additionally use ProfilePhoto.Read.All. |
| Teams catalog app ID | `graphCatalogAppId` | string | not set | Conditional, shown when Graph lookup is on. The app's ID in the organization's Teams catalog, needed to install the app for someone who does not have it yet; leave empty when a Teams app policy deploys the app. |

### Replies and behavior

Schema group `sec_replies`.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Respond without mention | `respondWithoutMention` | boolean | `true` | On, the bot answers every message from a mapped sender in group chats; off, only when @mentioned. |
| Tool activity | `toolActivity` | enum: `off`, `status`, `live` | `status` | What the progress message shows while the agent works: nothing, status lines, or status plus live output. |
| Answer delivery | `answerMode` | enum: `final`, `live` | `final` | One reply when the turn ends, or the answer streamed into a message as it is written. |
| Tool output detail | `toolOutput` | enum: `hidden`, `summary`, `tail` | `summary` | How much of each finished tool's result the progress message keeps. |
| Tool message layout | `toolMessageMode` | enum: `single`, `per_tool` | `single` | One edited progress message, or one message per tool call. |
| Replace tool activity with answer | `deleteToolActivityAfterTurn` | boolean | `false` | Reuses the progress message for the final answer and overrides the live-answer and per-tool layouts. |
| Processing reactions | `reactions` | boolean | `true` | Shows processing status as reactions on the incoming message. |
| Runtime footer | `runtimeFooter` | boolean | `true` | Appends a small model and context line under the final reply. |
| Show reasoning | `showReasoning` | boolean | `false` | Streams extended-thinking reasoning into the progress message; usually noise. |
| Service language | `language` | enum: `en`, `cs`, `sk` | `en` | Language of the bot's own service messages; the agent answers in the user's language. |

### Conversation

Schema group `sec_conversation`.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Conversation history backfill | `historyLimit` | number | `0` | How many recent messages a brand-new conversation loads as context, between 0 and 100. |
| Read every channel message | `channelMessagesRsc` | boolean | `false` | Adds the ChannelMessage.Read.Group resource-specific permission to the app package, so the bot sees every message in teams where a team owner consents to the updated package. |
| Vision model | `visionModel` | model | not set | Model for turns that carry image attachments; empty uses the chat's normal model. |

### Media limits

Schema group `sec_media`, marked advanced.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Max inbound image size | `maxImageBytes` | number | `5242880` | Largest image attachment the bot downloads for vision, between 1048576 and 20971520 bytes. |
| Max images per message | `maxImages` | number | `4` | Image attachments per incoming message sent to the vision model, between 1 and 10. |
| Max images per reply | `maxUploadImages` | number | `4` | Generated images attached to one outgoing reply, between 1 and 10. |

### Role policies

Schema group `sec_roles`.

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Role policies | `rolePolicies` | rolePolicies | not set | The first matching policy admits a sender. An entry is an Entra object ID, a UPN or e-mail, a whole conversation ID, or `*` as a final catch-all placed last. The admin flag enables room-administration commands and trusted-room context only; project and tool permissions always come from the sender's linked Elowen account. |

## Permissions and consent

The manifest does not mark this plugin as user-grantable, so the per-user granted-plugins list does not apply to it. Tool availability follows the normal account and tool permissions, with two gates specific to this plugin: a Teams sender reaches the bot only through a matching role policy or a linked account, and the Microsoft 365 tools run only for a verified Elowen account that has a linked Microsoft identity.

The Web UI workspace and every API route it uses are administrator-only. This covers the app package download, the people list, per-person account status and linking, sign-out, and the directory avatars.

On enable, Elowen asks you to acknowledge the declared capabilities: the plugin reads stores and project files and mutates users. The users mutation is what account linking, provisioning and per-person account changes perform.

Microsoft-side permissions bound what the tools can do regardless of any Elowen setting. Normal bot chat uses only the Bot Connector and needs no Graph permission or admin consent. The Graph lookup path needs the application permissions named in its settings, with tenant-admin consent. The delegated Microsoft 365 tools can never exceed the delegated scopes consented on the OAuth connection, and because they act as the linked person they cannot reach data that person cannot reach.

For other plugins, requiring the `microsoftIdentity` control is satisfied while any enabled plugin publishes that key. This plugin registers the control only when account linking is configured and working, so a dependent surface stays unavailable until the delegated connection exists. Consumers get only the drive-scoped Graph client and can never widen their reach to mail, calendar or chats, and no token is handed to them.

## Known limits

- The plugin reports itself as unconfigured and does not connect until all three bot credentials are set. With account linking enabled but no connection name, the transport stays up for diagnostics while every mapped personal-chat message fails closed.
- Each delegated Graph call times out after 15 seconds, and a tool response is capped at 20,000 characters of output.
- One tool call transfers at most `m365MaxTransferBytes` bytes, 20 MiB by default and 250 MiB at most; larger uploads go through a resumable upload session.
- SharePoint content search returns at most 1,000 results.
- Deletion actions are disabled by policy in the SharePoint, files, Outlook and tasks tools. All mutations stay in preview until the agent commits the exact operation, and read-only access mode blocks them entirely.
- File offers work only in personal 1:1 chats, and a successful result means the offer was delivered, not that the recipient accepted the upload.
- A roster listing shows at most 50 members, a person search shows at most 25 matches, and a direct Bot Connector response is truncated after 4,000 characters.
- The bot's people directory covers only people it has seen in Teams traffic, mostly through conversation rosters; someone missing there may still exist in the tenant.

[Next: Code Tools](code-tools)