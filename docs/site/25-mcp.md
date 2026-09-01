---
title: MCP Integration
slug: mcp
order: 25
eyebrow: Extending
group: Extending
---

# MCP Integration

The Model Context Protocol (MCP) lets Elowen connect to external tool servers. A server advertises tools such as repository operations, browser automation, or database queries; Elowen bridges those tools into the assistant's toolset.

The `mcp` plugin is enabled by default on a fresh installation. Manage servers from the **MCP** page under **Infrastructure**. See [Plugins](plugins) for general plugin administration.

## Add an external MCP server

1. Open **MCP** under **Infrastructure** and select **Add server**.
2. Enter a **Name** containing only letters, numbers, underscores, or dashes. It must be 1–40 characters long.
3. Choose a **Transport**:
   - **stdio** runs a command as a local process on the Elowen host.
   - **HTTP** connects to an HTTP or HTTPS MCP endpoint.
   - **SSE** connects to an HTTP or HTTPS server-sent-events endpoint.
4. Choose **Personal** or **Instance** ownership and fill in the transport-specific fields.
5. Leave **Enabled** on unless you want to save the server without making it available.
6. Select **Save**.

Enabled servers are verified and their tools discovered when they are saved. If verification fails, the new server is not kept. Use **Reconnect** after fixing a disconnected or failed server; this closes the current connection and discovers its tools again. Removing a server permanently deletes its configuration, stops its connection, and immediately makes its bridged tools unavailable.

### stdio servers

For a stdio server, provide:

- **Command** — the executable to run on the Elowen host.
- **Arguments** — one argument per line.
- **Environment variables** — one `NAME=value` entry per line.

A stdio server is local process execution, so only an instance administrator can create, update, reconnect, or start one, regardless of its ownership label. Add only commands and servers you explicitly trust.

### HTTP and SSE servers

For HTTP or SSE, provide an `http://` or `https://` **URL**. These transports do not execute a caller-supplied command on the Elowen host, so a linked account may keep them in personal scope.

## Ownership and visibility

Every server belongs to one of two scopes:

- **Personal** — owned by one linked Elowen account. Only that account can manage or use its server; in a shared room, it is visible only on that owner's turns.
- **Instance** — shared across eligible conversations on the Elowen instance. Only an instance administrator can manage it. Enabled instance servers connect when the daemon loads the plugin.

A conversation can use instance servers and the current account's personal servers. A server name may exist once in each scope, but names must not collide within a scope or with the current account's visible instance server.

Personal servers are not connected at daemon or sub-agent startup. Their last successful tool discovery is cached so their schemas can be composed; an enabled personal server connects lazily on first tool use. A server without a successful cached discovery advertises no bridged tools until it is reconnected. Instance servers connect at daemon startup. A sub-agent inherits the daemon's instance tool snapshot and connects the server lazily when a bridged tool is first called.

Remote HTTP and SSE servers can be moved between the instance scope and the acting account's personal scope. A move cannot transfer a server to another person's account. stdio servers cannot change scope; create the server again in the target scope instead.

## Sandbox workspace behavior

MCP servers do not receive Elowen's Sandbox workspace path or its Git worktree context. Bridged MCP tools are not workspace-safe tools: when a turn or delegated child is confined to an active Sandbox workspace, MCP tools are omitted from that workspace-scoped toolset. Use the workspace-aware Elowen file, terminal, and Git tools for work inside the worktree.

## Bridged tool names

Each discovered tool is exposed with the name:

```text
mcp__<server>__<tool>
```

For example, a server named `github` might expose `mcp__github__create_issue`. Server and tool names are sanitized to lowercase words separated by underscores. The doubled separators keep server and tool components unambiguous when either component contains underscores. The server controls the tool definition and input schema; these are read-only in the MCP page.

## Deferred MCP tools

Automatic tool deferral is enabled by default. It activates only when the conversation has more than 10 unresolved MCP tools and the runtime's tool-deferral policy is enabled. Smaller MCP toolsets remain immediately available.

When deferral is active, Elowen advertises a tool by name and a short description instead of placing its complete parameter schema in the prompt. The assistant uses `ToolSearch` to load the schema; the tool becomes callable on the next turn. For an exact tool name, the query is:

```text
ToolSearch({"query":"select:mcp__github__create_issue"})
```

A keyword query can find matching tools, and `mcp__github` can load deferred tools from one server. This reduces prompt size; it does not change server permissions or account access.

The MCP plugin also provides `ListMcpResources` and `ReadMcpResource` for servers that publish resources. These tools are loaded on demand and follow the same server/account visibility rules.

## Timeouts and troubleshooting

The MCP plugin has global timeout settings in its configuration:

- **Connect timeout:** `15000` ms by default; allowed range `5000`–`60000` ms. This covers connecting and discovering tools.
- **Tool call timeout:** `120000` ms by default; allowed range `30000`–`300000` ms.

Open the `mcp` plugin's configuration in **Settings → Plugins** to change these values. The MCP page reports `Connected`, `Disconnected`, `Error`, or `Disabled`, and shows the last error when available.

The current management format is the MCP page, not a manually maintained configuration object. Older instance configurations that stored a top-level `servers` array in the `mcp` plugin's configuration are imported into the managed server list once; review and maintain them from the MCP page afterwards.

## Use Elowen as an MCP server

Elowen also exposes its own tool surface at the stateless `POST /mcp` endpoint. An MCP-compatible client must authenticate with an Elowen bearer token; the exposed tools act with exactly that token's permissions, including its account and plugin access. This endpoint is separate from the external-server bridge described above.

[Next: Configuration](configuration)
