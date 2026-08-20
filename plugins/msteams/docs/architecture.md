# msteams — architecture

How a message actually travels through this plugin, and what survives a restart. Setup and operational
concerns are in [operations.md](operations.md); the file map and config reference are in
[README.md](README.md).

All line references are against commit `701144dd`.

---

## 1. Inbound: webhook → activity handling

### 1.1 The mount

`index.mjs:56` registers a webhook handler under the relative path `messages`, which the daemon serves at
`/hooks/msteams/messages`. The bearer-auth layer treats `/hooks/*` as public (`src/api/auth.ts:27`), so
**the handler owns its own authentication** — that is the seam contract stated at
`src/plugins/api.ts:283-290`.

### 1.2 `handleWebhook` — `lib/adapter.mjs:133`

In order:

1. Non-`POST` → **405** (`:134`). Pinned by `tests/plugins/msteamsPlugin.test.ts:419`.
2. Unparseable body → **400** (`:136`).
3. `verifyToken(req.headers.authorization, activity)` fails → **401** (`:137`), and the brain is never
   reached (`tests/plugins/msteamsPlugin.test.ts:412`).
4. Adapter stopped, or no `listen()` handler wired → **200** with an empty body (`:138`). `stopped` is
   set by `disconnect()` (`:129`), which the host calls when it tears adapters down; `connect()` resets
   it and eagerly fetches a token so a typo'd secret surfaces at enable time rather than on the first
   message (`:119-127`).
5. `type === 'message'`:
   - if `activity.value` is an object → `onCardAction` (an Adaptive Card `Action.Submit` round-trip),
   - otherwise → `onActivity` (a user message).

   Either way the promise is **not awaited**: `void work.catch(…)` and an immediate **200** (`:142-146`).
   Microsoft's callback deadline is far shorter than an agent turn, so the reply is delivered later
   through the Connector, never as the HTTP response. `tests/plugins/msteamsPlugin.test.ts:405` pins the
   200 and, after a 20 ms wait, that the turn ran — it does not assert the ordering itself.
6. `type === 'conversationUpdate'` → `rememberConversation` only (`:148`). This is what an **app install**
   arrives as, and it carries the personal conversation id before the person has said anything
   (`lib/adapter.mjs:174-177`).
7. Anything else → **200**, ignored.

### 1.3 Token verification — `lib/auth.mjs:15`

`makeTokenVerifier` is built once per adapter (`lib/adapter.mjs:98`) and returns the `verify` closure
(`lib/auth.mjs:32`). It:

- lazily fetches the OpenID metadata document (default
  `https://login.botframework.com/v1/.well-known/openidconfiguration`, `lib/auth.mjs:10`) and builds a
  remote JWKS handle (`:25`);
- verifies with `audience = cfg.appId`, `issuer = https://api.botframework.com` (`:11`) and a 300 s clock
  tolerance (`:37-41`) — note the issuer is the **connector service**, not the tenant, even for a
  single-tenant bot (`:6-7`);
- cross-checks the token's `serviceUrl` claim against the activity's `serviceUrl`, trailing slashes
  stripped, and rejects a mismatch (`:44-46`);
- on failure logs `webhook token rejected: …` and returns a quiet `false`; a metadata/JWKS error clears
  the cached handle so a fetch hiccup is not cached forever (`:49-51`).

`tests/plugins/msteamsPlugin.test.ts:370` runs a real key pair against a local JWKS server and pins all
six outcomes: valid, missing header, non-JWT, wrong audience, wrong issuer, wrong `serviceUrl`.

---

## 2. `onActivity` — the user-message path (`lib/adapter.mjs:372`)

### 2.1 Route and directory bookkeeping (before any gate)

- `:375` drops an activity with no conversation, or one whose `from.id` equals `recipient.id` (our own
  echo).
- `rememberConversation` (`:158`) persists `{ serviceUrl, conversationType, tenantId, botId }` under the
  conversation id, and the bare `serviceUrl` under `_meta`, **only when they changed** — this runs on
  every message and every patch rewrites the state file. It then calls `notePerson` (`:178`), which
  records the sender in the people directory, attaching the conversation id **only for a `personal`
  chat** (`:188`) — a group id would address the whole room, not the person.
