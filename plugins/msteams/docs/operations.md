# msteams — operations

Running the plugin in production: Azure setup, what each config field actually changes, failure modes and
what they look like in the log. The code walkthrough is in [architecture.md](architecture.md); the config
reference and file map are in [README.md](README.md).

All line references are against commit `701144dd`.

---

## 1. Azure app registration

The click-path is carried in the manifest itself, as the `sec_connection` section hint
(`elowen-plugin.json:26`), so the Settings UI shows it next to the fields:

1. **Entra admin center → App registrations → New registration**, single tenant. Copy the
   **Application (client) ID** → `appId`, and the **Directory (tenant) ID** → `tenantId`.
2. **Certificates & secrets → New client secret** → `appPassword`.
3. **Azure portal → Create an Azure Bot** bound to that app id. Set the **messaging endpoint** to
   `https://<your-domain>/hooks/msteams/messages` and enable the **Microsoft Teams** channel.

The plugin authenticates outbound calls as this app registration, against
`https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token` for the
`https://api.botframework.com/.default` scope (`lib/token.mjs:25`, `lib/connector.mjs:6`).

Inbound, it verifies Microsoft's JWT with the audience pinned to `appId` and the issuer pinned to
`https://api.botframework.com` (`lib/auth.mjs:11`, `:38-40`). The issuer being the connector service and
not your tenant is correct and deliberate — the tenant-scoped issuer applies to user tokens, never to
service-to-bot callbacks (`lib/auth.mjs:6-7`).

## 2. The Teams app package

The plugin builds the sideloadable package itself from the live config — there is no file to maintain.

- Served at `GET /plugins/msteams/app-package`, admin-only, as
  `elowen-teams-app.zip` (`index.mjs:24-37`).
- The route is registered **before** the credential check on purpose (`index.mjs:18-23`): while the plugin
  is enabled but unconfigured it answers **503**, not 404. Registering it after the gate would make an
  enabled-but-unconfigured instance look like a missing route.
- Contents (`lib/appPackage.mjs:139`): `manifest.json`, a 192 px solid Teams-purple `color.png` and a
  32 px white `outline.png`, in a hand-rolled stored (uncompressed) ZIP.
- The Teams manifest (`lib/appPackage.mjs:99`) uses schema v1.16, sets `id` and `botId` to your `appId`,
  scopes the bot to `personal`, `team` and `groupChat`, declares `supportsFiles: false`, `validDomains:
  []`, the permissions `identity` and `messageTeamMembers`, and fills the compose-box command list from
  the **first ten** entries of `helpCommands()` (`:126`) — the host's live chat commands plus a synthetic
  `display` entry the plugin appends itself (`lib/adapter.mjs:929-934`). The same list backs `/help`.

Upload it in **Teams admin center → Manage apps**. `tests/plugins/msteamsPlugin.test.ts:333` verifies the
ZIP framing, the manifest id/botId/scopes/icons and that both PNGs are really there.

## 3. The webhook route

`index.mjs:56` mounts `messages`, which the daemon serves at `/hooks/msteams/messages`. The bearer-auth
layer treats `/hooks/*` as public (`src/api/auth.ts:27`) — the plugin authenticates every request itself.

Your reverse proxy **must** forward `/hooks/` to the daemon port, before the catch-all `/` location. The
managed nginx vhost that `elowen setup` writes already does (`src/cli/install/proxy.ts:39-46`), and the
config health check reports `<vhost> does not route /hooks/` with a fix hint when it does not
(`src/api/routes/config.ts:387-388`).

Symptom of a missing proxy rule: the Azure Bot channel health check fails and **nothing at all appears in
the daemon log** — the request never reaches the plugin.

## 4. What the config fields do at runtime

