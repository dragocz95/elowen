# Plugin Development Guide

Elowen plugins are trusted ESM packages loaded through the plugin registry. A plugin normally consists of an `elowen-plugin.json` manifest and a built entry module exporting `register(ctx)`. It can add tools, skills, commands, prompt context, hooks, API routes, webhooks, services, browser UI, platform adapters, or domain controls.

The manifest describes the plugin's contract. `register(ctx)` is the runtime source of its contributions.

## Plugin locations and loading

The daemon scans two plugin roots, in this order:

1. The bundled plugin directory shipped with Elowen (`dist/plugins/` in a built installation).
2. The instance data directory's `plugins/` folder, next to the database.

Bundled folders win when both roots contain the same plugin name. Only names in the enabled-plugin configuration are loaded. Folders are scanned and loaded in deterministic name order. Each plugin is registered into an isolated staging registry and merged only after `register(ctx)` completes; a malformed or failing plugin is skipped without leaving partial tools or routes behind.

The source checkout currently bundles `askuser`, `changelog`, `elowen-docs`, `files`, `mcp`, `runtime-context`, `sandbox`, `statusline`, `subagent`, `terminal`, and `web`. Optional integrations and extracted domain plugins are owned by the curated plugin registry at `https://github.com/dragocz95/elowen-plugins` and are installed from that registry. Marketplace installation is allowlisted by its `registry.json`; it does not accept arbitrary URLs or local folders. The daemon shallow-clones the registry, caches the last good checkout, and copies `plugins/<name>/` atomically into the instance plugin directory. An installed marketplace plugin is enabled separately and may require explicit capability acknowledgement. If an enabled plugin was moved out of the bundled package, boot reconciliation can restore it from the registry without changing the enabled set.

What each bundled plugin contributes:

- `askuser` registers `AskUserQuestion`, which is workspace-safe and plan-safe.
- `changelog` registers no tools. It serves the entries, seen-state, and asset API routes plus a web page, ships Elowen's release notes as Markdown so an update carries the new notes to every instance, and shows each account an unread count on its navigation entry until the page is opened.
- `elowen-docs` registers `DocsSearch`, semantic search over the product documentation.
- `files` registers the file tools `Read`, `Write`, `Edit`, `ListDir`, `Search`, `FileInfo`, `GitStatus`, `Glob`, and `Grep`; all are plan-safe except `Write` and `Edit`.
- `mcp` manages external MCP servers through `AddMcpServer`, `ListMcpServers`, `RemoveMcpServer`, `ReconnectMcpServer`, `ListMcpResources`, `ReadMcpResource`, and the dynamic `mcp__*` tool family, with the two resource tools deferred into `ToolSearch`.
- `runtime-context` registers no tools. It injects date, time, timezone, sender, and chat type into every turn, in the user message so the prompt cache is preserved.
- `sandbox` registers the Sandbox and Environment tool family and publishes the `sandbox` control; see "Managed projects and environments" below.
- `statusline` registers no tools. It renders context, token totals, speed, and cost below the conversation.
- `subagent` registers the delegation and workflow tools, from `Delegate` and its status and result helpers to `WorkflowStart` and the other workflow controls.
- `terminal` registers `Bash`, `ListProcesses`, `ProcessOutput`, and `KillProcess`, and is `userGrantable`.
- `web` registers `WebSearch` and `WebFetch`, both plan-safe, with a provider enum of `auto`, `tavily`, and `serper` and a list of preapproved documentation hosts returned as Markdown instead of model-summarized.

Four of them ship a browser bundle source tree, `subagent`, `sandbox`, `mcp`, and `changelog`; the other seven declare no `web` block at all.

A plugin reload replaces the whole registry generation. Do not retain a plugin control, configuration object, or other live registry value across reloads. Resolve live controls when they are used.

## Plugin layout

A minimal plugin can look like this:

```text
my-plugin/
├── elowen-plugin.json
├── index.mjs
├── icon.svg                  # optional
├── i18n/
│   └── cs.json               # optional manifest/UI translations
├── prompt/                   # optional platform prompt fragments
├── web-src/                  # optional browser UI sources
└── web/                      # built browser bundle and stylesheet
```

Bundled plugins are built as part of the main repository. An external plugin should import the stable host contract from `elowen/plugin-api`, not from `src/` or `web/`:

```ts
import type { PluginContext } from 'elowen/plugin-api';
```

Do not import arbitrary Elowen internals. Use the methods and host capabilities exposed by `PluginContext`.

## Manifest

The file must be named `elowen-plugin.json`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "apiVersion": "1",
  "requiresCore": "0.28.13",
  "description": "Adds a small example tool.",
  "entry": "index.mjs",
  "provides": {
    "tools": ["MyTool"],
    "apiRoutes": ["status"],
    "controls": ["my-domain"]
  },
  "requiresControls": ["shared-domain"],
  "workspaceSafe": true,
  "icons": {
    "MyTool": "🔧"
  },
  "planSafe": ["MyTool"],
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

Required fields are `name`, `version`, `apiVersion`, `description`, and `entry`.

- The directory name must equal `name`. `name` is the technical id: it keys the plugin's configuration, its control, the API mount, the data directory, and every stored grant, so renaming it is a migration, not an edit.
- `label` is the human title the plugin register and plugin detail show. Localize it through `i18n/<lang>.json`; when absent, the surfaces fall back to `name`. `userConfigLabel` does the same for the plugin's per-account settings section.
- `entry` is relative to the plugin directory and must stay inside it.
- `apiVersion` is currently `"1"` and must equal it exactly.
- `requiresCore` is an optional minimum Elowen version, such as `"0.28.36"`, for a host API the plugin needs. It is enforced at install time: the marketplace refuses the plugin with "needs Elowen X or newer" instead of letting it fail later inside `register(ctx)`.
- `requiresSharedApi` is an optional **exact** integer contract version for `elowen-plugin-shared`. Declare it when the plugin imports that package. The value must match the version shipped by the daemon, and the host compares it at install time and again before the entry module is imported.

### `provides`

Declare the public surfaces the plugin contributes:

```json
"provides": {
  "tools": ["MyTool"],
  "skills": ["my-skill"],
  "platforms": ["my-platform"],
  "destinations": ["my-platform"],
  "httpRoutes": ["callback"],
  "apiRoutes": ["status", "/legacy/items/:id"],
  "wsRoutes": ["stream", "session/:id"],
  "mcpTools": ["my_tool"],
  "controls": ["my-domain"]
}
```