- `sweepStaleAsks` (`:286`) drops timed-out `AskUserQuestion` cards. It runs here, on *every* inbound
  message, not only on card actions — otherwise an ask nobody answers sits in `pendingAsks` for the life
  of the process. Pinned by `tests/plugins/msteamsPlugin.test.ts:634`.

### 2.2 Mention resolution — `resolveMentions` (`:314`)

Declared mention entities are rewritten in the text: **our own** mention disappears, everybody else's
`<at>Name</at>` becomes a readable `@Name`, so the model can see the message was aimed at a colleague.
Undeclared `<at>…</at>` spans get the same treatment by regex fallback (`:324-327`), matching the bot's
own name case-insensitively. `stripMention` (`:306`) is the blunt version used where no entity list
exists. Pinned by `tests/plugins/msteamsPlugin.test.ts:429`.

### 2.3 Transcript recording (`:382-386`)

`recordHistory` is called **above the gates**, so background chatter from an unmapped sender still
becomes context for a later session (`tests/plugins/msteamsPlugin.test.ts:536`). Bot-control commands are
excluded via the `CONTROL_ONLY` set (`:48` — the shared control commands plus `help`, `model`,
`reasoning`, `display`, `context`), because they are addressed to the plugin, not said to the
conversation (`tests/plugins/msteamsPlugin.test.ts:527`). A plugin **prompt macro** is deliberately not
in that set: it is a turn the conversation genuinely had.

`recordHistory` (`:236`) is a no-op while `historyLimit` is `0`, which is the default — this is the one
place the plugin persists message text, so it is strictly opt-in
(`tests/plugins/msteamsPlugin.test.ts:487`).

### 2.4 The gates

1. **Mention gate** (`:390-391`): a `personal` conversation always responds. Anything else responds only
   if `respondWithoutMention !== false` or `isForMe(m)` (`:295`, which matches a mention entity whose
   `mentioned.id` equals `recipient.id`). A team-channel post reaches the bot only when @mentioned
   anyway, so the same gate covers it.
2. **UPN resolution** (`:393` → `resolveUpn`, `:355`): one Bot Connector roster call per account id,
   cached in `upnCache`. A resolved UPN is fed into the people directory (`:364`) — this is the only way
   an e-mail becomes knowable without a Graph permission. A failure caches `undefined` and just narrows
   policy matching to the id/GUID forms.
3. **Identity** (`:394` → `senderIds`, `lib/ids.mjs:18`): the sender's `aadObjectId`, their `29:` channel
   account id, the resolved UPN, the conversation id, and — for a team channel — the **bare** channel id
   with the `;messageid=…` thread suffix stripped (`lib/ids.mjs:29-30`), because the bare form is what an
   operator copies out of a Teams deep link. Pinned by `tests/plugins/msteamsPlugin.test.ts:158`.
4. **Role policy** (`:395` → `accessFor`, `:338`): the **first** policy whose `roleId` matches any of
   those ids wins. `matchesId` (`lib/ids.mjs:8-14`) switches on whether **either** side contains an `@`:
   if so it compares lowercased, otherwise exactly. That covers UPN/e-mail as intended, but note it also
   makes a conversation id (`19:…@thread.tacv2`) case-insensitive; only GUIDs and `29:` ids compare
   strictly. No match → `access: undefined` → **the turn is dropped silently** — no reply and no log
   line. `tests/plugins/msteamsPlugin.test.ts:193` pins the absence of a reply specifically; it is not
   the absence of *all* traffic, because step 2 above already made a roster call before this gate. A
   match is turned into the access descriptor by the shared `buildRoleAccess`
   (`elowen-plugin-shared/access.mjs`), folded with this conversation's saved model / reasoning / fast state.

### 2.5 Commands (`:401-404`)

