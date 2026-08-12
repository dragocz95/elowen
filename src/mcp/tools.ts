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

/** The CORE Elowen MCP toolset: the generic escape hatch plus the task/plan surface the daemon serves
 *  itself. The agents-domain tools (sessions/missions/notes/session control) are contributed by the
 *  agents plugin via `registerMcpTool` — with the plugin disabled they vanish from `tools/list`, which
 *  is the correct MCP answer for an absent capability. Same declaration shape as a plugin's
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
  {
    name: 'elowen_tasks',
    description: 'List all tasks.',
    inputSchema: {},
    run: (_a, req) => req('GET', '/tasks'),
  },
  {
    name: 'elowen_create_task',
    description: 'Create a task.',
    inputSchema: { title: z.string(), project_id: z.number().optional(), description: z.string().optional() },
    run: (a, req) => req('POST', '/tasks', a),
  },
  {
    name: 'elowen_plan',
    description: 'Plan a goal into an epic with phases (autopilot). Supports full planning options: set engage:true to immediately start a mission; autonomy (L0-L3) controls agent freedom; maxSessions controls parallelism; exec overrides the executor; autoModel lets the planner pick per-phase models; dryRun previews phases without persisting; prompt supplies a custom planner prompt; prEnabled (true/false/null) controls PR-native mode.',
    inputSchema: {
      goal: z.string(),
      project_id: z.number().optional(),
      name: z.string().optional(),
      exec: z.string().optional(),
      autoModel: z.boolean().optional(),
      autonomy: z.string().optional(),
      maxSessions: z.number().optional(),
      engage: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      prompt: z.string().optional(),
      prEnabled: z.boolean().nullable().optional(),
    },
    run: (a, req) => req('POST', '/tasks/plan', a),
  },
  {
    name: 'elowen_task_update',
    description: 'Update a task: any of status (open/in_progress/blocked/closed/cancelled), title, type, priority, description, exec override, or deps. Only the fields you pass are changed.',
    inputSchema: {
      id: z.string(),
      status: z.enum(['open', 'in_progress', 'blocked', 'closed', 'cancelled']).optional(),
      title: z.string().optional(),
      type: z.string().optional(),
      priority: z.string().optional(),
      description: z.string().optional(),
      exec: z.string().optional(),
      deps: z.array(z.string()).optional(),
    },
    run: (a, req) => {
      const { id, ...patch } = a;
      return req('PATCH', `/tasks/${encodeURIComponent(id as string)}`, patch);
    },
  },
  {
    name: 'elowen_task_close',
    description: 'Close a task with a verdict: `result_summary` (what was done) and `outcome` (e.g. ok/fail). Drives the post-done overseer review gate for mission phases.',
    inputSchema: { id: z.string(), result_summary: z.string().optional(), outcome: z.string().optional() },
    run: (a, req) => req('PATCH', `/tasks/${encodeURIComponent(a.id as string)}`, { status: 'closed', result_summary: a.result_summary, outcome: a.outcome }),
  },
  {
    name: 'elowen_task_usage',
    description: "Read a task's agent token/cost usage from the executor CLI's local session storage. Null usage means no matching session was found.",
    inputSchema: { id: z.string() },
    run: (a, req) => req('GET', `/tasks/${encodeURIComponent(a.id as string)}/usage`),
  },
];
