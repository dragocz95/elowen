---
title: Plugins
slug: plugins
order: 23
eyebrow: Extending
group: Extending
---

# Plugins

Plugins add optional capabilities to Elowen. A plugin can provide tools, skills, chat-platform adapters, scheduled automation, repository integrations, pages in the Web UI, or plugin-specific settings.

![Plugins in Settings](images/plugins-overview.png)

## Open the plugin manager

An administrator manages plugins from **Settings → Plugins**. The page has two views:

- **Installed** lists bundled plugins and plugins installed from the marketplace. Use the toggle to enable or disable a plugin, open its details, update it, or remove it.
- **Available** lists plugins from Elowen's curated registry. It also shows bundled plugins that were removed from the installed view and can be restored. Search and category filters narrow either view.

The default registry is the `main` branch of [github.com/dragocz95/elowen-plugins](https://github.com/dragocz95/elowen-plugins). Its `registry.json` is the install allow-list; the marketplace does not install from arbitrary URLs or local folders. The registry is separate from the Elowen npm package, so a plugin's availability and version can change independently of the core release.

Settings is the source of truth for the plugins available on your deployment. A fresh installation enables the core toolkit:

- `files`
- `sandbox`
- `terminal`
- `askuser`
- `runtime-context`
- `subagent`
- `elowen-docs`
- `statusline`
- `mcp`

Other capabilities are installed deliberately. Examples include Discord, Telegram, Microsoft Teams, WhatsApp, GitHub, skills, scheduling, codebase indexing, and editor or other product integrations.

## Install and enable a plugin

1. Open **Settings → Plugins → Available**.
2. Find the plugin and select **Install**.
3. Elowen validates and installs the copy while it is disabled, then enables it as part of the same operation when no further approval is required.
4. If it declares mutating capabilities, review and acknowledge them when prompted. Cancelling leaves the plugin installed but disabled.
5. Configure any required fields in the plugin's detail view.

Installation and activation are separate internally: the marketplace always lands a validated copy disabled before attempting to enable it. Consent may cover one or more of `tools`, `memory`, `events`, `workflow-dag`, and `users`; it is requested only when the plugin is being enabled.

A plugin may also declare `requiresCore`, a minimum Elowen version for additive host APIs. The marketplace refuses installation when the running core is too old, before leaving a partial plugin on disk. Upgrade Elowen first, then install or update that plugin. The manifest's `apiVersion` and, when declared, `requiresSharedApi` remain separate exact compatibility contracts.

If Elowen is handling active work, applying an install, update, or enable/disable change can be deferred until that work settles. A `pending` result means the change was accepted and will be applied when the work settles; do not repeat the operation.

## Plugin dependencies and controls

Plugins can publish named runtime **controls** for other plugins and can declare controls they require. A required control is satisfied by any enabled plugin that publishes that key; the dependency is not tied to a specific plugin name. For example, an integration can require `microsoftIdentity` without depending on one particular identity provider.

When enabling a plugin, Elowen checks its declared `requiresControls` against the `provides.controls` declarations of enabled plugins. If no installed provider is declared, enabling is refused with the provider names (when known), rather than silently enabling a plugin whose surface cannot work. This is a manifest-level check: an enabled provider may still be unconfigured or fail to register its runtime control, in which case the dependent plugin hides its surface. Controls are resolved live after reload, so disabling a provider can make the dependent surface unavailable until the dependency is restored. A plugin that both publishes and requires the same control satisfies its own dependency.

## Configure a plugin

Select an installed plugin to open its detail view. The available tabs are:

- **Setup** — required fields and initial configuration.
- **Behavior** — normal plugin settings.
- **Capabilities** — tools, hooks, and the permissions the plugin declares.
- **Activity** — recent plugin health and log activity.
- **Advanced** — advanced fields and the plugin's stored data summary.

Plugin settings are schema-driven, so the fields depend on the plugin. They can include provider or model selectors, booleans, numbers, text areas, enumerations, multi-selects, JSON, code, prompts, MCP server settings, and project or tool selectors. Settings are saved by the plugin settings form; a daemon restart is normally not required.

Secret fields are write-only. Elowen stores credentials in its encrypted secret store and shows only whether a secret is set. It does not send the secret value back to the Web UI, including to administrators.

Some plugins expose **per-account settings** rather than one instance-wide configuration. When available, sign in and open the plugin's panel under **Account**. Each account has its own values, and a plugin cannot read another account's values.

## Control access for individual users

Some plugins are marked as user-grantable. For those plugins, non-admin users cannot use the plugin's gated tools, authenticated API routes, browser UI, or contributed skills until an administrator grants it:

1. Open **Users**.
2. Select the user.
3. In **Granted plugins**, choose **Manage**.
4. Select the plugins the user may use and save.

An empty selection means that the user receives none of the grantable plugins. Administrators always retain access. Plugins that are not marked grantable remain available to authenticated users according to the normal account and tool permissions. A plugin grant does not gate every contribution: prompt fragments, platform prompts, slash commands, and hooks are not filtered by this grant.

A grant is separate from the plugin's own configuration and from individual tool permissions. The grant makes the gated plugin surfaces eligible for that user; the plugin's settings determine how the integration operates, while tool permissions can narrow the tools further.

## Inspect what is active

The plugin detail view shows the plugin's declared capabilities and its current activity. In chat, run **`/tools`** to list the tools currently available to your account, including each tool's plugin owner, description, and input schema.

If a plugin is enabled but its tools or pages are missing, check these items in order:

1. The plugin is enabled in **Settings → Plugins → Installed**.
2. Your account has the required per-user grant, if the plugin is grantable.
3. Required configuration fields and credentials are complete in the plugin detail view.
4. The plugin's **Capabilities** and **Activity** tabs do not report an error.
5. Run **`/tools`** again in a new turn.

## Update, disable, remove, and restore

- **Update** a marketplace plugin from its Installed card when an update is shown. Updates are copied from the curated registry and must pass the plugin's compatibility checks.
- **Disable** a plugin to stop loading its tools, pages, and other contributions. The change applies after the live registry reload; work already running is not rewritten.
- **Remove** a bundled plugin to hide it and stop loading it. Its files remain in the Elowen package, and it is restorable from **Available** as a disabled plugin.
- **Uninstall** a marketplace plugin to remove its files and plugin-owned persistent data. This is different from disabling it and cannot be undone from the UI.

Plugin changes are applied live when the registry reload completes. A normal enable, disable, update, uninstall, or bundled-plugin restore does not require restarting the daemon. If the daemon is busy, the UI reports `pending` and completes the change after the running work settles.

### Upgrades and release sequencing

The core Elowen package and the plugin registry are released separately. Upgrade the core before installing a registry plugin whose manifest requires that core version; publish or make the compatible plugin available only after the required core is available to operators. Never assume that a core release automatically publishes a plugin update.

During startup, Elowen reconciles enabled plugin names that are no longer present on disk, such as plugins moved from the npm package to the registry. It reinstalls only names already enabled and never enables new plugins. If the registry is unreachable, the daemon keeps the enabled setting and leaves the plugin unavailable until the registry can be reached; an enabled-but-missing plugin's dependent route reports temporary unavailability rather than pretending the route never existed.

## Safety and trust

Plugins run as part of the Elowen installation and are not isolated browser sandboxes. Install only plugins you trust; the marketplace limits the source to the curated registry, but a plugin can still add tools, network integrations, pages, and other runtime behavior. Review the capability list before enabling a plugin, especially when it requests access to tools, memory, events, workflows, or users.

For account-level tool and model restrictions, see [Users & Access](users-access). For the general settings layout, see [Configuration](configuration).

[Next: Skills](skills)