A leading `/` goes to `handleCommand` (`:937`) first. Shared control commands (`new`, `fast`, `stop`,
`status`, `compact`, `restart`) are delegated to `runControlCommand`; `help`, `model`, `reasoning`,
`display` and `context` are handled locally. `/model`, `/reasoning`, `/display` and `/context` are
admin-only; `/context` lists at most `CONTEXT_MAX = 40` sessions (`:36`, `:987`). `/help` renders
`helpCommands()` — the host's chat commands plus a synthetic `display` entry the plugin appends itself
(`:929-934`). An unrecognised command returns `false` and falls through.
If it names a plugin **prompt macro** (`isPromptCommand`, `:923`), the raw `/name args` text is sent to
the brain unchanged, bypassing the `[sender]` prefix, so PI expands the macro (`:404`, `:445`).

### 2.6 Media (`:406` → `collectMedia`, `:467`)

`text/html` and `text/plain` attachments are skipped (Teams duplicates the message body as one). Image
attachments are downloaded through the Connector with our bearer, capped by `maxImageBytes` and
`maxImages`, and base64-encoded. A failed or oversized download becomes a textual note rather than a
dropped turn (`:481`). Any other named attachment becomes `[Attachment: name (type)]`.

The size cap is enforced without buffering **on the streaming path** (`lib/connector.mjs:100-131`): a
declared `Content-Length` over the cap is rejected before a body byte is read, and the body is then
streamed with a running counter that aborts the instant the cap is crossed. There is one fallback branch
— no cap, or a response with no readable `body` — which does buffer through `arrayBuffer()` and checks
the size afterwards (`lib/connector.mjs:108-111`).

### 2.7 The brain turn (`:411-453`)

- Chat sessions are shared, so every message names its speaker: `[<display name>] <text>` (`:413`).
- The channel key is `${conversationId}#${gen}` (`:415-416`), where `gen` is bumped by `/new`.
- `resolveDisplaySettings` (`elowen-plugin-shared/display`) merges the plugin config with this conversation's
  `/display` overrides. If `observesLiveEvents` says a stream is needed, a `LiveMessage` is opened;
  otherwise `onEvent` handles **only** `ask`, so a parked question still renders its card instead of
  hanging until timeout (`:418-424`).
- A typing indicator is fired immediately and then every 8 s (`TYPING_INTERVAL_MS`, `:35`, `:426-427`).
- An image turn is steered to `visionModel` through `applyVisionModel` (`:430-432`).
- `this.handler(src, text, onEvent)` is the seam into the host. `src` carries `platform`, `userId`
  (Entra object id, falling back to the channel account id), `userName`, `roleIds`, `channelId`,
  `access`, `channelName` for non-personal chats, `images`, and `history`. **`history` must be async**:
  the brain calls `.catch()` on its result, so a plain string would break the first turn of every new
  conversation — pinned deliberately by `tests/plugins/msteamsPlugin.test.ts:498`.
- On success: `stream.finalize(replyText)`, or `postWithImages` when no stream exists (`:449-450`). The
  reply is recorded to the transcript from the model's own text, **before** the runtime footer is
  appended, so a model shown its own history never starts forging that line (`:451-453`).
- On failure (`:454-462`): the interval is cleared, the error is **logged and** replied. Both, on
  purpose — the caller only logs when the whole webhook promise rejects, which this catch prevents, so
  logging-only would leave an operator watching a healthy service while every turn died in the chat.
  Pinned by `tests/plugins/msteamsPlugin.test.ts:623`.

### 2.8 History backfill (`buildHistory`, `:267`)

Called lazily by the brain, and only for a session with no stored turns. It emits oldest-first
`[name] text` lines, cut at the activity being answered right now (`:272`, else the prompt would carry
the question twice), bounded by `historyLimit` and a 6000-character block cap. The block is wrapped in
explicit framing marking it as **untrusted data, never instructions** (`:280`) — a planted `SYSTEM:` line
in a conversation must not steer a privileged session. `tests/plugins/msteamsPlugin.test.ts:511` asserts
both sides appear, the current message does not, and the framing is present.

The Teams-specific reason this exists at all is documented at `:222-235`: the Bot Connector exposes no
endpoint that reads a conversation's past activities, so unlike Discord there is nothing to fetch on
demand. Real history would mean Graph `Chat.Read.All`.

