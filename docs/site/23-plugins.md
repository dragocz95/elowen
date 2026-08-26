---
title: Plugins
slug: plugins
order: 23
eyebrow: Extending
group: Extending
---

# Plugins

Plugins extend Elowen without turning the daemon into a monolith. They can contribute tools, skills, prompt commands, hooks, inbound webhooks (HTTP routes), dynamic turn context, platform adapters, icons, and configuration. The registry loads enabled plugins into the shared runtime; each plugin receives a scoped context rather than unrestricted daemon internals.

![Plugins in Settings](images/plugins-overview.png)

## Manage plugins

Open **Settings → Plugins** to inspect installed plugins, enable or disable a capability, adjust its schema-driven settings, inspect contributions, and use the marketplace where configured. Bundled plugins can be soft-removed and restored; their package files are not deleted as part of a normal UI toggle.

Bundled capabilities include file and terminal tools, MCP, skills, sub-agent delegation, ask-user questions, scheduled jobs, codebase indexing, runtime context, Discord, Telegram, Microsoft Teams, WhatsApp, and supporting presentation tools. The exact installed set can differ by deployment, so Settings is the source of truth for a running instance.

A **new install enables only the assistant's own toolkit**: files, terminal, ask-user, runtime context, sub-agents, the Elowen manual, statusline, and MCP. Product verticals with their own pages and data are installed deliberately from **Settings → Plugins**, as are chat platforms and repository integrations that need credentials.

**DocsSearch** searches Elowen's shipped user manual. With a configured embedding model it finds sections by meaning; otherwise it uses keyword matching and says so. Results identify the source page and heading. Use it for product behaviour or settings before guessing; use **CodebaseSearch** for the user's own repositories instead.

## Plugin anatomy

Each plugin lives under `plugins/<name>/` and declares itself with **`elowen-plugin.json`**:

```text
plugins/example/
├── elowen-plugin.json
├── index.mjs
├── icon.svg                 # optional
├── i18n/
│   └── cs.json              # optional locale override
└── lib/                     # optional implementation modules
```

The manifest must match the daemon's plugin API version and includes a name, version, description, ESM entry, declared contributions, optional config schema, and optional capabilities. The manifest is both validation and presentation metadata; the plugin's `register(ctx)` call is the authoritative runtime contribution.

```json
{
  "name": "example",
  "version": "0.1.0",
  "apiVersion": "1",
  "description": "A focused Elowen capability.",
  "entry": "index.mjs",
  "provides": { "tools": ["example_lookup"] },
  "configSchema": [
    { "key": "enabled", "label": "Enabled", "type": "boolean", "default": true }
  ]
}
```

For the full developer contract, validation rules, and examples, see the plugin development documentation shipped in the Elowen repository.

## Scoped capabilities

The runtime is deny-by-default for plugin mutations. A manifest can declare lifecycle hooks, mutation intent, scoped reads, and network intent. For example, a plugin needs the appropriate `mutates` capability before a hook's turn-context contribution can change the prompt assembly, and it needs `reads: ["embeddings"]` before it can use the shared embedding service.

This gives the host one auditable place to decide what a plugin may affect:

- **Tools and skills** are added through the registry and then filtered by the user's effective access.
- **Hooks** can observe lifecycle events; only declared, runtime-supported mutations are applied.
- **Dynamic turn context** is ephemeral and may be placed before or after the user message.
- **Provider access** is resolved from the central Elowen AI provider list instead of duplicating API keys in plugin config.
- **Embeddings** reuse the Memory embedding configuration and remain unavailable until both the capability and a model are configured.

## Config schema and localization

Plugin config fields drive the Settings UI. Supported field types include strings, booleans, numbers, text areas, model/provider selectors, sections, enums, multi-selects, code, prompts, JSON, embedding models, and specialized editors.

New integration credentials use the encrypted core vault through `ctx.instanceSecrets()` or `ctx.userSecrets()`, not ordinary config JSON. The UI receives only non-secret metadata or whether a credential is connected. Put English fallback labels in the manifest and locale overrides under `plugins/<name>/i18n/<language>.json`.

## Platforms and automation

Platform plugins adapt inbound messages into the same brain-turn pipeline used by the Web UI and CLI. They map sender identity and role policy to an Elowen user before a turn can run; an unmapped sender does not receive agent access by default.

The cron plugin runs scheduled and one-shot prompts through that same pipeline. A job's optional check gate runs through the platform's default shell, so jobs fire the same on Linux, macOS, and Windows. A one-shot wake-up keeps its originating conversation alive until it fires, so the follow-up lands in the same thread with full context. The sub-agent plugin delegates a bounded task while preserving the caller's effective scope. A delegate inherits the caller's model by default, but can run on any other enabled model — including one from a different provider (`DelegateModels` lists the valid values). It also inherits the parent turn's working directory and reasoning effort, so a child agent starts in the same repository context and with the same thinking budget the caller was using. Workflows take this per node: each node of the DAG can name its own model, so one graph can route mechanical steps to a cheap fast model and reserve a frontier model for the nodes that need it. These are extensions of the core agent lifecycle, not parallel chat engines.

### Typed sub-agents

Each `.md` file under the built-in `prompts/agents` directory or the instance's config `agents` directory defines one sub-agent type: frontmatter (name, description, tools) plus a body that becomes the child's system prompt. A user file overrides a built-in of the same name. Elowen ships built-in **explore** and **plan** types, both read-only. The delegating call selects a type; omitting it keeps the previous generic behavior.

A type's `tools` spec is either a preset — `read-only`, `all`, or `inherit` — or a custom allow-list. A read-only agent is minted a strictly-narrower permission boundary: writes are denied, the shell is gated to a read-only allow-list, and unattended asks are forced to deny. So it can inspect via shell but never mutate, even when running unattended — the boundary also closes indirect escapes such as process substitution and git subcommands that shell out to an external diff/merge tool. If the caller's own tool allow-list shares nothing with the read-only preset, delegation fails with an explicit error instead of silently spawning a child that can do nothing.

The sub-agent plugin's detail card in **Settings → Plugins** lists the built-in and user agents and lets an admin create, edit, and delete their own (built-ins are read-only). Each write is validated with the real agent parser before it lands and hot-reloads, so the catalog refreshes live.

## Lifecycle ownership

A plugin that stores account-owned data registers `registerUserRemoved()`. A plugin that binds rows or files to core Projects registers `registerProjectRemoved()` and also reconciles at boot, because a disabled plugin cannot receive a deletion callback. Core Project and user ids are monotonic, so stale disabled-plugin rows cannot attach to a newly created owner.

Each plugin owns its vertical slice: tables, routes, tools, pages, configuration, and cleanup. Core does not know a vertical by plugin name or fabricate empty results while its owner is disabled.

## Reload behavior

Changing plugin enablement or configuration reloads the registry so future turns use the current contributions. Existing live work is not rewritten retroactively. Keep plugin work inside the plugin directory; shared transport, policy, and runtime behavior belongs in `src/`.

Skills are applied live: creating or deleting a skill through the `CreateSkill` / `DeleteSkill` tools takes effect from the next message onward without a daemon restart. The same is true for sub-agent type definitions edited through the plugin detail card.

[Next: Skills](skills)
