# Plugin Development Guide

Elowen plugins are self-contained ESM folders. An enabled plugin contributes
tools, skills, prompt fragments, commands, turn context, hooks, controls, or
chat platforms through the shared registry. The manifest is declarative; the
module's `register(ctx)` call is the runtime contribution source.

The loader discovers `elowen-plugin.json` files, validates them, imports only
enabled plugins, stages each registration, and merges it only when registration
completes. A malformed or failing plugin is skipped without taking down its
siblings.

## Minimal plugin

Create a folder such as `plugins/my-plugin/` with this layout:

```
my-plugin/
├── elowen-plugin.json
├── index.mjs
├── icon.svg                 # optional settings icon
└── i18n/
    └── cs.json              # optional localized manifest strings
```

### Manifest (`elowen-plugin.json`)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "apiVersion": "1",
  "description": "Adds a small example tool.",
  "entry": "index.mjs",
  "provides": {
    "tools": ["MyTool"]
  },
  "icons": {
    "MyTool": "✨"
  },
  "configSchema": [
    {
      "key": "enabled",
      "label": "Enabled",
      "type": "boolean",
      "default": true,
      "hint": "Enable the example behavior."
    }
  ]
}
```

The filename is **`elowen-plugin.json`**, not `orca-plugin.json`. `name`,
`version`, `apiVersion`, `description`, and `entry` are required. The plugin
folder name must match `name`, and `entry` must remain inside that folder.
`apiVersion` is currently `"1"`.

`provides` can declare `tools`, `skills`, `hooks`, and `platforms`. When a
tool or platform list is present, the registry refuses contributions not named
there, so keep it synchronized with `register(ctx)`.

### Entry point (`index.mjs`)

```javascript
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const text = (value) => ({ content: [{ type: 'text', text: value }], details: {} });

