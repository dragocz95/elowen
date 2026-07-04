# Plugin Development Guide

Orca's brain is extensible through a lightweight plugin system. Plugins are
self-contained ESM modules that register tools, chat platforms, skills, and
context providers.

## Quick start

Create a new plugin:

```bash
mkdir -p plugins/my-plugin/
```

### Manifest (`orca-plugin.json`)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "apiVersion": "1",
  "description": "Does something useful",
  "entry": "index.mjs",
  "provides": {
    "tools": ["my_tool"],
    "platforms": [],
    "skills": []
  },
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string", "secret": true, "description": "API key" },
      "model": { "type": "string", "default": "gpt-4", "description": "Model name" },
      "enabled": { "type": "boolean", "default": true }
    },
    "required": ["apiKey"]
  }
}
```

### Entry point (`index.mjs`)

```javascript
import { defineTool, Type } from '@earendil-works/pi-coding-agent';

export function register(ctx) {
  ctx.registerTool(
    defineTool({
      name: 'my_tool',
      description: 'Does something useful',
      inputSchema: {
        text: Type.String({ description: 'Input text' }),
      },
      execute: async (callId, params) => {
        ctx.logger.info(`my_tool called with: ${JSON.stringify(params)}`);
        return `Processed: ${params.text}`;
      },
    })
  );
}
```

## Registry API reference

### `ctx.registerTool(tool)`

Register a tool function that the brain can call.

```javascript
ctx.registerTool(
  defineTool({
    name: 'tool_name',              // kebab-case
    description: 'What it does',    // shown to the LLM
    inputSchema: {                  // TypeBox schema
      param1: Type.String({ description: '...' }),
      param2: Type.Number({ default: 42 }),
    },
    execute: async (args, ctx) => {
      // args — validated input
      // ctx — turn context (identity, session, etc.)
      return result;  // string or object
    },
  })
);
```

### `ctx.registerPlatform(platform)`

Register a chat platform adapter.

```javascript
ctx.registerPlatform({
  name: 'my-platform',
  listen: async (handler) => {
    // Connect to the platform and call handler(message)
  },
  connect: async (session) => {
    // Resume or connect to a specific session
  },
  send: async (session, message) => {
    // Send a message to a platform session
  },
});
```

### `ctx.registerSkill(skill)`

Register a skill (markdown instruction for the brain).

```javascript
ctx.registerSkill({
  name: 'my-skill',
  description: 'Expert knowledge about X',
  body: `# My Skill\n\nWhen asked about X, always do Y.`,
});
```

### `ctx.registerTurnContext(fn)`

Inject dynamic context into every brain turn. Cache-safe — runs as a user
message, not injected into the system prompt.

```javascript
ctx.registerTurnContext(() => {
  const now = new Date();
  return `Current time: ${now.toISOString()}`;
});
```

### `ctx.dataDir()`

Returns the plugin's writable data directory path. Use for persistent state.

```javascript
const dataDir = ctx.dataDir();
const jobsPath = path.join(dataDir, 'jobs.json');
```

### `ctx.config`

Current plugin configuration values.

```javascript
if (!ctx.config.apiKey) {
  ctx.logger.warn('No API key configured');
  return;
}
const model = ctx.config.model || 'gpt-4';
```

### `ctx.logger`

Plugin-scoped logger.

```javascript
ctx.logger.info('Plugin initialized');
ctx.logger.warn('Rate limit approaching');
ctx.logger.error('Connection failed', error);
```

### `ctx.isAdminSession()`

Check if the current turn is from an admin user.

```javascript
if (!ctx.isAdminSession()) {
  return 'Only admins can use this tool.';
}
```

### `ctx.assertPathAllowed(path)`

Security guard — ensures a path is within the user's allowed project roots.

```javascript
ctx.assertPathAllowed(filePath);
const content = await fs.readFile(filePath, 'utf-8');
```

### `ctx.currentIdentity()`

Returns the current user's identity info:

```javascript
const identity = ctx.currentIdentity();
// { owner: boolean, admin: boolean, userId: string, platform: string }
```

### `ctx.currentAccess()`

Returns the current session's access policy.

```javascript
const access = ctx.currentAccess();
// { tools: string[], admin: boolean }
```

### `ctx.listModels()` and `ctx.resolveProvider()`

Access the brain's aggregated model catalog:

```javascript
const models = ctx.listModels();
const provider = ctx.resolveProvider('openai');
```

Useful for plugins that need to pick models dynamically (e.g. per-channel
model selector in Discord).

## Config schema

The `configSchema` in `orca-plugin.json` uses JSON Schema format with some
extensions:

| Type | Field type | Description |
|------|-----------|-------------|
| `string` | text input | Plain text field |
| `string` + `secret: true` | masked input | Write-only — never returned by API |
| `number` | number input | Numeric value |
| `boolean` | toggle | On/off switch |
| `array` | list | Array of items |
| `object` | section | Nested config group |

Schema-generated forms appear automatically in **Settings → Plugins**.

## Hook bus

Plugins can participate in the brain's hook system:

### Context hooks (`registerTurnContext`)

Per-turn context injection. Runs on every brain turn, result is appended to
the user message before processing.

### Execution hooks

Audit tool calls via the bounded ring buffer. Enabled per-plugin.

### Notification hooks

Proactive push via `notify()` capability — returns a function that sends
messages to the plugin's configured notification channel.

```javascript
const notify = ctx.capabilities.notify?.();
if (notify) {
  await notify('Something happened!');
}
```

## Path security

Always guard file operations with `ctx.assertPathAllowed()`. This resolves
symlinks and checks the resolved path is within the user's project roots.

```javascript
// Correct — guarded
ctx.assertPathAllowed(filePath);
const data = await fs.readFile(filePath, 'utf-8');

// Wrong — unguarded
const data = await fs.readFile(filePath, 'utf-8'); // ❌
```

## Deployment

### Bundled plugins

Place in `plugins/<name>/` in the Orca repository. They ship with the npm
package and are discovered automatically.

### User-installed plugins

Drop into the instance's plugin data directory. Orca discovers them alongside
bundled plugins. No build step needed.

### Hot-reload

Enabling, disabling, or saving a plugin's config triggers `reloadPlugins()`,
which drops the memoized registry and restarts every live brain session.
Changes apply immediately — no daemon restart.