---

## 3. Outbound: replies, edits, mentions

### 3.1 Transport

Everything outbound goes through `tmSend` / `tmEdit` / `tmDelete` (`:567`, `:591`, `:606`), which resolve
the route with `serviceUrlFor` (`:213`: the conversation's stored `ref.serviceUrl`, else the global
`_meta.serviceUrl`) and then call `ConnectorClient`:

| Adapter helper | Connector call | REST |
| --- | --- | --- |
| `tmSend` with `replyToId` | `reply` (`lib/connector.mjs:47`) | `POST /v3/conversations/{id}/activities/{replyToId}` |
| `tmSend` without | `send` (`:53`) | `POST /v3/conversations/{id}/activities` |
| `tmEdit` | `update` (`:59`) | `PUT /v3/conversations/{id}/activities/{activityId}` |
| `tmDelete` | `remove` (`:63`) | `DELETE …` |

`tmSend` with no known route logs `msteams send: no stored route for conversation …` and returns `null`
rather than throwing (`:569`). A failed send logs and returns `null` (`:577-580`); a failed edit logs and
returns `false` (`:600-603`).

Every connector call attaches a client-credentials bearer for the
`https://api.botframework.com/.default` scope (`lib/connector.mjs:6`, `lib/token.mjs:29`) and retries
**once** on a 429, waiting `Retry-After` capped at 15 s (`lib/connector.mjs:36-40`).

### 3.2 Mentions on the way out — `withMentions` (`:535`)

Teams only rings someone when the text carries an `<at>` span **and** the activity declares a matching
mention entity, so a mention cannot be produced by the model alone. `withMentions` assembles it against
the real roster:

- short-circuits when the body contains no `@` at all (`:537`);
- rewrites the explicit `<@…>` token (`MENTION_TOKEN`, `:54`) when the inner value matches any roster
  key — id, Entra id, UPN, e-mail, name, or given+surname (`memberKeys`, `:57`);
- then rewrites bare `@Display Name` occurrences, **longest name first** (`:553-557`), so a colleague
  called "Alex" cannot claim the "@Alex Rivera" in the text;
- a token matching nobody degrades to plain text — never a dead ping (`:551`);
- names are HTML-escaped into the span (`escapeSpan`, `:65`) and a literal `<at>` written by the model
  was already neutralised to `‹at›` upstream (`lib/stream.mjs:41`).

Pinned by `tests/plugins/msteamsPlugin.test.ts:443` (both shapes ring, a stranger stays text) and `:457`
(no entity is declared when the answer names nobody).

The roster used here is cached for 5 minutes (`ROSTER_TTL_MS`, `:50`; `roster`, `:497`), because mention
resolution runs on every outbound edit of a live answer while membership changes rarely. A failed lookup
keeps the previous roster rather than dropping every mention (`:501`, `:508-510`). Every roster read
feeds the people directory (`notePeople`, `:195`).

### 3.3 The live message

`lib/stream.mjs` is a thin Teams binding for the shared engine `elowen-plugin-shared/liveMessage.mjs`. It
supplies:

- the transport closures (`create`/`edit`/`remove`/`postImages`) that call the adapter's `tm*` helpers
  (`lib/stream.mjs:28-35`) — which is also the seam the plugin tests mock;
- a markdown style: bold tool names, struck-through failures, plain subtext (Teams has no small text for
  bot messages), and **`lineBreak: '\n\n'`** (`:51`) — Teams treats a single newline as a soft wrap, so
  without this the whole tool trace renders as one run-on paragraph. Pinned by
  `tests/plugins/msteamsPlugin.test.ts:556`;
- `postWithImages` (`:12`), which turns generated-image links into real attachments, strips the links,
  and sends the images ahead of the (possibly split) text.

Sizing lives in `lib/format.mjs`: `CHUNK = 20000` (`:7`) against Teams' ~28 KB payload cap, and the
runtime footer is a non-breaking-space paragraph followed by `*— model · context %*` (`:24-27`) — not a
blockquote, which Teams draws as a full-width bordered strip, and not `* ` which would read as a bullet.
Pinned character-for-character by `tests/plugins/msteamsPlugin.test.ts:467`.