`registerPlatform`, `registerHttpRoute`, `registerApiRoute`, `registerWebSocketRoute`, `registerNotificationDestinationProvider`, and `registerMcpTool` are deny-by-default: their names or paths must be declared in the corresponding manifest list. A published control key must be declared in `provides.controls`, so the daemon can answer from manifests alone which plugin satisfies which dependency; `requiresControls` names control contracts this plugin cannot operate without. Tools and skills should also be declared so the manifest remains an accurate audit surface.

There is no `provides.hooks` field. Hooks are registered with `registerHook`; their mutations are governed by `capabilities.mutates`.

### Tool metadata

- `icons`: per-tool display icons. Keys may be exact tool names.
- `showOutput`: exact names or `prefix*` patterns whose successful output should appear in chat. Successful output is otherwise hidden; failures remain visible.
- `planSafe`: exact tool names that may be used in plan mode. Patterns are not accepted, and a tool not listed is treated as mutating.
- `deferLoading`: exact names or `prefix*` patterns that should be deferred into `ToolSearch`. Patterns expand only to tools registered by the same plugin.
- `icon`: optional SVG path relative to the plugin directory. If omitted, `icon.svg` is used when present.

Tool names are durable data. They appear in events and saved permission rules and deny-lists. Choose a stable name before publishing; a rename requires a coordinated migration of stored tool names.

### Configuration schemas

`configSchema` describes instance-wide plugin settings. `userConfigSchema` describes per-account settings. Both use the same field format and are rendered by the plugin settings UI.

Supported field types are:

```text
string, secret, boolean, number, textarea, rolePolicies, model, provider,
section, enum, multiSelect, code, prompt, json, embeddingModel, mcpServers,
destination, projects, plugins, tools, models, timezone, tokenList
```

Common field properties include `key`, `label`, `type`, `hint`, `help`, `required`, `default`, `min`, `max`, `step`, `placeholder`, `options`, `language`, `risk`, `advanced`, `fullWidth`, and `visibleWhen`. A numeric field may declare `display.control` as `'input' | 'slider'`, with `display.unit` and `display.divisor` for the rendered value, and a `tokenList` field may declare `browse: 'directory'` to add a directory picker beside free-form values. `browse` is refused on any other field type and anywhere in `userConfigSchema`.

A field whose type this build cannot render is dropped from the form with a warning rather than failing the whole manifest, and the stored value is left untouched.

Keep English text in the manifest as the fallback. Add translations under `i18n/<lang>.json`; manifest fields use `description` and `fields`, while browser UI metadata uses `web`.

Use `userConfigSchema` for ordinary account settings such as a selected option or external identifier. Read the current account's values with `ctx.userConfig()`. It returns `null` when the turn is not acting as an account; never fall back to instance configuration in that case. The host renders eligible forms as personal sections in **Account**, routes them through `GET /plugins/user-config` and `PATCH /plugins/:name/user-config`, and never returns secret values.

Both instance and per-account config reads include a `revision`. Send it back as `expectedRevision` with the next `values` patch. Host schema forms normally send a full snapshot, but the HTTP object has patch semantics: omitted keys remain unchanged and `null` clears an optional non-secret field. A stale revision returns HTTP `409` with the canonical masked `current` snapshot; do not retry the old snapshot blindly. Instance config success returns `{ ok, config, secretsSet, revision }`, and may use HTTP `202` with `pending: true` after the durable commit when a live registry swap is deferred or fails. Per-account config is read live by `ctx.userConfig()` and does not reload the plugin registry.

A secret field is write-only. Omitted, empty, or `null` input means “keep the stored value”; it is not a deletion signal. Host schema forms exclude secret plaintext from debounced autosave and require an explicit commit for the first value or a replacement.

### Per-account access

Set `userGrantable: true` only when the plugin must be granted separately to each non-admin account. Such a plugin is deny-by-default for non-admins until an administrator grants it through the account's plugin access settings. The grant filters its routes, tools, skills, and browser UI.

A grant does not currently filter prompt fragments, slash commands, or hooks. Do not put account-sensitive behavior in those surfaces of a grantable plugin.

### Cross-plugin skills

Skills are merged into one live registry, and the host records the owning plugin for each contribution. A plugin that manages skills must use the live `skillCatalog` control when it needs to enumerate or resolve skills: `visibleSkills()` already applies the current account, plugin grants and per-account ownership, while `canonicalBaseDir(skill)` returns the host-approved base directory. Do not rescan only the plugin's own directory or maintain a second catalog. A skill registered with `ownerUserId` is visible and expandable only in that account's own sessions; an unowned skill is instance-wide.

### Capabilities

Capabilities are deny-by-default:

```json
"capabilities": {
  "reads": ["db", "stores", "git", "project-files"],
  "mutates": ["events"],
  "network": true
}
```

`mutates` values currently include `prompt`, `turnContext`, `tools`, `memory`, `events`, `workflow-dag`, and `users`. The host requires explicit, all-or-nothing acknowledgement when enabling or re-enabling a plugin that declares `tools`, `memory`, `events`, `workflow-dag`, or `users` mutation authority. A warning badge is not consent; turning a plugin off needs no acknowledgement.

`reads` gates host capabilities such as `db`, `controls`, `embeddings`, `providers`, `prompts`, `stores`, `git`, and `project-files`. Declare only the scopes the implementation needs. `network` records network intent; it is not a replacement for validating remote data. `workspaceSafe: true` is a positive declaration that every registered tool is safe inside an exact delegated workspace; omit it for mixed or unsafe plugins, or mark individual tools with `workspaceSafe: true`. Even a workspace-safe plugin cannot grant host-filesystem tools to an explicitly workspace-scoped child; the spawner withholds tools such as `WorkflowStart` whose definitions use the host workflow directory.

## Entry point and tools

The entry module exports `register(ctx)`:

```javascript
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const result = (text) => ({
  content: [{ type: 'text', text }],
  details: {},
});

export function register(ctx) {
  ctx.registerTool(defineTool({
    name: 'MyTool',
    label: 'Example tool',
    description: 'Returns the supplied text.',
    parameters: Type.Object({
      value: Type.String({ description: 'Text to return.' }),
    }),
    execute: async (_callId, params) => result(params.value),
  }));

  ctx.logger.info('example tool registered');
}
```

Use PI's `defineTool` and TypeBox parameter schemas. Return a normal PI tool result. Validate external input inside the handler and keep side effects explicit.