export function register(ctx) {
  ctx.registerTool(defineTool({
    name: 'MyTool',
    label: 'Example tool',
    description: 'Returns the supplied text.',
    parameters: Type.Object({
      value: Type.String({ description: 'Text to return.' }),
    }),
    execute: async (_callId, params) => text(params.value),
  }));

  ctx.logger.info('example tool registered');
}
```

Use the PI `defineTool` and TypeBox `parameters` pattern used by bundled
plugins. Return a normal PI tool result rather than inventing a separate
transport format.

Name tools in **TitleCase** (`MyTool`, `ReadFile`), matching the bundled
plugins. Prefix a family that belongs to one service (`GithubListIssues`,
`GithubCreatePr`) so a manifest can give the whole family one icon with a
`Github*` pattern — icon and output-visibility patterns are matched
case-sensitively from the start of the name.

A tool name is not a private identifier: it is durable in a user's saved
permission rules and tool deny-list, and it is emitted on the event stream.
Renaming one silently voids the rules a user already saved for it, so pick the
name before the first release rather than after.

### Plan mode (`planSafe`)

Plan mode lets the agent work out an approach before it touches anything, so it
withholds every tool that is not declared plan-safe:

```json
"provides": { "tools": ["GithubListIssues", "GithubCloseIssue"] },
"planSafe": ["GithubListIssues"]
```

The bar is: **it must not change anything outside the conversation.** No writes
to the user's files or services, no messages sent, nothing deleted, no
sub-agents spawned. Reading, listing and reporting qualify; so does a tool that
only writes the agent's own scratch state, such as a todo checklist. Undeclared
is the safe default — the tool is simply not offered while the agent plans.

Two rules the registry enforces. `planSafe` takes **exact names only, never a
`prefix*`** — plan-safety does not run in families (`GithubListIssues` is safe,
`GithubCloseIssue` is not), and a pattern here is how you would hand Plan mode a
destructive tool by accident. And a name is ignored unless it also appears in
your `provides.tools`, so a manifest can only vouch for its own tools.

## Manifest fields

| Field | Meaning |
| --- | --- |
| `requires.env`, `requires.config` | Declared runtime prerequisites |
| `provides` | Tools, skills, hooks, platforms, and HTTP routes the plugin may register |
| `icons` | Per-tool display icons |
| `icon` | Optional relative SVG path; defaults to `icon.svg` when present |
| `showOutput` | Exact tool names or `prefix*` patterns whose successful output appears in chat |
| `planSafe` | Exact tool names Plan mode may offer — they change nothing outside the conversation |
| `configSchema` | Array of settings fields rendered in the plugin UI |
| `capabilities` | Explicit runtime permissions for hooks and shared reads |

Successful tool output is hidden by default to keep transcripts compact.
`showOutput` opts in selected tools; failures and host notes remain visible.

### Config fields

`configSchema` is an array, not generic JSON Schema. Each field has `key`,
`label`, and `type`; optional presentation/validation fields include `hint`,
`required`, `min`, `max`, `step`, `placeholder`, `default`, `options`,
`visibleWhen`, `advanced`, and `risk`.

Supported field types are `string`, `secret`, `boolean`, `number`,
`textarea`, `rolePolicies`, `model`, `provider`, `section`, `enum`,
`multiSelect`, `code`, `prompt`, `json`, `embeddingModel`, and `mcpServers`.
Plugin settings update `ctx.config` on reload. Keep the manifest English as the
fallback; add locale overrides under `i18n/<lang>.json` for translated
description, field labels/hints, and enum option labels.

## Plugin context

`register(ctx)` receives the following common capabilities:

| API | Use |
| --- | --- |
| `registerTool`, `registerSkill`, `registerPlatform` | Register declared runtime contributions |
| `registerHttpRoute` | Mount a declared inbound webhook under `/hooks/<plugin>/<path>` |
| `registerCommand` | Add a validated prompt-macro slash command to selected surfaces |
| `registerSystemPromptFragment` | Append stable plugin instructions to the system prompt |
| `registerTurnContext` | Add ephemeral per-turn context before or after the user message |
| `registerHook` | Observe a declared lifecycle point |
| `registerControl` | Expose a live plugin-specific runtime control |
| `dataDir()` | Get the plugin's writable, instance-local data directory |
| `assertPathAllowed`, `allowedRoots`, `defaultCwd` | Respect per-turn project filesystem scope |
| `currentIdentity`, `currentAccess`, `currentSessionId`, `currentWorkDir`, `currentModel` | Read the active turn scope |
| `isAdminSession()` | Gate shared administrative operations |
| `askUser`, `answerQuestion`, `emitCard` | Interactive questions and structured conversation cards |
| `notify` | Send a configured proactive platform notification |
| `listModels`, `resolveProvider` | Read the permitted shared model/provider configuration |
| `embeddings` | Use the shared memory embedder when permitted |
| `processes`, `subagentEmitter` | Integrate long-running commands and child progress |
| `config`, `logger` | Read this plugin's configuration and write scoped logs |

Turn-bound helpers may return `null`/`undefined` outside an interactive prompt.
Do not cache an identity, access policy, working directory, or model between
turns.

### File and data safety

Always guard a user-provided path before filesystem access:

```javascript
const path = ctx.assertPathAllowed(requestedPath);
```

Use `ctx.dataDir()` for plugin-owned state. Do not store plugin data in core
SQLite tables or infer another plugin's data directory.

### Turn context and commands

`registerTurnContext(() => text, { placement })` supplies ephemeral context for
the current turn. The default placement is `before-user`; use `after-user` for
a reminder that must sit directly after the request. This context is not a
durable system-prompt mutation.

`registerCommand({ name, description, prompt, surfaces? })` adds a reusable
prompt macro. Names must be unique kebab-case and cannot shadow a built-in
command. The prompt supports PI argument substitutions such as `$ARGUMENTS`,
`$1`, and `$@`.

### Inbound HTTP routes (webhooks)

A plugin that needs to RECEIVE HTTP callbacks (e.g. a chat platform that
delivers messages by webhook, like the `msteams` plugin in the registry) declares the
route path in the manifest and registers a handler:

```json
{ "provides": { "httpRoutes": ["messages"] } }
```

```javascript
ctx.registerHttpRoute({
  path: 'messages', // mounted at /hooks/<plugin-name>/messages
  handler: async (req) => {
    // req: { method, path, query, headers (lower-cased), body(): Promise<Buffer>, json() }
    const payload = await req.json();
    return { status: 200, body: { ok: true } }; // body: object | string | Uint8Array
  },
});
```

Routes mount under `/hooks/<plugin-name>/<path>` on the daemon. The path must
match the manifest declaration (deny-by-default, like platforms), use only
lowercase letters, digits, `-` and `/`, and requests are capped at 1 MiB. The
daemon's bearer auth is SKIPPED for `/hooks/*` — the handler must authenticate
the caller itself (the msteams plugin validates Microsoft's JWT signature).
When deploying behind nginx, proxy `/hooks/` to the daemon port (see
DEPLOYMENT.md).

## Daemon platform surfaces

Beyond tools and webhooks, a plugin can own whole daemon subsystems. These are
the surfaces the bundled `agents` plugin (the extracted tmux-agent + missions
subsystem) runs on; any plugin may use them.

### Authenticated API routes (`registerApiRoute`)

`registerHttpRoute` is for unauthenticated inbound webhooks under `/hooks/`.
`registerApiRoute` mounts routes on the daemon's AUTHENTICATED API instead:

```javascript
ctx.registerApiRoute({
  path: 'jobs',            // mounted at /plugins/<plugin-name>/api/jobs
  method: 'GET',
  access: 'user',          // 'user' | 'admin' | 'agent'
  handler: async (req) => ({ status: 200, body: { jobs: [] } }),
});
```

The daemon's bearer auth runs BEFORE the handler and the verified caller
identity arrives on the request; `access` narrows further (`admin` requires an
admin token; `agent` also admits agent-scoped task tokens — re-narrow inside
the handler when a sub-path needs less than the mount grants). Declare the
paths in the manifest's `provides.apiRoutes`.

An admin-installed plugin may additionally set `rootMount` to claim a
top-level path (e.g. the agents plugin keeps the pre-extraction `/missions`
and `/sessions` paths so existing clients never re-learn URLs). Core routes
always win: a root mount that collides with a core path logs a warning and is
skipped, literal segments beat `:param` patterns, and a plugin reload cleanly
unregisters the previous generation. A disabled plugin's root mounts answer
404.

### Services, intervals, and boot reconciles

```javascript
ctx.registerService({ name: 'poller', start: () => {…}, stop: () => {…} });
ctx.registerInterval('sweep', () => {…}, 60_000);
ctx.registerBootReconcile(() => {…});
```

Services start after boot reconcile on a full daemon start and stop on
shutdown or plugin reload (newest registered stops first — register a teardown
service FIRST so it runs LAST). Intervals are services with a fixed period.
Boot reconciles run once per boot and again on plugin reload; keep them
idempotent. A sub-agent runner loads enabled plugins for their tools but never
starts services, so build heavyweight runtime state lazily (on first use, not
in `register()`).

### Plugin database migrations (`ctx.db()`)

```javascript
ctx.db().migrate([{ version: 1, up: (db) => db.exec('CREATE TABLE IF NOT EXISTS …') }]);
```

`ctx.db()` requires the `reads: ["db"]` capability. Schema steps are bookkept
per plugin (`plugin_migrations`) and applied exactly once in the daemon; in a
read-only sub-agent runner `migrate()` is a logged no-op. Use `IF NOT EXISTS`
forms when adopting tables that predate the plugin (grandfathering), and never
rename or move existing rows on upgrade.

### Prompt templates (`registerPrompts`)

```javascript
ctx.registerPrompts({ dir: myPromptsDir, entries: ['worker', 'reviewer'] });
```

Registers markdown templates (`<name>.md` under `dir`) that the core prompt
renderer resolves by bare name and the account UI catalogs as editable. Gated
by `mutates: ["prompt"]`. Resolution order: a user's saved override wins, then
the plugin file, then a core file. Registering under the same bare names a
template had before an extraction keeps existing user overrides working.

### Controls (`registerControl`)

A control is a typed, live runtime surface other daemon code resolves from the
registry (e.g. `registry.control('missions')` hands the task routes the mission
engine). A key names the DOMAIN, never the plugin that happens to own it today —
that is what lets another plugin take the domain over without a caller changing.
Declare the shape in `KnownControls` (`src/plugins/api.ts`); the
registry narrows to function-valued members, so accessor methods are the
idiomatic shape — the first call can lazily build the runtime.

A control is also how ONE PLUGIN DEPENDS ON ANOTHER. With
`reads: ["controls"]`, a plugin resolves a sibling's control through
`ctx.control('<key>')`:

```javascript
const tasks = ctx.control('tasks');            // never keep this in a variable
if (!tasks) return c.json({ error: 'the tasks domain is unavailable' }, 503);
const task = tasks.store().get(id);
```

Three rules make that dependency safe:

- **Key the control by the DOMAIN, not by the plugin** (`tasks`, not the name
  of the plugin that happens to own it). Core and the consumer then ask for a
  capability, and the owner can be replaced or renamed without anyone knowing
  who implements it.
- **Resolve at call time, never inside `register()`.** Plugins load
  name-sorted, so a consumer usually registers before the owner exists;
  resolution walks the merged registry, which also means a plugin reload swaps
  the owner underneath you. A control kept in a variable is a dead generation.
- **Handle `undefined` honestly.** It means "the owner is switched off", which
  is a legitimate configuration — refuse the operation with a clear error, or
  report the subsystem as unavailable. Never substitute an empty result: after
  that, nobody can tell "nothing there" from "nobody answered".

### Browser UI bundles (manifest `web` block)

A plugin can ship pages, sidebar navigation, and a Settings section for the
web app as ONE built ESM bundle:

```json
"web": {
  "entry": "web/index.js",
  "requiresApiVersion": 1,
  "nav": [{ "label": "Sessions", "icon": "SquareTerminal", "route": "sessions" }],
  "settings": [{ "id": "agents", "label": "Agents & Autopilot", "icon": "Bot" }]
}
```

The daemon serves the bundle on an immutable content-hash URL and lists it via
`GET /plugins/ui`; the web app builds its menus from that listing (labels
localized per the `web` block in `i18n/<lang>.json`) and loads the bundle only
when a page is visited. Pages render under `/p/<plugin>/<route>` inside the
app shell; a disabled plugin's pages show an unavailable placeholder.

The bundle registers itself on load:

```javascript
window.__elowenRegisterPluginUi?.('my-plugin', {
  requiresApiVersion: 1,
  pages: { '': RootPage, 'sessions': SessionsPage },
  settings: { 'my-plugin': SettingsSection },
});
```

Everything the bundle needs comes from `window.ElowenUiRuntime`: the HOST's
React instance (never bundle your own — the build aliases `react` to it), a
curated `components`/`hooks`/`utils` surface, an authenticated same-origin
`api(path, init)` fetch, and SPA `navigate(href)`. Build with
`elowen-plugin-ui-kit` (`packages/plugin-ui-kit`): write sources under
`<plugin>/web-src/` and let `npm run build:plugins-web` emit
`<plugin>/web/index.js` (part of `npm run build`). The runtime contract's
types live in the kit's `index.d.ts`; narrow the untyped records locally in
the bundle instead of importing from `web/` sources.

That last point is a hard boundary, enforced by dependency-cruiser
(`plugin-bundle-not-to-web-app`): a bundle must not import from `web/` at all.
It is compiled separately, so an import that looks harmless ships a second copy
of the app — a second react-query client, a second component tree — inside a
file the daemon serves next to the real one. When a page needs something the
runtime does not expose, EXTEND the contract in `web/lib/pluginUi.tsx` and
narrow it in the bundle's own `runtime.tsx`; do not simplify the page. A bundle
that owns a domain (the `work` plugin owns tasks) still uses the host's data
hooks on purpose: one react-query cache and one SSE invalidation path for the
whole app, plugin pages included.

If the plugin owns a domain other core surfaces read, gate those surfaces on
its presence — `usePluginPresent('<name>')` in `web/lib/queries.ts`. Hide the
affordance; never let it report a zero it cannot compute (see
`web/tests/components/workGateDegradation.test.tsx`). Reads are the exception:
keep them enabled until the `/plugins/ui` listing actually says the owner is
gone, so a listing still in flight does not blank the page.

## Capabilities and hooks

Capabilities are deny-by-default. Declare only what the plugin needs:

```json
{
  "capabilities": {
    "hooks": ["tools.call.after"],
    "mutates": ["turnContext"],
    "reads": ["embeddings"],
    "network": true
  }
}
```

`reads: ["controls"]` permits `ctx.control(...)` — depending on a domain another
plugin owns (see Controls above). `reads: ["embeddings"]` permits
`ctx.embeddings` only when the operator has also configured the shared embedding
model. `reads: ["providers"]` permits provider resolution beyond IDs explicitly
present in the plugin's own config.
Hook patches are checked against the declaring plugin's `mutates` list; an
undeclared capability does not become active merely because code calls it.

Useful hook names include platform ingress, brain session/turn lifecycle, tool
registry/calls, memory I/O, and plugin reload. Consult
`src/plugins/api.ts` for the current typed union before adding a hook; only
runtime-wired patches should be relied on for behavior changes.

## Shared embeddings

Plugins reuse the one operator-configured memory embedder; they must not add a
second provider client for the same purpose:

```javascript
if (!ctx.embeddings.isConfigured()) return;
const descriptor = ctx.embeddings.descriptor();
const vector = await ctx.embeddings.embed('text to index');
```

Persist the descriptor with stored vectors so a model or dimensionality change
can trigger re-indexing. `embed` and `embedBatch` reject when the capability or
embedding configuration is absent.

## Building a platform adapter

A *platform* plugin bridges a chat transport (Discord, Telegram, WhatsApp, …) to
the brain: it receives inbound messages, forwards them as brain turns, and
streams the reply back in that transport's shape. Declare `platforms` in
`provides` and register with `ctx.registerPlatform(...)`. Each platform lives in
`plugins/<name>/` with its entry `index.mjs` and a `lib/` folder; the daemon
never talks to the transport directly, so an adapter is the whole integration.

### Reuse the shared core, don't re-implement it

The transport-neutral logic every adapter needs lives in `plugins/_shared/` —
reuse it so a fix or a new field lands once, not three times:

| Module | Exports | Use for |
| --- | --- | --- |
| `_shared/stateStore.mjs` | `StateStore` | Per-conversation JSON state (chosen model, reasoning/voice/display overrides, the `/new` generation counter), keyed by your transport's own conversation id. |
| `_shared/display.mjs` | `resolveDisplaySettings`, `updateDisplayOverrides` | The `/display` presentation policy (tool activity, answer mode, tool output, per-tool messages) resolved from global config + per-conversation overrides. |
| `_shared/format.mjs` | `splitContent(text, chunk)`, `extractImageRefs`, `imageRefName`, `stripThinking`, `parseModelExec`, `stripForSpeech` | Splitting a reply into fenced-code-safe chunks, pulling image links out of a reply (`extractImageRefs`) or validating an `image` event's `ref` (`imageRefName`), stripping leaked `<think>` reasoning, parsing a model exec, and flattening markdown for text-to-speech. Every helper guards a null/undefined body — an empty daemon reply must never crash a send. |
| `_shared/images.mjs` | `platformImageDirs(dataDir)`, `resolveImageFiles`, `imageMimeType` | Turning image names into upload-ready buffers: the directories an outgoing image may come from (the image plugins' data dirs plus the daemon's `chat-images` dir beside the database), reading them off disk, and the content type to declare. Hand it only names that passed `extractImageRefs` / `imageRefName` — they are joined onto a path. |
| `_shared/messages.mjs` | `SHARED_MESSAGES` | The service-message keys that are identical on every surface (`noModels`, `restarting`, `compacted`, …). Spread these into your `MESSAGES[lang]` and layer your surface-specific texts (channel-vs-chat wording, your emphasis markers, picker prompts) on top. |
| `_shared/help.mjs` | `HELP_DESCRIPTIONS`, `renderHelpLines` | The per-command `/help` wording, localized once. Give `renderHelpLines` the ordered command names your surface exposes, your `mono` inline-code wrapper and the container noun (`{place}`/`{placeLoc}`); it returns the command lines so a command can never be listed on one surface/language and dropped on another. |
| `_shared/chatCommands.mjs` | `CONTROL_COMMANDS`, `runControlCommand` | The transport-agnostic control commands — `new` / `fast` / `stop` / `status` / `compact` / `restart`. Route those names to the core with a small binding (reply, admin gate, state, ctl/ref, active-model lookup); keep only the pickers and `/help` in your own switch. |
| `_shared/liveTrace.mjs` | `makeTextHelpers`, `makeFoldedCalls`, `makeToolLinesFor`, `makeCardLines`, `makeOutputSummary`, `outputFailed`, `diffSummary`, `sanitizeControl` | The live-tool-trace render/fold rule: how a settled tool result is summarized, how consecutive calls fold into one counted row (mirroring the CLI transcript), and how a row/card becomes text. Build these from a per-surface `style` (mention/fence hardening, bold/strike, the output-line prefix). |

A plugin's own `lib/state.mjs` / `lib/display.mjs` are one-line re-exports of the
shared modules. Its `lib/format.mjs` re-exports the shared helpers and adds only
the genuinely per-surface pieces (see below); its `lib/messages.mjs` spreads
`SHARED_MESSAGES` and renders `/help` through `renderHelpLines`; its `lib/adapter.mjs`
delegates `CONTROL_COMMANDS` to `runControlCommand`; its `lib/stream.mjs` builds the
render helpers from a `style`.

### What stays per-platform

Keep in the plugin only what is truly transport-specific, and pass it into the
shared helpers rather than forking them:

- **Chunk size** — Discord splits at 1990 chars, Telegram/WhatsApp at 4000. The
  plugin owns its `CHUNK` and wraps the shared splitter:
  `export const splitContent = (text) => splitAtChunk(text, CHUNK);`
- **Footer + emphasis markup** — Discord uses `-# …` subtext, Telegram an em-dash
  line, WhatsApp `_…_` italics. Keep `footerLine` local.
- **Reply-quote shape** — the `buildReplyContext` signature differs per API
  (Discord takes the referenced-message object; Telegram/WhatsApp take name +
  body), so it stays local.
- **Transport-only helpers** — e.g. Discord's mention/role/name resolution.

### Steps to add a new platform

1. Scaffold `plugins/<name>/` with a manifest declaring `provides.platforms` and
   any config fields (token, allow-list, display defaults).
2. `lib/state.mjs` → `export { StateStore } from '../../_shared/stateStore.mjs';`
   and `lib/display.mjs` → re-export the two display helpers.
3. `lib/format.mjs` → re-export the shared format helpers, then add your `CHUNK`,
   the `splitContent` wrapper, `footerLine`, and `buildReplyContext`.
4. `lib/messages.mjs` → spread `SHARED_MESSAGES` into `MESSAGES.en`/`MESSAGES.cs`,
   add your surface-specific texts, and render `help` via `renderHelpLines` with
   the command names your surface exposes.
5. `lib/adapter.mjs` → in your command handler, delegate `CONTROL_COMMANDS` to
   `runControlCommand` first (passing the reply, admin gate, state, ctl/ref and
   active-model binding); keep only the pickers and `/help` in your own switch.
6. `lib/stream.mjs` → build the render helpers from a `style` object
   (`makeTextHelpers`, `makeFoldedCalls`, `makeToolLinesFor`, `makeCardLines`,
   `makeOutputSummary`); keep the throttled editable-message transport and the
   event→state reducer local, since those genuinely differ per transport.
7. In `index.mjs`, open the transport connection, map inbound messages to brain
   turns through `ctx`, and render the streamed reply using the shared helpers +
   your local footer/chunking.

## Loading and testing

Bundled plugins live under `plugins/<name>/` and are copied into the daemon
artifact during `npm run build`. Instance/plugin-marketplace discovery uses the
configured plugin directories; do not hard-code a private installation path.
Plugin reload stages contributions afresh, so a failed registration cannot leave
a partially registered tool set.

Add focused loader/registry/plugin tests alongside the behavior you change, then
run the relevant daemon checks from [Testing](TESTING.md). A new manifest or
entry must be present in the built `dist/plugins/` output after `npm run build`.
