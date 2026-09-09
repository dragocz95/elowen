---
title: MCP Connector Plugin
slug: mcp-plugin
order: 35
eyebrow: Plugin reference
group: Plugin reference
---

# MCP Connector Plugin

The bundled `mcp` plugin connects external Model Context Protocol (MCP) servers to Elowen and bridges their tools into the assistant's toolset. It supports three transports: `stdio` runs a server command as a local process on the Elowen host, while `http` and `sse` connect to remote endpoints. The plugin also lists and reads resources that connected servers publish.

Adding a server, bridged tool naming and deferred tool loading are covered on [MCP](mcp). This page describes operating the plugin itself: its tools, its Web UI page, its settings and its boundaries.

## Where the plugin appears

**Settings → Plugins → Installed** lists `mcp` among the bundled plugins. The plugin contributes one Web UI surface: an **MCP** page under the **Infrastructure** group. The page is the management surface for servers:

- The **Add server** action opens an editor with the name, the ownership scope, the transport and its transport-specific fields, and an enabled switch. Enabled servers are verified and their tools discovered on save; a failed verification is not kept.
- Each server row shows its status, transport, ownership and bridged tool count. A server reports `Connected`, `Disconnected`, `Error` or `Disabled`, with the last error when one exists.
- The editor for an existing server allows updates, including a changed ownership scope, which moves a remote server between scopes. A read-only viewer lists the tool definitions the server provides, since the server itself owns those definitions.
- **Reconnect** closes and reopens one server's connection and discovers its tools again. A reconnect-all action does the same for every configured server and reports how many succeeded.
- Removing a server permanently deletes its configuration, stops its connection and makes its bridged tools unavailable immediately. The confirmation names the ownership scope and transport before the removal.
- A search box and a scope filter narrow the list.

In the CLI, the **`/mcp`** command opens a picker that inspects the configured servers, their tools and their reconnect health. It is offered only while this plugin is enabled. Servers themselves are managed from the MCP page or through the tools below.

The editor shows the fields each transport needs. For a stdio server they are the executable command, its arguments and any environment variables the server needs; the page displays the configured variable names, never their values. For HTTP or SSE the editor takes an `http://` or `https://` URL. A connected server's status turns to `Disconnected` when its process exits or its remote connection drops, and `Error` records the last failure; use **Reconnect** after fixing the cause.

### Connection lifecycle

Instance servers connect when the daemon loads the plugin and reconnect at startup, each bounded by the connect timeout. A personal server is not connected at startup: its tools are composed from the last successful tool discovery, and the server connects lazily the first time one of its bridged tools is called. That is why a personal server with no cached discovery advertises nothing until it is reconnected. The MCP page always reflects the actual state, so a server that failed to connect shows `Error` with its last error rather than looking connected.

### Tools the model receives

| Tool | What it does |
| --- | --- |
| `AddMcpServer` | Adds a server, verifies the connection, discovers its tools and exposes them after the current turn reloads. |
| `ListMcpServers` | Lists the servers in one ownership scope. It never returns credentials, commands or environment values. |
| `RemoveMcpServer` | Permanently removes one server from the named scope and closes its connection. |
| `ReconnectMcpServer` | Closes and reopens one server's connection and re-discovers its tools. |
| `ListMcpResources` | Lists the resources of connected servers as JSON, keeping a failed server's error in the result rather than dropping it. |
| `ReadMcpResource` | Reads one resource by server and URI. Text returns as text; binary content is saved to a file path the agent can open with a file tool. |
| `mcp__<server>__<tool>` | The tools a connected server publishes, bridged under namespaced names the server itself defines. |

How bridged names are built, when tools are deferred behind `ToolSearch`, and how workspace confinement hides MCP tools are described on [MCP](mcp).

## Enabling the plugin

