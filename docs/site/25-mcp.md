---
title: MCP Integration
slug: mcp
order: 25
eyebrow: Extending
group: Extending
---

# MCP Integration

The Model Context Protocol (MCP) lets Elowen connect to external tool servers. A connected server advertises tools such as repository operations, browser automation, or database queries; Elowen bridges those tools into the assistant's toolset.

The `mcp` plugin is enabled by default on a fresh installation. Manage its servers from the **MCP** page in the web app, under **Infrastructure**. See [Plugins](plugins) for general plugin administration.

## Add an external MCP server

1. Open **MCP** under **Infrastructure**.
2. Select **Add server**.
3. Enter a server **Name**. Names may contain letters, numbers, underscores, and dashes, and must be 1–40 characters long.
4. Choose a **Transport**:
   - **stdio** runs a command on the Elowen host.
   - **HTTP** connects to an HTTP or HTTPS MCP endpoint.
   - **SSE** connects to an HTTP or HTTPS server-sent-events endpoint.
5. Choose the **Ownership** scope and fill in the transport-specific fields.
6. Leave **Enabled** on unless you want to save the server without making it available.
7. Select **Save**.

Elowen verifies an enabled server and discovers its tools when you save it. If verification fails, the server is not kept. Use **Reconnect** on an existing server to repeat discovery after fixing the server or its network connection.

### stdio servers

For a stdio server, provide:

- **Command** — the executable to run on the Elowen host.
- **Arguments** — one argument per line.
- **Environment variables** — one `NAME=value` entry per line.

Only an instance administrator can create or start a stdio server because it executes a local process. Add only commands and MCP servers you explicitly trust.

### HTTP and SSE servers

For HTTP or SSE, provide the server's `http://` or `https://` **URL**. These transports do not execute a command on the Elowen host and can be used for a personal server by a signed-in account.

## Ownership and visibility

Every server belongs to one of two scopes:

- **Personal** — available only to the account that owns it. Personal servers require a linked Elowen account. Personal HTTP and SSE servers connect on demand when one of their tools is first used.
- **Instance** — shared with eligible conversations across the Elowen instance. Only an instance administrator can manage instance servers. Enabled instance servers connect when the daemon loads the plugin.

A conversation can use the instance servers and the current account's personal servers. It cannot use another account's personal servers. A server name must be unique within the scopes visible to an account.

Instance and personal servers are managed separately. HTTP and SSE servers can be transferred between the instance scope and the acting account's personal scope; stdio servers cannot be transferred. Create the server again in the target scope if its ownership needs to change.

## Bridged tool names

Each tool discovered from a server is exposed with the name:

```text
mcp__<server>__<tool>
```

For example, a server named `github` might expose `mcp__github__create_issue`. Server and tool names are normalized to lowercase words separated by underscores. The server controls the tool definitions and input schemas; they are displayed read-only in the MCP page.

## Deferred MCP tools

Automatic tool deferral is enabled by default. It activates only when the conversation has more than 10 unresolved MCP tools and the runtime's tool-deferral policy is enabled. Smaller MCP toolsets remain immediately available.

When deferral is active, Elowen advertises a tool by name and a short description instead of placing its complete parameter schema in the prompt. The assistant uses `ToolSearch` to load the schema; the tool becomes callable on the next turn. For an exact tool name, the query is:

```text
ToolSearch({"query":"select:mcp__github__create_issue"})
```

A keyword query can find matching tools, and `mcp__github` can load deferred tools from one server. This behavior reduces prompt size; it does not change the server's permissions or the account's access.

The MCP plugin also provides `ListMcpResources` and `ReadMcpResource` for MCP servers that publish resources. These tools are loaded on demand.

## Timeouts and troubleshooting

The MCP plugin has global timeout settings in the plugin configuration:

- **Connect timeout:** `15000` ms by default; allowed range `5000`–`60000` ms. This covers connecting and discovering tools.
- **Tool call timeout:** `120000` ms by default; allowed range `30000`–`300000` ms.

Open the `mcp` plugin's configuration in **Settings → Plugins** to change these values. A server's status in the MCP page reports `Connected`, `Disconnected`, `Error`, or `Disabled`, and shows the last error when available.

The current management format is the MCP page, not the old `mcpServers` object. Older instance configurations that used a top-level `servers` array are imported into the managed server list once; review and maintain them from the MCP page afterwards.

## Use Elowen as an MCP server

Elowen also exposes its own tool surface at the stateless `POST /mcp` endpoint. An MCP-compatible client must authenticate the request with an Elowen bearer token; the exposed tools act with exactly that token's permissions, including the account and plugin access attached to it. This endpoint is separate from the external-server bridge described above.

[Next: Configuration](configuration)
