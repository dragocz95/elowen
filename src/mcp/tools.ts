import { z } from 'zod';
import { callElowenApi } from '../shared/apiClient.js';
import type { PluginMcpRequest, PluginMcpTool } from '../plugins/api.js';

/** Connection the MCP toolset binds to — one caller's daemon URL + bearer token. */
export interface ElowenToolDeps { url: string; token: string; call?: typeof callElowenApi }

/** The request core every MCP tool proxies through — the single shared `callElowenApi` path (exactly
 *  the same forward as the `elowen api` CLI verb), bound to the caller's token and throwing on a
 *  non-ok response with the `elowen <status>: …` text agents have always seen. */
export function makeMcpRequest(d: ElowenToolDeps): PluginMcpRequest {
  const call = d.call ?? callElowenApi;
  return async (method, path, body) => {
    const r = await call(method, path, body, { url: d.url, token: d.token });
    if (!r.ok) throw new Error(`elowen ${r.status}: ${r.text || JSON.stringify(r.data)}`);
    return r.data;
  };
}

/** The CORE Elowen MCP toolset: the generic escape hatch, and nothing else. The task/plan tools left
 *  with their owning plugins via `registerMcpTool` — with the owning plugin disabled they vanish from
 *  `tools/list`, which is the correct MCP answer for an absent capability (a tool that would only ever
 *  answer 503 is worse than none: the model reasons around the error instead of the absence). Same declaration shape as a plugin's
 *  ({@link PluginMcpTool}), so the server composes both lists identically. Names, descriptions and
 *  input schemas are pinned by tests/mcp/mcpToolParity.test.ts — spawned agents carry them in their
 *  prompts and habits, so they must never drift. */
export const CORE_MCP_TOOLS: PluginMcpTool[] = [
  {
    name: 'elowen_request',
    description: 'Call any Elowen REST endpoint (full control). Generic escape hatch — every endpoint works without a dedicated tool.',
    inputSchema: { method: z.string(), path: z.string(), body: z.unknown().optional() },
    run: (a, req) => req(a.method as string, a.path as string, a.body),
  },
];
