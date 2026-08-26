# Plugin Development Guide

Elowen plugins are trusted ESM packages loaded through the plugin registry. A plugin normally consists of an `elowen-plugin.json` manifest and a built entry module exporting `register(ctx)`. It can add tools, skills, commands, prompt context, hooks, API routes, webhooks, services, browser UI, platform adapters, or domain controls.

The manifest describes the plugin's contract. `register(ctx)` is the runtime source of its contributions.

## Plugin locations and loading

The daemon scans two plugin roots, in this order:

1. The bundled plugin directory shipped with Elowen (`dist/plugins/` in a built installation).
2. The instance data directory's `plugins/` folder, next to the database.

Bundled folders win when both roots contain the same plugin name. Only names in the enabled-plugin configuration are loaded. Folders are scanned and loaded in deterministic name order. Each plugin is registered into an isolated staging registry and merged only after `register(ctx)` completes; a malformed or failing plugin is skipped without leaving partial tools or routes behind.

The source checkout currently bundles `askuser`, `elowen-docs`, `files`, `mcp`, `runtime-context`, `sandbox`, `statusline`, `subagent`, `terminal`, and `web`. Optional integrations and extracted domain plugins are installed from the curated plugin registry. Marketplace installation is limited to that registry; it does not accept arbitrary URLs or local folders. An installed marketplace plugin is placed disabled first, then enabled separately with any required capability acknowledgement.

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
    "apiRoutes": ["status"]
  },
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