`mcp` is a bundled plugin and is enabled in a fresh installation. Its manifest requires core 0.28.24 or newer, which matters only when installing or updating it from the registry on an older deployment. If the plugin was disabled or removed, switch it on again in **Installed** or restore it from **Available**. The plugin is not user-grantable, so no per-user grant exists; availability is governed by server ownership instead. See [Plugins](plugins) for general plugin administration.

## Configuration

| Field | Key | Type | Default | What it does |
| --- | --- | --- | --- | --- |
| Timeouts | `sec_timeouts` | section | not set | Groups the two timeout fields, which apply to every configured server. |
| Connect timeout (ms) | `connectTimeoutMs` | number | `15000` | How long to wait for a server to connect and list its tools before giving up. Range 5,000 to 60,000 ms. |
| Tool call timeout (ms) | `callTimeoutMs` | number | `120000` | How long to wait for a bridged tool call to finish before giving up. Range 30,000 to 300,000 ms. |

Both values are global: they bound every server, instance and personal alike, and a saved value outside its range is clamped back into it. Settings changes apply after the plugin reload; a daemon restart is not required.

## Permissions and consent

The manifest declares no mutating capability: the plugin reads its own tables in the shared database and opens outbound network connections to the configured servers. There is no mutation consent to acknowledge on enable; consent prompts arise only for plugins that declare one, as described on [Plugins](plugins).

Ownership is the main boundary:

- **Personal** servers belong to one linked Elowen account. Only that account can manage and use them, and their credentials remain account-private. A linked account is required to create a personal server.
- **Instance** servers are shared across eligible conversations on the deployment. Creating, updating, removing or reconnecting one requires an instance administrator.

A stdio server runs the command it is configured with as a local process on the Elowen host, the same authority the terminal holds. Creating, updating, reconnecting or starting one is therefore restricted to instance administrators regardless of its ownership label, and only commands the administrator explicitly trusts should be configured. HTTP and SSE servers execute no caller-supplied command on the host, so a linked account can keep them personal.

Bridged tools follow the same ownership rule: instance tools appear in every eligible conversation, while a personal server's tools appear only in that owner's sessions. `ListMcpServers` and the MCP page never return stored credentials, commands or environment values; for a stdio server the page shows only the configured variable names. A stdio server created while a managed project is selected is bound to that project: the binding is immutable and every call runs inside that project. Removing an account removes that account's personal servers together with their stored tool caches.

The resource tools use the same visibility rule. One instance-named pair is available everywhere, and an account with personal servers also receives an owner-scoped pair that lists the instance servers plus its own. Disabling or updating the plugin tears down the connections and spawned server processes of the current load before the registry is rebuilt, so a configuration change never leaves an orphaned server process behind.

## Known limits

- A server name is 1 to 40 characters, must start with a letter or number, and may contain letters, numbers, underscores and dashes. A name may exist once per scope and must not collide with the current account's visible instance server.
- HTTP and SSE URLs must use `http` or `https` and must not contain credentials or secret-looking query parameters.
- Bridged tool names sanitize the server and tool components to lowercase words separated by underscores, each capped at 40 characters. A tool description is truncated at 2,048 characters.
- Images returned by a bridged tool are downsampled to at most 2,000 pixels per edge for vision-capable models; any other non-text content is replaced by a short placeholder instead of raw data.
- Binary resource content is saved to disk. Inside a managed project that export is capped at 16 MiB.
- A personal server is not connected at startup. Its tools are composed from the last successful tool discovery, so a server without a cached discovery advertises nothing until it is reconnected.
- A stdio server cannot change scope; create it again in the target scope instead. A remote HTTP or SSE server can move only between the instance scope and the acting account's personal scope, never to a third account.
- Bridged tools are not workspace-safe and are omitted from a session confined to an active Sandbox workspace; see [MCP](mcp).
- A bridged call that exceeds the call timeout, or a server connection that dies during the call, is raised as an error to the model. A server that answers with its own error content stays a readable result.
- Older deployments that kept a top-level `servers` array in the plugin configuration are imported once into the managed server list; afterwards the MCP page is the source of truth.

[Next: Session Helpers](session-helpers)