`registerTool` takes options alongside the tool: `ownerUserId` scopes the tool to one account, `hostFilesystem` marks a tool whose implementation can see the daemon host filesystem outside the path view (workspace-scoped children then omit it fail-closed), `workspaceSafe` declares it safe inside an exact delegated workspace, and `projectId` binds the tool's declaration to one managed Project. Omit the scoping options for an instance-wide contribution:

```javascript
ctx.registerTool(tool, { ownerUserId });
```

The active turn's `ctx.currentIdentity()`, `ctx.currentAccess()`, `ctx.currentModel()`, `ctx.currentWorkDir()`, and related accessors are evaluated from the current async context. Read them at execution time and do not cache them between turns.

## Plugin context

The main registration methods are:

| Method | Purpose |
| --- | --- |
| `registerTool` | Add a PI tool. |
| `registerSkill` | Add a markdown-backed skill; `ownerUserId` can scope it to one account. |
| `registerCommand` | Add a kebab-case prompt macro or picker such as `/review`. |
| `registerSystemPromptFragment` | Add stable plugin instructions to the system prompt. |
| `registerTurnContext` | Add ephemeral per-turn context without changing stored history. |
| `registerHook` | Observe a typed lifecycle point and, for supported hooks, return a gated patch. |
| `registerPlatform` | Register a chat transport adapter. |
| `registerHttpRoute` | Add a public webhook under `/hooks/<plugin>/...`. |
| `registerApiRoute` | Add an authenticated route under `/plugins/<plugin>/api/...`. |
| `registerWebSocketRoute` / `issueWebSocketTicket` | Add a ticket-authenticated WebSocket under `/ws/plugins/<plugin>/...`. |
| `registerService` / `registerInterval` | Register host-managed background work. |
| `registerControl` / `control` | Publish or resolve a live domain control. |
| `registerMcpTool` | Add a tool to Elowen's own authenticated `/mcp` server. |
| `registerPrompts` | Register editable markdown prompt templates. |
| `registerBootReconcile` | Reconcile durable plugin state on boot and reload. |
| `registerUserRemoved` | Delete account-owned rows, files, secrets, and schedules. |
| `registerProjectRemoved` | Clean up plugin state when a core Project is removed. |
| `publishEvent` / `subscribeEvents` | Publish and observe host events; both are gated by `mutates: ["events"]`. |
| `registerProjectIndicators` | Contribute plugin-owned status rows to the core Project register. |
| `registerReadinessCheck` | Report rows in the daemon's first-run readiness report. |
| `requestReload` | Ask the host to apply files written by the plugin after the current turn. |

Other context surfaces include `ctx.dataDir()`, `ctx.config`, `ctx.userConfig()`, `ctx.instanceSecrets()`, `ctx.userSecrets()`, `ctx.host`, `ctx.embeddings`, `ctx.images`, `ctx.chatArtifacts`, `ctx.processes`, `ctx.askUser()`, `ctx.emitCard()`, `ctx.notify()`, and the current-turn identity and access accessors. Every host capability is either scoped to the active turn or gated by the manifest.

### Filesystem access

Use the plugin data directory for plugin-owned instance state:

```javascript
const statePath = `${ctx.dataDir()}/state.json`;
```

For user or Project files, always guard the path immediately before access:

```javascript
const safePath = ctx.assertPathAllowed(requestedPath);
```

`assertPathAllowed` applies the current project and symlink policy. Do not reproduce path checks or infer another plugin's data directory. `ctx.defaultCwd()` is the safe default working directory for the current turn; `ctx.workDir()` reports whether the turn is actually bound to a Project.

A MANAGED project has no host filesystem, so `assertPathAllowed` refuses every path there and the file tools write into the guest instead. A plugin that reads back a file the model just created must branch on the execution target first and take the guest route:

```javascript
const text = ctx.currentAccess().projectRef?.kind === 'managed'
  ? await ctx.readManagedProjectFile(requestedPath)
  : readFileSync(ctx.assertPathAllowed(requestedPath), 'utf8');
```

Branch on the execution target, never on a refusal message, and never fall back from one route to the other. `readManagedProjectFile` resolves the project and account from the host turn scope, so the path is all the plugin supplies.

It hands back guest file content, so it carries the read half of the Sandbox control's authority and is gated the same way that control is: by the `reads:['controls']` grant AND by an allowlist of caller names in the registry. Declaring the capability does not open it — adding a plugin means editing that list, deliberately, in core.

When a tool result can only carry a bounded excerpt of what the tool produced, persist the whole output rather than discarding the rest:

```javascript
const spill = await ctx.persistToolOutput({ toolCallId, text: fullOutput });
const note = spill ? `full output saved to ${spill.path} (${spill.bytes} bytes), read it with the Read tool` : '';
```

`toolCallId` is the first argument PI passes to a tool's `execute`, and the host encodes it for the filesystem. The text lands in the host's existing tool-result spill directory for the current conversation, so the session reads it back through the ordinary path guard and it is removed when that conversation is cleared or deleted. Do not build a second store or a plugin-private directory for this. The call resolves `null` whenever no readable path can be produced: outside a prompt turn, inside a workspace-confined turn, and when a different file already occupies the name. It rejects, loudly rather than truncating, on a real write failure or on text above the maximum size, because the excerpt promises the complete output. Handle both outcomes instead of assuming a path.

### Secrets

Use encrypted secret bags for credentials:

- `ctx.instanceSecrets()` stores the plugin's instance namespace.
- `ctx.userSecrets()` stores the current account's namespace and returns `null` for accountless work.

Each bag supports `get`, `has`, `set(key, value, expectedVersion?)`, and `delete`. Use the returned version for compare-and-swap updates. Do not put new credentials in `ctx.config` or `ctx.userConfig()`.

`ctx.publicWebUrl()` returns the canonical URL from trusted installation metadata, or `null`. Do not construct OAuth callbacks from request `Host`, `Origin`, or forwarded headers.

### Outbound HTTP

`ctx.host.publicHttp()` is the host's outbound transport, and it is gated by `capabilities.network: true`. It returns an object with `validate(url)` and `request(url, opts)`. The host resolves and validates every destination, then pins the validated address into the socket lookup while preserving the URL host for HTTP and TLS. Route every fetch through it instead of opening sockets directly.

### Images

