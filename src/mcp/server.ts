import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { makeOrcaTools } from './tools.js';

export interface McpDeps { url: string; token: string }

/** Build an MCP server exposing the Orca toolset bound to one caller's token. Every tool delegates to
 *  `makeOrcaTools` → the shared `callOrcaApi` core, so there is no request logic here to maintain. */
function createOrcaMcpServer(deps: McpDeps): McpServer {
  const tools = makeOrcaTools(deps);
  const server = new McpServer({ name: 'orca', version: '1.0.0' });
  const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data ?? null, null, 2) }] });

  server.registerTool('orca_request', {
    description: 'Call any Orca REST endpoint (full control). Generic escape hatch — every endpoint works without a dedicated tool.',
    inputSchema: { method: z.string(), path: z.string(), body: z.unknown().optional() },
  }, async (a) => text(await tools.orca_request({ method: a.method, path: a.path, body: a.body })));

  server.registerTool('orca_tasks', { description: 'List all tasks.', inputSchema: {} }, async () => text(await tools.orca_tasks()));

  server.registerTool('orca_create_task', {
    description: 'Create a task.',
    inputSchema: { title: z.string(), project_id: z.number().optional(), description: z.string().optional() },
  }, async (a) => text(await tools.orca_create_task(a)));

  server.registerTool('orca_plan', {
    description: 'Plan a goal into an epic with phases (autopilot).',
    inputSchema: { goal: z.string(), project_id: z.number().optional() },
  }, async (a) => text(await tools.orca_plan(a)));

  server.registerTool('orca_sessions', { description: 'List live agent sessions.', inputSchema: {} }, async () => text(await tools.orca_sessions()));

  return server;
}

/** Stateless HTTP handler: a fresh server + transport per request, with the toolset bound to the
 *  request's bearer token, so each advisor connection acts with exactly its user's rights. */
export async function handleMcpRequest(req: Request, deps: McpDeps): Promise<Response> {
  const server = createOrcaMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}