Generated images travel by **name**: the reply text's image links are extracted by `postWithImages`, the
names are resolved against the image plugins' data dirs plus the daemon's `chat-images` dir
(`index.mjs:48` → `platformImageDirs`, `lib/adapter.mjs:613-615`, capped by `maxUploadImages`), and the
files are attached. They go out as inline data-URI attachments with **one** content type used for both
the attachment and the URI (`:618-631`) — declaring a `.gif` as png in one field and jpeg in the other
produced a picture Teams could not render. A failed upload logs `image upload failed: …` and is
swallowed (`:630`).

---

## 4. Cards: `AskUserQuestion` and pickers

An Adaptive Card `Action.Submit` comes back as a **`message` activity with a `value` object**, which is
why `handleWebhook` branches on `activity.value` (`:142`) and `onCardAction` (`:850`) dispatches on the
discriminator: `value.ea` = an ask, `value.ep` = a picker (`:856-857`). The compact payload shapes are
documented at `lib/cards.mjs:4-6`.

### Ask flow

1. `postAsk` (`:841`) posts `buildAskCard` under a monotonic token and stores
   `{ id, conversationId, activityId, questions, askerId, selected, createdAt }` in `pendingAsks`.
2. `onAskAction` (`:860`) drops unknown tokens, settles an expired one to a "question expired" card
   (`:864-868`), and otherwise admits the tapper only if `String(from.aadObjectId || from.id)` equals the
   stored `askerId`, or they match an `admin: true` policy — else it replies "this question is for
   someone else" (`:869-876`). Pinned by `tests/plugins/msteamsPlugin.test.ts:252` for the *refusal*.

   > **Known discrepancy (unfixed at `701144dd`).** Both production call sites store the asker as
   > `from.id`, the `29:` channel account id (`:424`, and `:419` via the shared engine's
   > `elowen-plugin-shared/liveMessage.mjs:363`), while the check above reads `aadObjectId` first. A real
   > Teams user always has an `aadObjectId`, so the two never agree and **the original asker is refused
   > their own card** unless they are also an admin. The pickers do it consistently — they store
   > `String(from.aadObjectId || from.id)` at `:964` and compare the same expression at `:1019` — and
   > so do the Discord (`plugins/discord/lib/adapter.mjs:709`, `:742`) and Telegram
   > (`plugins/telegram/lib/adapter.mjs:390`, `:426`) adapters. The test does not catch it because it
   > calls `postAsk` directly with an Entra id rather than going through a real activity.
3. A single single-select question submits **on tap** (`:890`); anything else toggles the ✅ marks and
   re-renders the card (`:892`), with an explicit Submit action and an optional `Other` free-text input
   (`lib/cards.mjs:46-50`).
4. `settleAsk` (`:904`) hands the answers to `ctx.answerQuestion`, deletes the pending entry, and edits
   the card down to a one-line summary — or to "expired" when the parked turn no longer accepted it
   (`:916`).

Card size is bounded by design: option labels are clamped to 60 characters, at most 12 options per
question are rendered, and pickers page 8 at a time (`lib/cards.mjs:10-11`, `:39`, `:57-73`).

### Picker flow

`/model`, `/reasoning`, `/display` and `/context` each post a `buildPickerCard` and store one pending
entry **per conversation** in `pendingPickers` (`:964`, `:977`, `:991`, `:1011`) — a second picker in the
same chat replaces the first. `onPickerAction` (`:1014`) ignores a mismatched kind, accepts only an admin
or the person who opened it (`:1019`), handles page turns by re-rendering (`:1022-1027`), and otherwise
writes the choice into the conversation state and settles the card.

Two behaviours worth knowing:

- Picking a model **re-reads the catalog on submit** and clears `fast` when the new model does not offer
  it (`:1036-1041`) — `fast` is a provider capability, not a portable preference. Pinned by
  `tests/plugins/msteamsPlugin.test.ts:599`.