`ctx.images` renders images without the plugin ever holding a provider credential. Core owns both transports it may use: an API-key endpoint's OpenAI-compatible Images API, and the ChatGPT OAuth account's image backend, whose access token stays inside the daemon and is refreshed by the same runtime every model request uses. The plugin receives only the finished bytes plus the provider's usage.

```javascript
const { png, usage } = await ctx.images.generate({
  providerId,
  model,
  prompt: 'A small line icon of a lighthouse',
});
```

A request carries `providerId`, `model`, `prompt`, and optional `size`, `quality`, `background`, `n`, and `signal`. `edit(req)` adds `images` as `{ bytes, mime? }` sources, and the host owns the encoding, whether data URL or multipart, so a plugin never picks the transport. The result is `{ png, model, size, quality, format, usage }`, where `usage` carries input, output, and image tokens, or `null`. Gating works like provider resolution: the plugin may name only a provider wired into its own config, or any provider id once it declares `reads: ["providers"]`. A denial rejects rather than returning `null`, because an image call has no meaningful empty result and a silent no-op would look like a provider outage. The call also rejects in a process that wired no image host, such as a worker or a unit-test context. The seam first exists in core `0.28.36`, so an out-of-tree plugin that needs it declares `requiresCore: "0.28.36"`.

### Cards and artifacts

`ctx.emitCard(card)` pushes a structured card to the current conversation's clients, keyed by `card.id`. Re-emitting the same id replaces the card, and emitting an empty card removes it. Web and Discord render every card; the CLI shows only `pinned` cards, in its fixed panel above the status bar, so a non-pinned card never surfaces there. The call is a no-op outside an interactive prompt turn; cron and worker sessions wire no emitter.

`ctx.chatArtifacts` attaches artifacts beside the durable tool segment of the conversation rather than in an out-of-band panel. `open(toolCallId, artifact)` is valid only inside a prompt tool execution and throws otherwise; `update(ref, update)` and `close(ref)` take an opaque serializable ref that can be used later from an API route, a cleanup job, or boot reconciliation. Core stamps the plugin name, authorizes every ref mutation, and enforces expiry independently of plugin liveness. All three throw when the host seam is unwired.

## Authenticated routes and webhooks

### Public webhooks

A webhook is declared and registered like this:

```json
{
  "provides": { "httpRoutes": ["callback"] }
}
```

```javascript
ctx.registerHttpRoute({
  path: 'callback',
  handler: async (req) => {
    const payload = await req.json();
    return { status: 200, body: { ok: true } };
  },
});
```

It is served at `/hooks/<plugin>/callback`. Paths use lowercase letters, digits, `-`, and `/`; request bodies are capped at 1 MiB. Daemon bearer authentication is intentionally skipped for `/hooks/*`, so the handler must verify the provider's signature or token before accepting the request. `req.body()` provides the raw bytes needed for signature validation; `req.headers` are lower-cased.

### Authenticated plugin API

```json
{
  "provides": { "apiRoutes": ["status"] }
}
```

```javascript
ctx.registerApiRoute({
  path: 'status',
  method: 'GET',
  access: 'user',
  handler: async (req) => ({
    status: 200,
    body: { userId: req.auth.userId },
  }),
});
```

The route is served at `/plugins/<plugin>/api/status`. The daemon authenticates the request before the handler and supplies `req.auth` with the verified user, administrator flag, token scope, and accessible Project IDs. `access` is either `user` or `admin`; there is no `agent` access level.

A `rootMount` can preserve an existing top-level API path, but the full root path must be declared in `provides.apiRoutes` with its leading slash. Root mounts are still authenticated, core routes win conflicts, and `:param` segments are supported. Use the namespaced route unless compatibility with an existing client requires a root mount.

An API handler may return a buffered body, a byte stream, or an SSE callback through `response.sse`. Validate every route parameter and enforce the caller's Project ownership using `req.auth.accessibleProjects`; a `null` list is a list-scoping result for admin/open/setup contexts, not permission to access an arbitrary Project.

### Streaming a large response

Both HTTP surfaces accept a `ReadableStream<Uint8Array>` as `response.body`. The daemon pipes it to the client without buffering it, so a response may be far larger than the daemon's heap; a webhook route serving a published file is the reason the seam exists.

```javascript
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

ctx.registerHttpRoute({
  path: 'download',
  handler: async (req) => {
    const size = statSync(path).size;
    const headers = { 'content-type': 'video/mp4', 'content-length': String(size), 'accept-ranges': 'bytes' };
    if (req.method === 'HEAD') return { status: 200, headers, body: '' };
    return { status: 200, headers, body: Readable.toWeb(createReadStream(path)) };
  },
});
```

The plugin owns the metadata. `content-length` is passed through untouched, and a range answer is the plugin's own `206` with `content-range` over a stream opened at the requested offset. On a `HEAD` request the daemon cancels a stream body and replies with the headers alone, but a handler that can answer `HEAD` without opening the file should do so. A read failure after the headers were sent is logged by the daemon and destroys the response; it cannot become a status code any more. When the client disconnects, the stream is cancelled and its source closed.

A registry plugin runs on older daemons too, so check `req.acceptsStreamBody` before returning a stream: it is `true` on a daemon that has this seam and `undefined` on one that predates it, where a stream body would be JSON-serialized into `{}`.

### WebSocket routes

Use a WebSocket route for a bidirectional byte protocol that SSE cannot carry, such as a VNC/RFB stream. The route is served at `/ws/plugins/<plugin>/<path>` on the daemon port; the browser connects to that mount directly rather than through the web application.

```json
{
  "provides": { "apiRoutes": ["stream-ticket"], "wsRoutes": ["stream"] }
}
```

```javascript
// Mint a ticket from an authenticated API route.
ctx.registerApiRoute({
  path: 'stream-ticket',
  method: 'POST',
  access: 'user',
  handler: async (req) => ({
    body: ctx.issueWebSocketTicket({ userId: req.auth.userId, payload: { sessionId: 'vnc-1' } }),
  }),
});

ctx.registerWebSocketRoute({
  path: 'stream',
  access: 'user',
  handler: (conn) => {
    conn.onMessage((data, isBinary) => { if (isBinary) upstream.write(data); });
    conn.onClose(() => upstream.end());
    upstream.on('data', (chunk) => {
      if (conn.bufferedAmount() > 4 * 1024 * 1024) return; // the client is behind
      conn.send(chunk);
    });
    conn.signal.addEventListener('abort', () => upstream.destroy());
  },
});
```