- The directory name must equal `name`.
- `entry` is relative to the plugin directory and must stay inside it.
- `apiVersion` is currently `"1"`.
- `requiresCore` is an optional minimum Elowen version for additive host APIs.
- `requiresSharedApi` is an optional **exact** integer contract version for `elowen-plugin-shared`. Declare it when the plugin imports that package. The value must match the version shipped by the daemon.

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
  "mcpTools": ["my_tool"]
}
```

`registerHttpRoute`, `registerApiRoute`, `registerNotificationDestinationProvider`, and `registerMcpTool` are deny-by-default: their paths or names must be declared in the corresponding manifest list. Tools and platforms should also be declared so the manifest remains an accurate audit surface.

There is no `provides.hooks` field. Hooks are registered with `registerHook`; their mutations are governed by `capabilities.mutates`.

### Tool metadata

- `icons`: per-tool display icons. Keys may be exact tool names.
- `showOutput`: exact names or `prefix*` patterns whose successful output should appear in chat. Successful output is otherwise hidden; failures remain visible.
- `planSafe`: exact tool names that may be used in plan mode. Patterns are not accepted.
- `deferLoading`: exact names or `prefix*` patterns that should be deferred into `ToolSearch`. Patterns expand only to tools registered by the same plugin.
- `icon`: optional SVG path relative to the plugin directory. If omitted, `icon.svg` is used when present.

Tool names are durable data. They appear in events and saved permission rules and deny-lists. Choose a stable name before publishing; a rename requires a coordinated migration of stored tool names.

### Configuration schemas

`configSchema` describes instance-wide plugin settings. `userConfigSchema` describes per-account settings. Both use the same field format and are rendered by the plugin settings UI.

Supported field types are:

```text
string, secret, boolean, number, textarea, rolePolicies, model, provider,
section, enum, multiSelect, code, prompt, json, embeddingModel, mcpServers,
destination, projects, plugins, tools, models
```

Common field properties include `key`, `label`, `type`, `hint`, `help`, `required`, `default`, `min`, `max`, `step`, `placeholder`, `options`, `language`, `risk`, `advanced`, `fullWidth`, and `visibleWhen`.

Keep English text in the manifest as the fallback. Add translations under `i18n/<lang>.json`; manifest fields use `description` and `fields`, while browser UI metadata uses `web`.

Use `userConfigSchema` for ordinary account settings such as a selected option or external identifier. Read the current account's values with `ctx.userConfig()`. It returns `null` when the turn is not acting as an account; never fall back to instance configuration in that case. The host routes per-account configuration through `GET /plugins/user-config` and `PATCH /plugins/:name/user-config` and never returns secret values.

### Per-account access

Set `userGrantable: true` only when the plugin must be granted separately to each non-admin account. Such a plugin is deny-by-default for non-admins until an administrator grants it through the account's plugin access settings. The grant filters its routes, tools, skills, and browser UI.

A grant does not currently filter prompt fragments, slash commands, or hooks. Do not put account-sensitive behavior in those surfaces of a grantable plugin.

### Capabilities

Capabilities are deny-by-default:

```json
"capabilities": {
  "reads": ["db", "stores", "git", "project-files"],
  "mutates": ["events"],
  "network": true
}
```

`mutates` values currently include `prompt`, `turnContext`, `tools`, `memory`, `events`, `workflow-dag`, and `users`. The host requires explicit acknowledgement when enabling a plugin that declares `tools`, `memory`, `events`, `workflow-dag`, or `users` mutation authority.

`reads` gates host capabilities such as `db`, `controls`, `embeddings`, `providers`, `prompts`, `stores`, `git`, and `project-files`. Declare only the scopes the implementation needs. `network` records network intent; it is not a replacement for validating remote data.

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

Tools can be scoped to one account by passing `ownerUserId` to `registerTool`. Omit it for an instance-wide contribution:

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
| `registerCommand` | Add a kebab-case prompt macro such as `/review`. |
| `registerSystemPromptFragment` | Add stable plugin instructions to the system prompt. |
| `registerTurnContext` | Add ephemeral per-turn context without changing stored history. |
| `registerHook` | Observe a typed lifecycle point and, for supported hooks, return a gated patch. |
| `registerPlatform` | Register a chat transport adapter. |
| `registerHttpRoute` | Add a public webhook under `/hooks/<plugin>/...`. |
| `registerApiRoute` | Add an authenticated route under `/plugins/<plugin>/api/...`. |
| `registerService` / `registerInterval` | Register host-managed background work. |
| `registerControl` / `control` | Publish or resolve a live domain control. |
| `registerMcpTool` | Add a tool to Elowen's own authenticated `/mcp` server. |
| `registerPrompts` | Register editable markdown prompt templates. |
| `registerBootReconcile` | Reconcile durable plugin state on boot and reload. |
| `registerUserRemoved` | Delete account-owned rows, files, secrets, and schedules. |
| `registerProjectRemoved` | Clean up plugin state when a core Project is removed. |
| `requestReload` | Ask the host to apply files written by the plugin after the current turn. |

Other context surfaces include `ctx.dataDir()`, `ctx.config`, `ctx.userConfig()`, `ctx.instanceSecrets()`, `ctx.userSecrets()`, `ctx.host`, `ctx.embeddings`, `ctx.processes`, `ctx.askUser()`, `ctx.emitCard()`, `ctx.notify()`, and the current-turn identity and access accessors. Every host capability is either scoped to the active turn or gated by the manifest.

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

### Secrets

Use encrypted secret bags for credentials:

- `ctx.instanceSecrets()` stores the plugin's instance namespace.
- `ctx.userSecrets()` stores the current account's namespace and returns `null` for accountless work.

Each bag supports `get`, `has`, `set(key, value, expectedVersion?)`, and `delete`. Use the returned version for compare-and-swap updates. Do not put new credentials in `ctx.config` or `ctx.userConfig()`.

`ctx.publicWebUrl()` returns the canonical URL from trusted installation metadata, or `null`. Do not construct OAuth callbacks from request `Host`, `Origin`, or forwarded headers.

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

An API handler may return a buffered body or an SSE callback through `response.sse`. Validate every route parameter and enforce the caller's Project ownership using `req.auth.accessibleProjects`; a `null` list is a list-scoping result for admin/open/setup contexts, not permission to access an arbitrary Project.

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

Command names must be 1–32 characters of lowercase letters, digits, and dashes. They must not shadow a built-in or reserved command and must be unique across plugins. Supported substitutions include `$ARGUMENTS`, `$@`, `$1`–`$9`, `${N:-default}`, and `${@:N}`. Plugin commands are prompt macros, not new control-plane endpoints.

Adapters should obtain their complete command metadata with `ctx.chatCommands(surface)`. Do not maintain a second hard-coded command list. The returned `execution` field distinguishes session controls, surface-local pickers, and plugin prompt commands.

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

Two hook mutations are runtime-wired:

- `appendContext` from a turn-context hook, gated by `mutates: ["turnContext"]`.
- `denyToolCall` from `tools.call.before`, gated by `mutates: ["tools"]`.

A hook may also be a pure observer. Hook failures do not grant permission or block a call; implement critical enforcement in the tool or route's own authorization path.

## Controls and plugin dependencies

A control is a live domain interface, not a plugin-name lookup. Declare the control shape in `KnownControls` when core needs to call it, then register it under a domain key:

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

Use domain keys such as `sandbox`, `mcp`, or `workflow`, not the current plugin name. `registerControl(name, control, { requires })` can make one control unavailable until another domain control resolves.

## Browser UI

A plugin browser bundle is declared in the manifest:

```json
"web": {
  "entry": "web/index.js",
  "css": "web/index.css",
  "requiresApiVersion": 1,
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

The `web` block may also declare `nav`, `user`, `strings`, `adminOnly`, and `navKind`. Panels can mount in the main navigation, Account, a selected User, a selected Project, or Settings.

For bundled plugins, put browser sources under `web-src/index.tsx` (or `.ts`, `.jsx`, `.js`) and run:

```bash
npm run build:plugins-web
```

The script emits `web/index.js` and, when the bundle uses utility classes, `web/index.css`. `npm run build` runs this step before copying plugins into `dist/`.

Register the bundle through the browser runtime:

```javascript
window.__elowenRegisterPluginUi?.('my-plugin', {
  requiresApiVersion: 1,
  pages: { '': RootPage },
  account: { connection: ConnectionPanel },
  project: { overview: ProjectPanel },
  settings: { settings: SettingsPanel },
});
```

Use the host-provided `window.ElowenUiRuntime` for React, components, hooks, utilities, authenticated API calls, and navigation. Build with `elowen-plugin-ui-kit`. Never import from the host `web/` application; dependency-cruiser enforces this boundary so the bundle cannot ship a second React or query client.

The host serves the bundle and stylesheet at content-hashed same-origin URLs and lists available plugin UI through `GET /plugins/ui`. Browser pages mount under `/p/<plugin>/...`. A plugin with `web.adminOnly` has both navigation and assets hidden from non-admin accounts.

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

For Discord, Telegram, Teams, WhatsApp, and similar adapters, reuse the published `elowen-plugin-shared` package instead of copying transport-neutral behavior. Its modules include `stateStore`, `display`, `format`, `images`, `messages`, `help`, `chatCommands`, `liveTrace`, `liveMessage`, `turnRunner`, and `access`. Declare the exact `requiresSharedApi` integer in the manifest when importing it.

The shared command catalog is authoritative. Use `ctx.chatCommands(surface)` and the helpers from `elowen-plugin-shared/chatCommands`; do not accept commands merely because a local name list contains them. Keep only transport-specific chunk sizes, markup, reply shapes, and SDK integration in the adapter.

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

For route or access changes, also run the focused API and plugin-grant tests. For hooks, run the hooks end-to-end test. For changes to an extracted registry plugin, build and test that plugin in `/var/www/elowen-plugins`, then run the corresponding host contract tests here.

A new or changed manifest must parse successfully and the entry must be present in the built plugin tree. A browser plugin must produce the files named by its manifest `web.entry` and optional `web.css` fields. Inspect the daemon log after a reload if a plugin is skipped; the loader reports the plugin name and the validation or registration error.
