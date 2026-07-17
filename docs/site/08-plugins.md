---
title: Plugins
slug: plugins
order: 8
eyebrow: Extend Elowen
---

# Plugins

Plugins extend Elowen without turning the daemon into a monolith. They can contribute tools, skills, prompt commands, hooks, dynamic turn context, platform adapters, icons, and configuration. The registry loads enabled plugins into the shared runtime; each plugin receives a scoped context rather than unrestricted daemon internals.

![Plugins in Settings](images/plugins-overview.png)

## Manage plugins

Open **Settings → Plugins** to inspect installed plugins, enable or disable a capability, adjust its schema-driven settings, inspect contributions, and use the marketplace where configured. Bundled plugins can be soft-removed and restored; their package files are not deleted as part of a normal UI toggle.

Bundled capabilities include file and terminal tools, MCP, skills, sub-agent delegation, ask-user questions, scheduled jobs, codebase indexing, formatters, runtime context, Discord, WhatsApp, and supporting presentation/security tools. The exact installed set can differ by deployment, so Settings is the source of truth for a running instance.

**ElowenDocs** searches Elowen's shipped user manual. With a configured embedding model it finds sections by meaning; otherwise it uses keyword matching and says so. Results identify the source page and heading. Use it for product behaviour or settings before guessing; use **CodebaseSearch** for the user's own repositories instead.

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

For the full developer contract, validation rules, and examples, read [Plugin development](../PLUGIN_DEV.md).

## Scoped capabilities

The runtime is deny-by-default for plugin mutations. A manifest can declare lifecycle hooks, mutation intent, scoped reads, and network intent. For example, a plugin needs the appropriate `mutates` capability before a hook's turn-context contribution can change the prompt assembly, and it needs `reads: ["embeddings"]` before it can use the shared embedding service.

This gives the host one auditable place to decide what a plugin may affect:

- **Tools and skills** are added through the registry and then filtered by the user's effective access.
- **Hooks** can observe lifecycle events; only declared, runtime-supported mutations are applied.
- **Dynamic turn context** is ephemeral and may be placed before or after the user message.
- **Provider access** is resolved from the central Elowen AI provider list instead of duplicating API keys in plugin config.
- **Embeddings** reuse the Memory embedding configuration and remain unavailable until both the capability and a model are configured.

## Config schema and localization

Plugin config fields drive the Settings UI. Supported field types include strings, secrets, booleans, numbers, text areas, structured role policies, model/provider selectors, sections, enums, multi-selects, code, prompts, JSON, embedding models, and MCP server editors.

Secrets are write-only: the UI can show whether a secret exists but never receives its stored value. Put the English fallback labels in the manifest. Add locale overrides under `plugins/<name>/i18n/<language>.json`, including option labels where relevant.

## Platforms and automation

Platform plugins adapt inbound messages into the same brain-turn pipeline used by the Web UI and CLI. They map sender identity and role policy to an Elowen user before a turn can run; an unmapped sender does not receive agent access by default.

The cron plugin runs scheduled and one-shot prompts through that same pipeline. The sub-agent plugin delegates a bounded task while preserving the caller's effective scope. These are extensions of the core agent lifecycle, not parallel chat engines.

## Reload behavior

Changing plugin enablement or configuration reloads the registry so future turns use the current contributions. Existing live work is not rewritten retroactively. Keep plugin work inside the plugin directory; shared transport, policy, and runtime behavior belongs in `src/`.

[Next: Projects & Workflow](projects-workflow)