Because the browser reaches this mount directly, it carries no Elowen bearer token and the daemon's authentication middleware cannot run on the upgrade. Authentication is therefore by ticket: the page fetches one from an authenticated API route and connects to `wss://<host>/ws/plugins/<plugin>/stream?ticket=<ticket>`. A ticket is single-use, expires after 30 seconds by default (five minutes at most), and is bound to the account named in `userId`; pass `req.auth.userId`, because nothing else re-checks who asked.

The daemon redeems the ticket before the handshake. An invalid, expired, foreign or already-used ticket is answered with HTTP 401 and no upgrade at all, and a route declared `access: 'admin'` refuses a ticket whose owner is not an administrator. An upgrade whose `Origin` header does not match the request `Host` is refused with 403; a request without an `Origin` header, which is what a non-browser client sends, is accepted.

Inside the handler, `conn.auth` is the resolved identity of the ticket owner, in the same shape as `req.auth` on an API route, and `conn.payload` is whatever the plugin stored when it issued the ticket. A `Uint8Array` passed to `conn.send` is transmitted as one binary frame unchanged, and `conn.bufferedAmount()` reports the bytes still queued on the socket, which is the signal to stop producing frames for a client that cannot keep up. `conn.signal` aborts when the socket closes, when the plugin is reloaded or disabled, and on daemon shutdown; a reload closes every live connection with code 1001. A handler that throws closes its connection with 1011 and is logged under the plugin's name.

Feature-detect the surface with `typeof ctx.registerWebSocketRoute === 'function'` when the plugin must also load on an older daemon.

## Persistence and lifecycle

### Plugin database tables

`ctx.db()` provides the main SQLite database only when the manifest declares `reads: ["db"]`:

```javascript
const db = ctx.db();

db.migrate([
  {
    version: 1,
    up: (database) => database.exec(`
      CREATE TABLE IF NOT EXISTS p_my_plugin_items (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      )
    `),
  },
]);
```

Plugin migrations are bookkept per plugin and run once. Name plugin tables with a `p_<plugin>_` prefix. Use `db.transaction(() => { ... })` when several statements must succeed atomically. In a read-only sub-agent runner, `migrate()` is a logged no-op.

Prefer a plugin-owned table or `ctx.dataDir()` over adding plugin-specific columns to core tables. Core migrations belong in `src/store/db.ts` and `src/store/schema.sql`; plugin-owned schema belongs in the plugin.

### Cleanup callbacks

Any plugin that stores account-owned state must register cleanup:

```javascript
ctx.registerUserRemoved(async (userId) => {
  // Delete this account's rows, files, and other durable state.
});

ctx.registerProjectRemoved(async (projectId) => {
  // Remove or mark this plugin's Project-owned state.
});
```

The account row still exists when `registerUserRemoved` runs. A disabled plugin cannot receive a live callback, so cleanup must also be covered by an idempotent `registerBootReconcile` when necessary.

### Services and reconciliation

```javascript
ctx.registerService({
  name: 'poller',
  start: async () => {},
  stop: async () => {},
});

ctx.registerInterval('sweep', () => sweep(), 60_000);
ctx.registerBootReconcile(() => reconcile());
```

Services start after boot reconciliation on a full daemon start and stop around plugin reloads. `stop()` must return promptly. Intervals are unref'd host timers and are cleared on stop/reload. Reconciliation runs on boot and reload and must be idempotent. A sub-agent runner loads plugin tools but does not start plugin services, so initialize heavyweight runtime state lazily.

## Prompt context, commands, and hooks

### Ephemeral turn context

```javascript
ctx.registerTurnContext(
  () => `Live status: ${readStatus()}`,
  { placement: 'after-user' },
);
```

The default placement is `before-user`; `after-user` puts the context directly after the user's request. Turn context is ephemeral and is not persisted into conversation history or the stable system prompt.

### Prompt macros

```javascript
ctx.registerCommand({
  name: 'summarize-files',
  description: 'Summarize the files in the current Project.',
  prompt: 'Summarize the files requested by the user.\n$ARGUMENTS',
  surfaces: ['cli', 'web'],
});
```

Command names must be 1–32 characters of lowercase letters, digits, and dashes. They must not shadow a built-in or reserved command and must be unique across plugins. A command declares `kind: 'prompt'` (the default) or `kind: 'picker'`. A picker carries no prompt and gets no model turn: the surface draws its own chooser from the picker's items. A plugin picker is clamped to the CLI and web surfaces, because a plugin can ship neither a TUI overlay nor a web dock modal; declaring a platform surface for one is dropped with a warning. There is no manifest field for slash commands: commands are contributed only at runtime through `ctx.registerCommand`, so disabling the plugin removes them from every menu through the same registry gate. Supported substitutions include `$ARGUMENTS`, `$@`, `$1`–`$9`, `${N:-default}`, and `${@:N}`. Plugin prompt commands are macros the agent runtime expands, not new control-plane endpoints.

Adapters should obtain their complete command metadata with `ctx.chatCommands(surface)`. Do not maintain a second hard-coded command list. The returned `kind` field says how a surface renders the command (`action`, `info`, `picker`, `mode`, or `prompt`), and the `execution` field says which mechanism runs it (`session-control`, `surface-local`, `adapter-state`, or `plugin-prompt`). The host's own catalog lives in `src/brain/slashCommands.ts` and is the single source of truth for every surface, in display order.

### Editable prompt templates

`registerPrompts` requires `mutates: ["prompt"]` and takes structured entries:

```javascript
ctx.registerPrompts({
  dir: new URL('./prompts', import.meta.url).pathname,
  entries: [
    {
      name: 'review',
      group: 'Development',
      vars: ['$FILES'],
      jsonContract: false,
    },
  ],
});
```

The file is `<dir>/<name>.md`. Names are bare, lowercase template names; a user's saved override wins over the plugin file. Use stable bare names when moving a template between core and a plugin so existing overrides continue to resolve.

### Hooks

Register a hook with a name from the typed union in `src/plugins/api.ts`. Current hook families cover platform ingress, brain session/turn lifecycle, tool registry and calls, memory I/O, and plugin reloads.

Two hook mutations are runtime-wired. A hook handler may return `{ patch?, annotations?, audit? }`, and the patch carries `appendContext` and `denyToolCall`:

- `appendContext` from a turn-context hook, gated by `mutates: ["turnContext"]`.
- `denyToolCall` from `tools.call.before`, gated by `mutates: ["tools"]`.

A hook may also be a pure observer. Hook failures do not grant permission or block a call; implement critical enforcement in the tool or route's own authorization path.

