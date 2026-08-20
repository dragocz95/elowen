# msteams — maintainer documentation

> Written against commit `701144dd` (2026-08-13). Everything below was read out of the code at that
> commit; if a reference no longer resolves, treat this page as stale rather than authoritative.

Three files, no overlap:

- **README.md** (this file) — what the plugin is, what it needs, what it exposes, which file owns what.
- **[architecture.md](architecture.md)** — how a message actually travels through the code, and what is persisted.
- **[operations.md](operations.md)** — Azure/Teams setup, config semantics, failure modes, redeploy behaviour.

## What it is

A Microsoft Teams platform adapter built on the **Azure Bot Framework**. Inbound Bot Framework
activities arrive on the daemon webhook `/hooks/msteams/messages`; outbound replies, typing indicators,
card edits and images go out through the **Bot Connector REST API**. It registers itself as an Elowen
`PlatformAdapter` (`plugins/msteams/index.mjs:57`), so a Teams conversation becomes a brain channel
session the same way a Discord channel or a Telegram chat does.

On top of plain chat it provides: a live tool trace edited in place, `AskUserQuestion` rendered as
Adaptive Cards, slash commands with card pickers, per-chat model/reasoning/display overrides, image
round-trips, proactive (host-initiated) pushes, and a downloadable Teams app package.

Since commit `701144dd` it can also **write to a person first** rather than only reply: it builds a
people directory out of traffic it already sees, and `TeamsMessagePerson` opens the 1:1 chat itself.
See "Proactive messaging" below and the detail in [architecture.md](architecture.md).

## What it needs to run

### Credential gate

The plugin registers the app-package API route unconditionally, then requires all three of `appId`,
`appPassword` and `tenantId` before it does anything else (`plugins/msteams/index.mjs:39-45`). With any
of them missing it logs `enabled but appId/appPassword/tenantId are not all configured — not connecting`
and returns: **no platform, no webhook, no tools**. Pinned by
`tests/plugins/msteamsPlugin.test.ts:130` (no platform / no http routes without credentials) and
`:136` (both appear once configured).

### Azure / Teams prerequisites

Summarised here, with the click-path in [operations.md](operations.md):

1. An Entra **app registration** (single tenant) — its Application (client) ID is `appId`, the directory
   ID is `tenantId`, and a client secret is `appPassword`.
2. An **Azure Bot** resource bound to that app id, with the messaging endpoint set to
   `https://<your-domain>/hooks/msteams/messages` and the **Microsoft Teams channel** enabled.
3. The **Teams app package** (downloadable from this plugin — see below) uploaded to the org's Teams app
   catalog so users can install the bot.

Nothing beyond the bot credentials is required for normal chat: the member and roster lookups the plugin
uses for UPN/e-mail resolution are Bot Connector calls, not Graph calls
(`plugins/msteams/lib/connector.mjs:73` for one member, `:78` for the full roster). Microsoft Graph is a
separate, optional layer — see `graphLookup` below.

### Config fields

