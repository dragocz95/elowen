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
| `provides` | Tools, skills, hooks, and platforms the plugin may register |
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

`reads: ["embeddings"]` permits `ctx.embeddings` only when the operator has
also configured the shared embedding model. `reads: ["providers"]` permits
provider resolution beyond IDs explicitly present in the plugin's own config.
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

## Loading and testing

Bundled plugins live under `plugins/<name>/` and are copied into the daemon
artifact during `npm run build`. Instance/plugin-marketplace discovery uses the
configured plugin directories; do not hard-code a private installation path.
Plugin reload stages contributions afresh, so a failed registration cannot leave
a partially registered tool set.

Add focused loader/registry/plugin tests alongside the behavior you change, then
run the relevant daemon checks from [Testing](TESTING.md). A new manifest or
entry must be present in the built `dist/plugins/` output after `npm run build`.