Host events are a separate seam from hooks. `publishEvent`, `deleteEventsForTarget`, `registerEventRowResolver`, and `subscribeEvents` are all gated by `mutates: ["events"]`. `subscribeEvents` returns an unsubscribe function, and the host detaches the old registry's subscriptions when the plugin reloads.

### Observing a file mutation

`tools.call.after` is the only channel through which one plugin learns that another wrote a file; the `files` plugin broadcasts nothing of its own. A subscriber sees `{ tool, params, result }` after a permitted execute resolves:

- Act on `tool === 'Edit'` or `tool === 'Write'`, and only when `result.details.ok === true`. A failed or guard-refused Edit resolves with an error result instead of throwing, so the event fires for it too and `ok` is the only thing separating a real write from nothing having happened. A call the permission gate denied never reaches the hook at all.
- Resolve the path with `ctx.assertPathAllowed(params.file_path)`. The hook runs inside the tool's turn scope, so a workspace-relative path resolves exactly as it did for the tool. `result.details.path` is a display path, not a filesystem path.
- Do not assume the bytes on disk are final. Subscribers for one hook name run concurrently, and one of them may still rewrite the file; a formatter does exactly that. Prefer invalidating what you cached over capturing content here.
- Do no slow work. The tool result waits for this hook, so notify or invalidate and return; anything that has to run long belongs behind a subsequent tool call.

`tests/plugins/filesMutationObserver.test.ts` pins this payload contract.

## Controls and plugin dependencies

A control is a live domain interface, not a plugin-name lookup. Use a domain key and declare published keys in `provides.controls`. Declare the control shape in `KnownControls` when core needs to call it; plugin-only controls may remain behind the generic `PluginControl` shape:

```json
{
  "provides": { "controls": ["my-domain"] },
  "requiresControls": ["shared-domain"]
}
```

```javascript
ctx.registerControl('my-domain', {
  status: () => ({ ready: true }),
});
```

A plugin that consumes another plugin's control declares `reads: ["controls"]` and resolves it at call time:

```javascript
const sandbox = ctx.control('sandbox');
if (!sandbox) {
  throw new Error('Sandbox is unavailable');
}

const roots = sandbox.workspaceRoots({ projectIds: [projectId] });
```

Never cache the result across calls: a plugin reload replaces the live generation. Treat `undefined` as a legitimate disabled or unavailable dependency. Do not return fabricated empty domain state.

The registry also restricts the credential and process-launch controls to named consumers: `github` is available only to `sandbox`, `publishedSitesGateway` only to `sites`, and `sandbox` only to `files`, `terminal`, `github`, `onedrive`, `sites`, `editor`, `lsp`, `mcp`, `browser`, `cronjob`, and `codebase`. A consumer outside that list resolving `sandbox` receives a facade whose site-environment methods throw. The control keys shipped today are `subagent`, `terminal`, `cron`, `workflow`, `mcp`, `lsp`, `sandbox`, `microsoftIdentity`, `github`, `publishedSitesGateway`, and `skillCatalog`.

Use domain keys such as `sandbox`, `mcp`, or `workflow`, not the current plugin name. `registerControl(name, control, { requires })` can make one control unavailable until another domain control resolves, and two plugins publishing the same key is caught when registries merge.

## Managed projects and environments

A Project's execution target is declared in the shared wire contract, never inferred from a filesystem path. The Project DTO carries an `executionKind` of `host` or `managed`, and a managed target always names its stable registry identity.

A managed Project runs in its own rootless Podman container that survives across turns. Three volumes are mounted read-write: the project itself under its own name (`/kolin` for a project with the slug `kolin`, which is also the working directory), a home directory, and a data volume at `/data`. Elowen's own guest artifacts (plan mirrors, tool-result spills) live under `/data/.elowen`, off the project tree. Each execution runs inside the container as a transient systemd unit. Networking is either shared with the host with loopback denied, or none. Default limits are 1 CPU, 1024 MB of memory, and 512 pids. Container specs are frozen and host-derived; a caller-authored mount list is not an execution capability.

Plugins reach this machinery through the `sandbox` control, subject to the consumer allowlist described above. The control's workspace half exposes workspace roots and listings, the active workspace for a conversation and Project, workspace resolution that refuses stale, orphaned, foreign, path-mismatched, or inaccessible workspaces, delegation lease acquisition, and `prepareExecution`. `prepareExecution` takes a closed set of lease kinds (`terminal`, `github`, `sites`, `files`, `editor`, `lsp`, `mcp`, `browser`, `cron`) and offers no way to ask for unconfined execution: an explicit request always runs under bubblewrap. Its result carries a mode of `confined`, `direct`, or `managed`, a host working directory beside the logical display directory a workspace-scoped model sees, the home, the roots, the launch shape, bounded stdin, completion metadata, cancel, the workspace, the lease, and an output sanitizer.

The control's environment half exposes environment lookup and provisioning requests, environment operations, guest project files, access revocation, snapshots, logs, managed worktrees, and preview bindings. Environment state is one of `unprovisioned`, `starting`, `running`, `stopped`, `failed`, `deleting`, or `deleted`, and desired state is one of `running`, `stopped`, or `deleted`. Actions are start, stop, restart, delete, snapshot, restore, and limits. Guest file operations are a closed union that includes chunked writes, and an upload handle is bound to the original account, Project, generation, target, and version.

An execution lease is durable and persisted in shared SQLite, so the daemon and forked runners observe the same blockers. The caller owns the process lifecycle: heartbeat while alive, transfer the handle when foreground work detaches, and release only on spawn failure or a real exit. Releasing a conversation's workspace bindings is refused with HTTP 409 while a lease is held, and a managed lease cancels and verifies guest processes, not merely the outer container client. The optional `SandboxControl` methods `activeSessionWorkspace` and `releaseSessionWorkspaces` do not exist on an older Sandbox build, so feature-detect them and degrade.

## Browser UI

A plugin browser bundle is declared in the manifest:

```json
"web": {
  "entry": "web/index.js",
  "css": "web/index.css",
  "requiresApiVersion": 16,
  "label": "My plugin",
  "account": [
    { "id": "connection", "label": "Connection", "icon": "Settings" }
  ],
  "project": [
    { "id": "overview", "label": "Overview", "icon": "Folder" }
  ],
  "settings": [
    { "id": "settings", "label": "Settings", "icon": "Settings" }
  ]
}
```