The full table is in [README.md](README.md#config-fields). Operationally, the ones with consequences
beyond cosmetics:

- **`rolePolicies`** is the access boundary. First match wins, and a sender matching no policy is
  ignored in complete silence — no reply, no log line, no outbound traffic (`lib/adapter.mjs:396`). If
  "the bot ignores me" is the report, this is almost always the cause.
  - A `roleId` may be an Entra object ID (a GUID), a UPN/e-mail, or a **whole conversation id**, which
    grants everyone in that chat. Matching is case-insensitive whenever either side contains an `@`
    (`lib/ids.mjs:12`) — so UPNs, e-mails *and* conversation ids like `19:…@thread.tacv2` are all
    case-insensitive; only GUIDs and `29:` account ids must match exactly.
  - For a **team channel**, either the full `19:…@thread.tacv2;messageid=…` form or the bare
    `19:…@thread.tacv2` from a Teams deep link works (`lib/ids.mjs:26-31`).
  - `admin: true` marks the operator: it unlocks `/model`, `/reasoning`, `/display` and `/context`, lets
    that person act on a card opened by someone else, and drives `senderIsAdmin` (`lib/ids.mjs:36`). At
    `701144dd` it is also the **only** way anyone can answer an `AskUserQuestion` card — see the known
    discrepancy in [architecture.md](architecture.md#4-cards-askuserquestion-and-pickers).
- **`respondWithoutMention`** only affects non-personal conversations. A personal chat always answers
  (`lib/adapter.mjs:390-391`). A team-channel post is delivered to the bot by Teams only when
  @mentioned, so that case is gated regardless of this setting.
- **`historyLimit`** is the only field that makes the plugin persist **message text** to disk. `0` (the
  default) writes nothing at all. Lowering it takes effect on the next recorded message, which trims the
  stored list to the new limit rather than leaving a tail a later raise would resurrect
  (`lib/adapter.mjs:248-250`).
- **`language`** changes the bot's own service texts only (errors, command replies); the agent answers in
  the user's language regardless. Note the coverage is uneven: the service texts exist in all three
  languages (`lib/messages.mjs`), but **Adaptive Card button labels are switched by a single
  `language === 'cs'` boolean** (`lib/adapter.mjs:844`, `:943`, `:1001`, `:1020` → `lib/cards.mjs:46-49`,
  `:70-72`), so with `language: 'sk'` the buttons ("Submit", "✏️ Other", "‹ Prev", "Next ›") come out in
  English.
- **`toolActivity` / `answerMode` / `toolOutput` / `toolMessageMode`** are global defaults; each is
  overridable per chat with `/display`, and `/display <axis> default` removes the override
  (`lib/adapter.mjs:1005-1007`).

### Per-channel / per-role policy in practice

Access is per **sender**, not per channel — but a policy whose `roleId` is a conversation id grants the
whole room, which is how a channel-wide policy is expressed. The matched policy contributes the project
scope, the role prompt, and an optional per-role tool allowlist; the conversation's own state contributes
the model, reasoning level and fast flag (`plugins/_shared/access.mjs`, `buildRoleAccess`).

Note that `admin: true` in a role policy grants the **operator role inside the chat**; it does not grant
the owner's control-plane tools. The owner gate used by `TeamsSend`, `TeamsMessagePerson` and `TeamsApi`
is a different check — `ctx.currentIdentity()?.owner === true` (`lib/tools.mjs:20`).

## 5. The notify (cron) target

`notifyConversationId` is where a scheduled job's result lands when the job names no channel of its own.
A cron job may override it with `notifyChannelId` (`plugins/cronjob/index.mjs:835`).

Either value may be:

- a **conversation id** the bot has already seen, or
- a **person** — e-mail, Entra object ID, `29:…` account id or display name — whose 1:1 chat the plugin
  opens and then remembers (`lib/adapter.mjs:791-809`).

Every way a push can be dropped has its own warning:

| Log line (all `warn`) | Cause |
| --- | --- |
| `msteams notify: no target — set the plugin's notifyConversationId, or give the job a notifyChannelId …` (`lib/adapter.mjs:771`) | Neither the job nor the config named anywhere. |
| `msteams notify: no serviceUrl known yet — send the bot one message first` (`:775`) | The bot has never received an activity, so there is no service host to send through. |
| `msteams notify: "<x>" matches N people — name the person exactly or use their e-mail; the push was dropped` (`:795`) | An ambiguous display name. It is refused, never guessed. |
| `msteams notify: could not open a conversation with <x>` (`:805`) | Teams accepted the create call but returned no conversation id. |
| `msteams notify: could not reach <x>: …` (`:811`) | Resolving or opening the conversation threw (see §6). |

## 6. The optional Microsoft Graph layer

**Off by default.** With `graphLookup` unset or false, no `GraphClient` is constructed at all
(`lib/adapter.mjs:96`), so no Graph call is even possible — `tests/plugins/msteamsPlugin.test.ts:720`
asserts zero outbound requests on an unknown e-mail in that state.

Layer 1 (the people directory) needs **no Microsoft permission whatsoever**: it is assembled from inbound
activities and conversation rosters the bot already reads. Turn Graph on only when you need the bot to
write to people it has never met.

### What a Microsoft admin must grant

Both are **application** permissions on the bot's app registration, and both need tenant admin consent:

| Permission | Needed for |
| --- | --- |
| `User.ReadBasic.All` | Resolving an e-mail to a tenant user (`lib/graph.mjs:15`, `:60`). |
| `TeamsAppInstallation.ReadWriteSelfForUser.All` | Installing the Teams app for that user so a 1:1 chat can be opened (`lib/graph.mjs:16`, `:80`). |

Path: *Entra admin center → App registrations → the bot's app → API permissions → Add a permission →
Microsoft Graph → Application permissions → the permission → Grant admin consent for the tenant.* The
plugin quotes exactly this back at you when Graph answers 401/403, instead of forwarding a bare status
(`lib/graph.mjs:21-22`, `:44-46`). Pinned by `tests/plugins/msteamsPlugin.test.ts:770`.

Additionally, installing the app for a user requires **`graphCatalogAppId`** — the app's id in the org
Teams catalog (*Teams admin center → Manage apps → the uploaded Elowen app*), which is **not** the bot's
`appId`. Leave it empty only when the app is already deployed to users by Teams app policy; the plugin
then skips the install and opens the chat directly (`lib/adapter.mjs:711-714`).

Graph failure modes, all translated into an instruction rather than a status code:

An e-mail is resolved in two steps (`lib/graph.mjs:60-72`): a direct `GET /users/{address}` first, which
covers the common case where the e-mail *is* the UPN, then a `$filter` search on `mail` or
`userPrincipalName` for users whose mail differs. An install that answers **409** (the user already has
the app) counts as success (`lib/graph.mjs:88`).

| Situation | What the operator sees |
| --- | --- |
| 401/403 on any call | The permission name plus the full consent path (`lib/graph.mjs:45`). |
| No such address in the tenant | `Microsoft Graph found no user with the address "…" in this tenant.` (`lib/adapter.mjs:710`) |
| Address matches several users | Refused, with a suggestion to address the person by Entra object id (`lib/graph.mjs:71`). |
| `graphCatalogAppId` empty when an install is needed | An explicit instruction naming the Teams admin center column (`lib/graph.mjs:83`). |
| Catalog id not found (404) | The app must be uploaded and approved in the org catalog first (`lib/graph.mjs:90`). |

## 7. Common failures and what they look like in the log

| Log line | Level | Meaning / what to do |
| --- | --- | --- |
| `enabled but appId/appPassword/tenantId are not all configured — not connecting` (`index.mjs:43`) | warn | The plugin loaded but registered no platform, no webhook and no tools. Fill in all three. |
| `msteams platform registered (webhook /hooks/msteams/messages + chat tools)` (`index.mjs:59`) | info | Registration succeeded. |
| `msteams connected (app <appId>)` (`lib/adapter.mjs:123`) | info | The eager credential check obtained a token. |
| `msteams credential check failed: …` (`lib/adapter.mjs:125`) | warn | The token call failed at enable time — usually a wrong secret or tenant id. The adapter deliberately stays up; inbound JWT validation still guards the webhook, but every outbound call will fail. |
| `webhook token rejected: …` (`lib/auth.mjs:49`) | warn | An inbound activity failed JWT validation → 401. Wrong `appId`, a clock far out of the 300 s tolerance, an unreachable JWKS, or a spoofed/replayed `serviceUrl`. |
| `msteams turn failed in <conv>: <stack>` (`lib/adapter.mjs:459`) | error | The brain turn threw. The same message is also replied into the chat as `⚠️ …`. |
| `msteams turn failed: …` (`lib/adapter.mjs:145`) | error | The detached webhook work rejected outside the per-turn catch — a card action, or a failure before `onActivity` reached its own try/catch. |
| `msteams send: no stored route for conversation <id>` (`lib/adapter.mjs:569`) | warn | No `ref.serviceUrl` for that conversation and no `_meta.serviceUrl` either. The bot must receive one activity before it can send. |
| `msteams send failed: …` / `msteams edit failed: …` (`:578`, `:601`) | error / warn | A Connector call failed. The message body carries the HTTP status and the first 300 characters of Microsoft's response (`lib/connector.mjs:41`). |
| `msteams roster lookup failed for <id>: …` (`:509`) | warn | Membership could not be refreshed; the previous roster is reused, so mentions still resolve for up to 5 minutes. |
| `image download failed: …` (`:482`) | error | An inbound image exceeded `maxImageBytes` or the download failed; the turn continues with `[Attachment: image (download failed or too large)]`. |
| `image upload failed: …` (`:630`) | error | An outbound generated image could not be attached; the text still went out. |
| `msteams directory: could not persist <key>: …` (`lib/directory.mjs:86`) | warn | The people directory could not be written. Harmless in itself — it is re-learned from the next roster read. |
| `stateStore: failed to persist …` (`plugins/_shared/stateStore.mjs:27`) | error | The state file could not be written; this one is re-thrown, so the command that caused it fails visibly rather than confirming a change that never stuck. |

Two quiet failure modes with **no log line at all**, worth knowing about:

- An **unmapped sender** is dropped silently at `lib/adapter.mjs:396`. Check `rolePolicies`.
- In a group chat with `respondWithoutMention: false`, a message with no bot mention returns at `:391`.

Secrets never appear in any of this: the token layer echoes the *response* of a failed token call and
never the request that carried the secret (`lib/token.mjs:44-46`), and
`tests/plugins/msteamsPlugin.test.ts:859` asserts the app password is absent from tool output, the log,
the persisted state file and every outbound connector payload.

## 8. What a redeploy or config save does — and does not — change

Saving the plugin's config hot-reloads it (`src/api/routes/plugins/index.ts:322` → `brain.reloadPlugins()`),
which rebuilds the adapter. So a config save and a daemon restart have almost the same effect here.

**Changes / is rebuilt:**

- The adapter instance and its whole config snapshot — `index.mjs:51-55` spreads `ctx.config` once at
  registration, so a field change only takes effect through this reload.
- Whether the Graph layer exists at all (`graphLookup` is read once, `lib/adapter.mjs:96`).
- Every in-memory cache: the connector and Graph bearers, the JWKS handle, `upnCache`, `rosterCache`.
- **Open interactive cards stop working.** `pendingAsks` and `pendingPickers` are in-memory, so a button
  tapped after a reload finds no token and is ignored (`lib/adapter.mjs:863`, `:1016`). The card is left
  visibly un-settled. A parked question is separately cancelled by the reload itself
  (`src/brain/brainService.ts:1248`).

**Does not change:**

- `channel-state.json` and everything in it: conversation routes (`ref`), `/new` generations, per-chat
  model / reasoning / fast / display overrides, the transcript, and the whole `_people` directory. A
  restart loses no person and no opened 1:1 chat.
- Azure-side state: the app registration, the bot resource, the messaging endpoint, the uploaded Teams
  app package. Nothing in a redeploy touches those.
- The webhook URL. It is derived from the plugin name, not from config.

A redeploy that changes the plugin's data directory (a different database location, since the plugin data
root is derived from it — `src/daemon/brainCore.ts:255`) **would** orphan `channel-state.json`, and the
bot would then have no route to any conversation until it receives a message again.

## 9. The `agentName` caveat

`cfg.agentName` is read in three places — the transcript's label for the bot's own replies
(`lib/adapter.mjs:453`), the `/help` heading (`:955`) and the Teams app manifest name
(`lib/appPackage.mjs:100`) — each with a `'Elowen'` fallback.

It is **not** in `configSchema`, and `ctx.config` is exactly the stored slice
`plugins.config.msteams` (`src/store/configStore.ts:1171`) — nothing merges the instance brand
(`ctx.brand()`) into it. So unless an operator has an out-of-schema `agentName` key in that slice, all
three sites use the literal `Elowen`. The same pattern exists in the Discord and Telegram adapters
(`plugins/discord/lib/adapter.mjs:520`, `plugins/telegram/lib/adapter.mjs:477`), so it is a shared
convention rather than a Teams bug — but a renamed instance will still call itself "Elowen" in Teams.
