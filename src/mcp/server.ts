import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CORE_MCP_TOOLS, makeMcpRequest } from './tools.js';
import type { PluginMcpTool } from '../plugins/api.js';

export interface McpDeps {
  url: string;
  token: string;
  /** Plugin-contributed tools from the LIVE registry (PluginContext.registerMcpTool). The /mcp route
   *  resolves the registry per request, so a plugin reload or disable applies to the very next
   *  `tools/list` — there is no cached composition to invalidate. Absent → core tools only. */
  pluginTools?: readonly { plugin: string; tool: PluginMcpTool }[];
}

/** Build an MCP server exposing the Elowen toolset bound to one caller's token: the core tools plus
 *  whatever the enabled plugins contribute.
 *  Every tool delegates to the shared `callElowenApi` core via `makeMcpRequest`, so there is no
 *  request logic here to maintain and a tool can never act with wider rights than its caller. */
function createElowenMcpServer(deps: McpDeps): McpServer {
  const req = makeMcpRequest(deps);
  const server = new McpServer({ name: 'elowen', version: '1.0.0' });
  const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data ?? null, null, 2) }] });

  // Core first, then plugin contributions. Names are a flat namespace: a plugin tool that collides
  // with a core name (or an earlier plugin's — already deduped at registry merge) is skipped, so a
  // plugin can never shadow the core surface a connected agent relies on.
  const seen = new Set<string>();
  for (const tool of [...CORE_MCP_TOOLS, ...(deps.pluginTools ?? []).map((p) => p.tool)]) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (a: Record<string, unknown>) => text(await tool.run(a, req)));
  }
  return server;
}

/** Stateless HTTP handler: a fresh server + transport per request, with the toolset bound to the
 *  request's bearer token, so each advisor connection acts with exactly its user's rights. */
export async function handleMcpRequest(req: Request, deps: McpDeps): Promise<Response> {
  const server = createElowenMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}