The `web` block may also declare `nav`, `user`, `strings`, `adminOnly`, `navKind`, and `layout`. `navKind` is `'domain' | 'infrastructure'`, defaulting to `domain`: a domain world has its own objects and workflow, while `infrastructure` configures a capability the assistant already ships. `layout` is `'document' | 'workbench'`, defaulting to `document`: `document` renders in the shared reading column and `workbench` asks for the wider application frame. The frame belongs to the host shell, which sits above the plugin's markup in the DOM, so it has to be a manifest declaration, and a host too old to know the field behaves as `document`.

Panels can mount in the main navigation, Account, a selected User, a selected Project, or Settings. A `settings` section declares `layout: 'classic' | 'orbital'` for its rendering and `placement: 'page' | 'pluginDetail'` for where it is offered: `page` (the default) gives it a world in the main navigation, while `pluginDetail` offers it only inside Settings, Plugins, that plugin; the direct address keeps working either way. An `account` panel declares `placement: 'section' | 'linkedAccount'`, the latter mounting it as a row of the Linked accounts drawer; both are grant-filtered server-side. The `user` panels receive the selected user's DTO and the `project` panels the Project DTO. `strings` holds flat English view strings for the bundle, with per-locale overrides under `web.strings` in `i18n/<lang>.json`.

For bundled plugins, put browser sources under `web-src/index.tsx` (or `.ts`, `.jsx`, `.js`) and run:

```bash
npm run build:plugins-web
```

The script emits `web/index.js` and, when the bundle uses utility classes, `web/index.css`. `npm run build` runs this step before copying plugins into `dist/`.

Register the bundle through the browser runtime:

```javascript
window.__elowenRegisterPluginUi?.('my-plugin', {
  requiresApiVersion: 16,
  pages: { '': RootPage },
  account: { connection: ConnectionPanel },
  project: { overview: ProjectPanel },
  settings: { settings: SettingsPanel },
});
```

Use the host-provided `window.ElowenUiRuntime` for React, components, hooks, utilities, authenticated API calls, and navigation. The current host runtime contract is API 16. Compatibility is a ceiling: a bundle loads when `requiresApiVersion <= 16`, so the host runtime may add names but must not remove or rename published components, hooks, or utilities. Build with `elowen-plugin-ui-kit` against the same contract. Never import from the host `web/` application; dependency-cruiser enforces this boundary so the bundle cannot ship a second React or query client.

API 16's public autosave contract is:

- `SaveStatus`: `idle | saving | saved | pending | error`;
- `components.AutoSaveStatus({ status, onRetry? })` for the shared indicator;
- `hooks.useAutoSaveStatus(deps, save, { ready?, savable?, delay? })`, returning `status`, async `retry()`, and async `flush()`;
- `hooks.usePluginConfigDraft(name, detail, { save? })`, returning the canonical draft values, `setValue`, explicit async `commitValue`, status, `errorKind`, retry/flush, and readiness;
- `PluginPageProps.onSaveState(status, retry?)`, which reports the section into the host page or deck indicator.

The host consumes the initial seed without writing it, serializes saves, collapses edits made during an in-flight write into one trailing pass, and flushes pending valid edits on teardown. `usePluginConfigDraft` sends `detail.revision` as `expectedRevision`, adopts canonical successful responses, never autosaves schema-declared secrets, and returns `{ pending: true }` from `commitValue` when persistence succeeded before activation. A plugin-owned page frame must render its own save indicator; other settings sections should report through `onSaveState`.

The host serves the bundle and stylesheet at content-hashed same-origin URLs and lists available plugin UI through `GET /plugins/ui`. Browser pages mount under `/p/<plugin>/...`. A plugin with `web.adminOnly` has both navigation and assets hidden from non-admin accounts.

A plugin whose world should wear a count in the main navigation registers a probe:

```javascript
ctx.registerNavBadge(({ userId, isAdmin }) => unreadFor(userId) || null);
```

The probe is synchronous and runs on every `/plugins/ui` request, so it must answer from state the plugin already holds and must never reach the network. Return `null` or `0` for no badge; the field is then absent from the listing entirely, because a row permanently wearing a `0` is noise. A probe that throws loses its own badge and is warned, leaving the rest of the listing untouched. Feature-detect with `typeof ctx.registerNavBadge === 'function'` when the plugin must also load on an older daemon.

Two related filters run on the same listing. `ctx.registerUiVisibility(fn)` filters this plugin's own account and project panels per account, synchronously and server-side, so a hidden panel's id never reaches the browser; it is presentation, not authorization, so route-level authorization still belongs to the plugin's API routes. `ctx.registerProjectIndicators(provider)` contributes compact plugin-owned status rows to the core Project register in one tenancy-filtered server-side batch.

The host web application is prebuilt. If the plugin needs Tailwind utility classes not already present in the host CSS, ship the plugin stylesheet. The generated sheet contains utilities inside `@layer utilities`, has no preflight, and uses host design tokens. Do not rely on a development-only host build to generate plugin classes.

## Platform adapters

A platform plugin bridges a transport to the brain:

```json
"provides": { "platforms": ["my-platform"] }
```

```javascript
ctx.registerPlatform({
  name: 'my-platform',
  async connect() {},
  listen(onMessage) {},
  async send(channelId, text) {},
});
```

The adapter owns transport authentication, inbound message normalization, outbound formatting, and platform-specific state. `PlatformAdapter` supports `connect`, `disconnect`, `listen`, `send`, optional proactive `notify`, and optional channel `control` wiring.

For Discord, Telegram, Teams, WhatsApp, and similar adapters, reuse the published `elowen-plugin-shared` package instead of copying transport-neutral behavior. The daemon currently ships shared API contract 4. The package root exports only `PLUGIN_SHARED_API_VERSION`; every helper lives on its own export path, so importing one small helper does not pull in the live-message engine or the voice pipeline. The modules include `stateStore`, `display`, `format`, `images`, `messages`, `help`, `chatCommands`, `liveTrace`, `liveMessage`, `turnRunner`, `turnResult`, `voice`, `httpClient`, `lifecycle`, `atomicJson`, `access`, and the `cronGrammar.json` data export. Declare `"requiresSharedApi": 4` in the manifest when importing it. This is an exact contract match, not a minimum: the host refuses a plugin declaring another number before importing its entry module. The number changes only when an existing export changes shape or disappears, never when something is added.