Declared in `plugins/msteams/elowen-plugin.json:25-53`; Czech and Slovak translations of every label and
hint live in `plugins/msteams/i18n/cs.json` and `sk.json`.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `appId` | string, required | — | Entra Application (client) ID; also the bot id. Used as the JWT audience (`lib/auth.mjs:38`) and to build the bot member id `28:<appId>` (`lib/adapter.mjs:198`, `:652`). |
| `appPassword` | secret, required | — | Client secret for the client-credentials token (`lib/token.mjs:36`). |
| `tenantId` | string, required | — | Tenant-scoped OAuth token endpoint (`lib/token.mjs:25`) and the tenant stamped on a newly opened 1:1 chat (`lib/adapter.mjs:655-656`). |
| `notifyConversationId` | string | empty | Default target for proactive pushes. A conversation id, or a person (e-mail / Entra object ID / display name) whose 1:1 chat the bot opens (`lib/adapter.mjs:764-786`). Empty = pushes are dropped with a warning. |
| `graphLookup` | boolean | `false` | Enables the optional Microsoft Graph layer. Off means **no `GraphClient` is constructed at all** (`lib/adapter.mjs:96`). |
| `graphCatalogAppId` | string | empty | The app's id in the org Teams catalog, needed to install the app for a user (`lib/graph.mjs:80-93`). Only visible when `graphLookup` is on. |
| `respondWithoutMention` | boolean | `true` | When `false`, a non-personal conversation is answered only if the bot is @mentioned (`lib/adapter.mjs:391`). |
| `toolActivity` | enum `off`/`status`/`live` | `status` | What the progress message shows while the agent works. |
| `answerMode` | enum `final`/`live` | `final` | One reply at the end, or the answer streamed into a message. |
| `toolOutput` | enum `hidden`/`summary`/`tail` | `summary` | How much of a finished tool's result the progress message keeps. |
| `toolMessageMode` | enum `single`/`per_tool` | `single` | One edited progress message, or one message per tool call. |
| `runtimeFooter` | boolean | `true` | Appends the `model · context %` line (`lib/format.mjs:27`). |
| `showReasoning` | boolean | `false` | Streams model reasoning into the progress message. Also forces a live stream to exist (`elowen-plugin-shared/display`, `observesLiveEvents`). |
| `language` | enum `en`/`cs`/`sk` | `en` | Language of the bot's **own** service texts (`lib/messages.mjs`). Not the agent's answer language. |
| `historyLimit` | number 0–100 | `0` | How many remembered messages seed a brand-new conversation. `0` means **nothing is written to disk** (`lib/adapter.mjs:236-240`). |
| `visionModel` | model | empty | Model used for turns carrying image attachments (`lib/adapter.mjs:430-432`). |
| `maxImageBytes` | number | `5242880` | Largest inbound image the bot downloads, clamped to 1 MiB–20 MiB (`lib/adapter.mjs:470`). |
| `maxImages` | number 1–10 | `4` | Inbound image attachments sent to the vision model. |
| `maxUploadImages` | number 1–10 | `4` | Generated images attached to one outgoing reply. |
| `askTimeoutMs` | number | `360000` | How long an `AskUserQuestion` card stays answerable, clamped to 30 s–30 min (`lib/adapter.mjs:838`). |
| `rolePolicies` | rolePolicies | — | Sender → allowed projects + role prompt + tool allowlist. First match wins; unmapped senders are ignored (`lib/adapter.mjs:338-343`). |

Three further keys are read by the code but are **not** in `configSchema`, so the settings UI never
offers them:

- `openIdMetadataUrl` (`lib/auth.mjs:16`) and `oauthTokenUrl` (`lib/connector.mjs:16`) — E2E seams used
  by `tests/e2e/msteams/`.