- Every `/display` axis offers an explicit `default` value (`:1007`), which deletes the per-chat override
  rather than setting one; without it an override could never be taken back off from inside the chat.
  Pinned by `tests/plugins/msteamsPlugin.test.ts:584`.

---

## 5. The proactive / outbound-first path

### 5.1 Host `send` (`:634`)

The `PlatformAdapter.send(channelId, text)` seam strips the `#gen` suffix and posts the split text to the
stored ref. This is bound-session output, not a reply.

### 5.2 `notify` (`:764`) — cron/tick pushes

1. Target = the explicit `channelId` (suffix stripped) else `cfg.notifyConversationId`.
2. **No target** → a warning naming both `notifyConversationId` and the job's `notifyChannelId`, and the
   push is dropped (`:770-773`). Silence was the old behaviour and it dropped a result the scheduler had
   already paid a real turn for; `tests/plugins/msteamsPlugin.test.ts:613` pins the warning.
3. **No `serviceUrl` known yet** → warn and return (`:775`); proactive sends ride the last seen service
   host, so the bot must have received at least one activity. Pinned by
   `tests/plugins/msteamsPlugin.test.ts:327`.
4. If the target is not a known conversation, `notifyConversationFor` (`:791`) resolves it: an ambiguous
   directory hit is **dropped with a warning rather than guessed** (`:794-797`,
   `tests/plugins/msteamsPlugin.test.ts:797`); a unique person gets their 1:1 chat opened; an unseen
   e-mail goes to Graph **only if the switch is on** (`:800`); anything else is treated as a raw Teams
   user id and handed to Teams, which is what a `notifyChannelId` holding an Entra object id has always
   meant (`:801-809`).
5. The text is translated through `lifecycleText` **before** splitting (`:783`), because a translation has
   its own length.

### 5.3 `messagePerson` (`:745`) — the `TeamsMessagePerson` path

An empty message is refused up front (`:747`). Then `findPerson` (`:694`) → `conversationForPerson`
(`:668`) → send, and **nothing is sent** when either step fails:

- **Layer 1** is `PeopleDirectory.resolve` (`lib/directory.mjs:111`): `email`/`aadObjectId`/`userId`/
  `name` restrict matching to that field; a free-form `query` tries identifiers first and the display name
  last. An exact (case-insensitive) name wins outright; otherwise every substring hit is a candidate, and
  **more than one candidate is refused with the list**, never guessed (`lib/directory.mjs:130-136`,
  `lib/adapter.mjs:697-699`). Pinned by `tests/plugins/msteamsPlugin.test.ts:686`.
- **Layer 2** is Graph, consulted only for an e-mail and only when `graphLookup` is on (`:702`). It
  resolves the tenant user, installs the app when a catalog id is configured, and writes the person into
  the directory (`findPersonViaGraph`, `:708-717`).
- Neither → `unknownPersonHelp` (`:720`), which is a three-option instruction (have them message the bot,
  add the bot to a chat they are in and read it with `TeamsMembers`, or switch on Graph), not a bare
  error.