Additions to the shared API are feature-detected rather than version-branched: when the adapter must also load on a daemon that predates them, check for `PlatformControlApi.fastStatus`, `setAccountFast`, `listProjects`, and `switchProject` with `typeof` the way the route surfaces are feature-detected above.

The shared command catalog is authoritative. Use `ctx.chatCommands(surface)` and the helpers from `elowen-plugin-shared/chatCommands`; do not accept commands merely because a local name list contains them. Keep only transport-specific chunk sizes, markup, reply shapes, and SDK integration in the adapter.

The `/chatCommands` module is the shared picker bridge. It defines the picker names in one place, a context picker and a project picker, and derives the routing sets each adapter needs from the published command catalog: the session-control names, the surface-local names plus adapter-owned ones (fail-closed, so an empty projection yields an empty set), and their union, which is kept out of transcripts. `runControlCommand` implements the shared pure actions `new`, `fast`, `stop`, `stats`, `compact`, and `restart`. `runPickerCommand` lets a typed `/project <slug|id>` argument skip the chooser and switch in one step, while a bare `/project` opens the same chooser as `/context`. `applyPickerChoice(picker, value, b)` resolves as the person choosing at click time, never whoever opened the chooser, and the context picker re-checks its operator gate on submit. A surface keeps exactly two seams: it renders the descriptor (`picker`, `title`, `placeholder`, `items` of `{ value, label, hint? }`) and hands the choice back. A project's absolute path is never copied into the descriptor, so no renderer can leak it into a shared room.

`cronGrammar.json` is a frozen contract shipped with the package so both sides of the cron grammar read the same file. The grammar is hand-mirrored in three implementations that cannot import one another: the scheduling plugin's parser, which is the authority, and two web helpers. The daemon checks its web copies against this file, and the plugin registry checks the plugin against it.

Platform-specific prompt fragments can be placed in `prompt/*.md`. The loader applies them only to platforms declared in `provides.platforms` and actually registered by the plugin. It reads at most 16 files, 8,000 characters per file, and 32,000 characters in total.

## Daemon MCP tools

`registerMcpTool` contributes to Elowen's own authenticated `/mcp` server. It is different from the `mcp` plugin, which manages external MCP servers.

MCP tool names use lowercase `snake_case` and must be declared in `provides.mcpTools`:

```javascript
ctx.registerMcpTool({
  name: 'my_tool',
  description: 'Reads the current plugin status.',
  inputSchema: {},
  async run(args, request) {
    return request('GET', '/plugins/my-plugin/api/status');
  },
});
```

The request function is bound to the calling MCP client's token. A plugin MCP tool cannot act with broader rights than that client. The live `/mcp` tool list changes with plugin reloads.

## Release versioning

Keep these version axes separate:

- The daemon version is the root `package.json` version (`0.28.36` in this checkout) and is the version used by `requiresCore` checks. Update it through the repository's normal release process; do not infer it from a plugin manifest or the marketplace catalog.
- A plugin's manifest `version` is that plugin's own release version. Bump it whenever its installed bytes change, so reload cache-busting and marketplace update detection see the new build. It does not need to match the daemon version.
- `apiVersion` is the plugin API breaking-change axis and is currently `"1"`; `requiresCore` is a minimum daemon version for additive host APIs. `requiresSharedApi` is the exact shared-helper contract, currently `4`.
- `web.requiresApiVersion` is the host browser-runtime compatibility ceiling, currently `16`; it must not be used to signal removals.

### Writing a changelog entry

Release notes ship WITH the product. `CHANGELOG.md` stays the repository's full technical log; the notes users read live in the bundled `changelog` plugin, one Markdown file per release under `plugins/changelog/entries/<version>.md`. `npm run build` copies `plugins/` into `dist/`, so the entry an instance shows is the one that build shipped and an update brings the new notes with it. Nothing is authored per instance.

Add a file named after the version, with front matter and a body:

```markdown
---
version: 0.28.36
date: 2026-09-09
title: What this release gives the reader
tags: [Chat, Plugins]
pinned: false
---

A paragraph naming the change in the reader's terms.

### Added

- One line per change, written for somebody using Elowen rather than building it.
```

Add screenshots only when the referenced asset is tracked under `plugins/changelog/entries/assets/<version>/`. Do not leave a Markdown image reference to an untracked or unavailable file.

Rules the parser and the page rely on:

- `version` is required and is what the file sorts and addresses by; an entry without one is skipped with a warning. `date` is ISO `YYYY-MM-DD`. `title`, `tags` and `pinned` are optional; a pinned entry sits above the rest, everything else is newest first.
- Images go in `plugins/changelog/entries/assets/<version>/` and are referenced by that relative path. The page rewrites the source onto the plugin's own asset route, which serves `png`, `jpg`, `jpeg`, `gif` and `webp` only. SVG is refused on purpose: it is a script-carrying document.
- The body is ordinary Markdown, rendered in the browser and sanitized before it reaches the page. Write prose and lists; an entry may carry a short how-to with screenshots.
- Each account gets an unread marker: every release newer than the version that account last opened the page at counts toward the badge on the navigation entry. Adding a file is all it takes for that to happen.

A release build copies bundled plugins into `dist/plugins/` and emits browser bundles from `web-src/`. Registry-owned plugins release in `elowen-plugins` and are not published as part of the main npm package. Keep registry catalog metadata and the plugin manifest aligned, but treat the manifest as authoritative for installed version and capabilities. Do not describe a release as published or pushed unless the corresponding remote operation actually completed.

## Testing and build checks

Start with the narrowest check for the surface you changed:

```bash
# Build bundled browser bundles
npm run build:plugins-web

# Build TypeScript, plugin bundles, and the distributable tree
npm run build

# Contract and marketplace coverage
npx vitest run \
  tests/contract/pluginApiSubpath.test.ts \
  tests/contract/pluginSharedPackage.test.ts \
  tests/contract/registryPluginDependencies.test.ts \
  tests/api/pluginUiRoutes.test.ts \
  tests/plugins/marketplace.test.ts

# Repository-wide static checks
npm run check
```

For route or access changes, also run the focused API and plugin-grant tests. For hooks, run the hooks end-to-end test. For changes to an extracted registry plugin, build and test that plugin in its owning registry checkout, then run the corresponding host contract tests here.

A new or changed manifest must parse successfully and the entry must be present in the built plugin tree. A browser plugin must produce the files named by its manifest `web.entry` and optional `web.css` fields. Inspect the daemon log after a reload if a plugin is skipped; the loader reports the plugin name and the validation or registration error.