- `agentName` (`lib/adapter.mjs:453`, `:955`, `lib/appPackage.mjs:100`) — see the caveat in
  [operations.md](operations.md#the-agentname-caveat).

## Tools it exposes

Registered in `plugins/msteams/lib/tools.mjs:18` and declared in `elowen-plugin.json:11-20`. Two gates
exist: `adminGate()` requires `ctx.isAdminSession()` (`lib/tools.mjs:19`), `ownerGate()` requires
`ctx.currentIdentity()?.owner === true` (`lib/tools.mjs:20`).

| Tool | Gate | Plan-safe | What it does |
| --- | --- | --- | --- |
| `TeamsSend` | owner | no | Post into a conversation by id (`lib/tools.mjs:23`). |
| `TeamsMessagePerson` | owner | no | Message a **person** by e-mail / Entra object id / `29:…` id / display name; opens the 1:1 chat if needed (`lib/tools.mjs:42`). |
| `TeamsFindPerson` | admin | yes | Read-only directory lookup; sends nothing. Lists at most 25 matches (`lib/tools.mjs:71`, `:84`). |
| `TeamsChatInfo` | admin | yes | Conversation type, tenant, member count (`lib/tools.mjs:91`). |
| `TeamsMembers` | admin | yes | Fresh roster read, at most 50 listed; also feeds the people directory (`lib/tools.mjs:111`, `:121`). |
| `TeamsMemberInfo` | admin | yes | One member's name / Entra id / UPN (`lib/tools.mjs:127`). |
| `TeamsListConversations` | admin | yes | Conversations on the current service host, paged (`lib/tools.mjs:144`). |
| `TeamsApi` | owner | no | Raw Bot Connector REST: any method + path. Output truncated at 4000 characters (`lib/tools.mjs:165`, `:182`). |

`planSafe` is declared in `elowen-plugin.json:24` and covers exactly the five read-only tools — the
three that write (`TeamsSend`, `TeamsMessagePerson`, `TeamsApi`) are deliberately absent, so plan mode
withholds them. The manifest also sets `"icons": { "Teams*": "💼" }` (`:22`) and
`"showOutput": ["Teams*"]` (`:23`), which makes every tool's output visible in the transcript rather
than hidden by the default policy.

Access to these tools comes in two tiers, matching how the Discord plugin splits the same problem:

- **Curated tools** — `TeamsFindPerson`, `TeamsChatInfo`, `TeamsMembers`, `TeamsMemberInfo`,
  `TeamsListConversations`, `TeamsSend`, `TeamsMessagePerson`, `TeamsSendFile` — need an **admin role**
  (`ctx.isAdminSession()`). Sending a message is ordinary work for a trusted colleague; which of these a
  given role may actually call is then narrowed by that role's own tool allowlist.
- **`TeamsApi`** stays with the **instance operator** (`ctx.currentIdentity()?.owner === true`), because
  it drives the raw bot credentials and can reach anything they can. An `admin: true` role policy does
  not grant it — a role is handed out in plugin config, the operator is a single account, and deriving
  one from the other would silently widen what every role policy is worth.

Both refusals name the tier that was missed and who can grant it, rather than only saying no.

The gating is pinned by tests in `tests/plugins/msteamsPlugin.test.ts`: an admin role may send
(`TeamsMessagePerson` succeeds), the curated senders are refused without one and **nothing is sent**,
`TeamsApi` is refused for an admin-but-not-owner caller and accepted for the operator, and a send with
no recipient named refuses rather than guesses.

## Proactive messaging (since `701144dd`)

The Bot Connector cannot be addressed by e-mail — it only takes a `conversationId`. So the plugin builds
a **people directory** (`lib/directory.mjs`) out of what it already sees: every inbound activity and
every conversation roster carries a `29:` account id, an Entra `aadObjectId`, a display name and (from
the roster) a UPN/e-mail. No extra Microsoft permission is involved. Once a person is known, their 1:1
chat is opened once and remembered.

`graphLookup` is a **second, optional layer** (`lib/graph.mjs`), off by default. It exists only for
people the bot has never met: it resolves an e-mail against the tenant directory and installs the Teams
app for that user so a chat can be opened. It requires the **application** permissions
`User.ReadBasic.All` and `TeamsAppInstallation.ReadWriteSelfForUser.All` with tenant admin consent, plus
`graphCatalogAppId` for the install. What an admin must do, and what happens when they have not done it,
is in [operations.md](operations.md#the-optional-microsoft-graph-layer).

Test `tests/plugins/msteamsPlugin.test.ts:720` asserts that with the switch off **nothing leaves the
process** on an unknown e-mail — the stubbed global `fetch` records zero calls.

## File map

| File | What it owns |
| --- | --- |
| `index.mjs` | Registration: the app-package API route, the credential gate, the `StateStore`, the adapter, the `/hooks` mount and the tools. |
| `elowen-plugin.json` | Manifest: description, `provides`, `icons`, `showOutput`, `planSafe`, the whole `configSchema`. |
| `icon.svg` | The plugin's icon in the Elowen UI. |
| `i18n/cs.json`, `i18n/sk.json` | Czech/Slovak translations of the manifest description and every config label/hint/option. Enforced by `scripts/check-languages.mjs`. |
| `lib/adapter.mjs` | The adapter itself: webhook handling, gating, brain turn, outbound transport, mentions, cards, slash commands, proactive sends. The one large file. |
| `lib/connector.mjs` | Bot Connector REST client: reply/send/update/delete/typing/members/conversations/createConversation/download, with a single 429 retry. |
| `lib/token.mjs` | Entra client-credentials tokens, one cached bearer per scope, refreshed ~60 s before expiry. |
| `lib/auth.mjs` | Inbound JWT verification against Microsoft's JWKS, pinned to our `appId` and the connector issuer, with a `serviceUrl` cross-check. |
| `lib/directory.mjs` | The people directory: remember/list/evict/resolve, persisted under one reserved `StateStore` key. |
| `lib/graph.mjs` | The optional Microsoft Graph layer: e-mail → tenant user, and app installation for that user. |
| `lib/tools.mjs` | The eight `Teams*` tools and their admin/owner gates. |
| `lib/messages.mjs` | The bot's own service texts in `en`/`cs`/`sk`. |
| `lib/cards.mjs` | Adaptive Card builders: the ask card, the paged picker card, the settled one-liner. |
| `lib/stream.mjs` | Teams binding for the shared live-message engine: transport closures, markdown style, image strategy. |
| `lib/format.mjs` | Teams sizing and the runtime-footer markup (`CHUNK = 20000`). |
| `lib/ids.mjs` | Identity helpers: `matchesId`, `senderIds`, `senderIsAdmin`, `displayNameOf`. |
| `lib/appPackage.mjs` | The sideloadable Teams app package: hand-rolled stored ZIP + solid-colour PNG icons + the Teams manifest. |
| `lib/state.mjs` | One line: re-exports the shared `StateStore`. |

`index.mjs:12-15` also re-exports `matchesId`, `senderIds`, `senderIsAdmin`, `displayNameOf`,
`splitContent`, `footerLine`, `CHUNK`, `makeTokenVerifier` and `ConnectorClient` from the plugin entry.
That is the surface the unit tests import (`tests/plugins/msteamsPlugin.test.ts:148`, `:382`) — treat it
as load-bearing rather than incidental.

## Verify it works

**In the repo**, from the registry repository root:

```bash
npx vitest run tests/plugins/msteamsPlugin.test.ts   # 52 tests, the behavioural contract
npx vitest run tests/plugins/manifest.test.ts        # every bundled manifest parses
node scripts/check-languages.mjs                     # i18n covers every manifest string
npm run test:e2e:msteams                             # builds, then a real daemon + a fake Bot Framework
```

The E2E scenario (`tests/e2e/msteams/run.mjs`) drives a signed activity into the
real webhook, checks the async threaded reply and the in-place live-trace edits, and asserts that a
garbage JWT bounces with 401 without ever reaching the brain.

**On a running instance:**

1. The daemon log should carry
   `msteams platform registered (webhook /hooks/msteams/messages + chat tools)` (`index.mjs:59`) and
   then `msteams connected (app <appId>)` (`lib/adapter.mjs:123`). A `msteams credential check failed: …`
   instead means the token call failed but the adapter is still up.
2. `GET /plugins/msteams/app-package` (admin) returns the ZIP; it returns **503** while the plugin is
   enabled but not configured (`index.mjs:28`) — deliberately 503 rather than 404. Any non-empty
   sub-path under that mount is a **404** (`index.mjs:27`).
3. Send the bot a direct message from a mapped sender. You should see a typing indicator, then a reply
   threaded under your message.
4. `/help` in that chat answers with the command list (`lib/adapter.mjs:954`); `/status` reports the
   live model and context.