- `conversationForPerson` returns the remembered `conv` when there is one, else opens a 1:1 chat via
  `openPersonalConversation` (`:650`, `POST /v3/conversations` with `bot: { id: '28:<appId>' }`, the single
  member, `isGroup: false`, and the tenant on both `channelData.tenant.id` and the top-level `tenantId`
  — the connector's own form). Teams returns the
  **same** conversation for the same bot/user pair, so it is idempotent; the id is still remembered both
  in the directory and as a conversation `ref` (`:659-663`), so the second message costs no extra call.
  Pinned by `tests/plugins/msteamsPlugin.test.ts:695`.
- If every piece was accepted but no activity id came back, `messagePerson` throws rather than reporting
  success (`:754`).

---

## 6. Persisted state

### 6.1 The `StateStore`

`index.mjs:47` creates it at `<plugin data dir>/channel-state.json` — the per-plugin data dir the host
hands over via `ctx.dataDir()` (rooted at `plugins-data/`, `src/daemon/brainCore.ts:255`). `lib/state.mjs`
is a one-line re-export of the shared implementation (`elowen-plugin-shared/stateStore.mjs`): the whole file is
read once and cached in memory, and every `patch()` rewrites it through a temp file + atomic rename. A
write failure is logged **and re-thrown**, so a `/model` or `/display` handler cannot confirm a change
that never stuck.

### 6.2 Keys

**`<conversationId>`** — one entry per Teams conversation, written by `rememberConversation` and the
command handlers:

| Field | Written at | Meaning |
| --- | --- | --- |
| `ref` | `:168`, `:660` | `{ serviceUrl, conversationType, tenantId, botId }` — the route to reach this conversation later. |
| `gen` | `elowen-plugin-shared/chatCommands` (`/new`) | Conversation generation; folded into the channel key as `id#gen`. |
| `model` | `:1041` | `{ provider, model }` chosen with `/model`. |
| `thinkingLevel` | `:1047` | Reasoning effort chosen with `/reasoning`; `undefined` = model default. |
| `fast` | `/fast`, cleared at `:1041` | Fast mode; cleared when the newly picked model has no fast tier. |
| `display` | `:1059` | Per-chat `/display` overrides; an axis set to `default` is deleted from the object. |
| `log` | `:252` | The rolling transcript — `{ n: name, t: text, a: activityId }`, names clamped to 80 chars, lines to 400, list trimmed to the **current** `historyLimit` so lowering the setting takes effect at once. Only ever written while `historyLimit > 0`. |

**`_meta`** — `{ serviceUrl }`, the last service host seen on any activity (`:169`). This is the fallback
route for a conversation with no stored `ref`, and the base for `callApi` (`:830`).

**`_people`** — the people directory, under the reserved key `_people` (`lib/directory.mjs:14`; a
conversation id is always `a:…`/`19:…`, so it cannot collide). One record per person, keyed by lowercased
Entra object id, falling back to the lowercased channel account id — never a display name
(`lib/directory.mjs:25-27`):

```
{ aad, id, name, upn, conv, url, at }
```

`conv` is the person's 1:1 conversation id (only ever set from a `personal` conversation), `url` their
service host, `at` the last write. `remember()` merges over what was stored and **writes only when
something actually changed** (`lib/directory.mjs:79`), because it runs on every inbound message. The
directory is capped at 500 people with oldest-first eviction (`lib/directory.mjs:18`, `:92-101`), and a
persistence failure is warned and swallowed — it is an optimisation over what the next roster read can
re-learn, never a reason to fail a turn the user is waiting on (`lib/directory.mjs:83-87`). It stores
identity fields only; no message text.

### 6.3 Lifetime

The state file is durable: it survives daemon restarts, plugin reloads and redeploys. Nothing prunes
per-conversation entries — the only bounded structure is the people directory's 500-record cap. `/new`
bumps `gen` but does **not** clear `log`, which is intentional: the whole point of the transcript is to
seed the fresh session.

Everything else is **in-memory and lost on a plugin reload**, because a config save rebuilds the adapter
(`src/api/routes/plugins/index.ts:322` → `brain.reloadPlugins()`):

| Structure | Where | Lifetime |
| --- | --- | --- |
| `upnCache` | `:99` | Per account id, unbounded, no TTL. |
| `rosterCache` | `:100` | Per conversation, 5 min TTL, stale entries reused on a failed refresh. |
| `pendingAsks` | `:101` | Until answered, swept, or the process ends. |
| `pendingPickers` | `:102` | One per conversation; replaced by the next picker. |
| Connector bearer | `lib/token.mjs:18` | Refreshed ~60 s before expiry; concurrent callers share one in-flight refresh. |
| Graph bearer | `lib/graph.mjs:29` | A separate `TokenSource` — different audience, so one cached token cannot serve both. |
| JWKS handle | `lib/auth.mjs:17` | Cached until a metadata/JWKS error clears it. |

A restart therefore loses any card that was still open (its buttons stop responding — the token is
unknown, so `onAskAction` returns at `:863`) and re-warms the token and roster caches on demand, but
loses no conversation settings, no route and no person.
