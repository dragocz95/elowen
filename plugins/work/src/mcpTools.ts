import { z } from 'zod';
import type { PluginMcpTool } from '../../../src/plugins/api.js';

/** The task-domain tools of the daemon's OWN /mcp server, moved out of the core toolset with the
 *  domain: every route they proxy (/tasks, /tasks/plan, /tasks/:id/usage) belongs to this plugin, so
 *  with it disabled they vanish from `tools/list` instead of failing at call time. Names, descriptions
 *  and input schemas are BYTE-IDENTICAL to the pre-extraction core registrations — spawned agents carry
 *  them in their prompts and habits — and are pinned by tests/mcp/mcpToolParity.test.ts. Handlers are
 *  pure REST proxies over the caller-bound request fn, so registering them never touches the stores. */
export const WORK_MCP_TOOLS: PluginMcpTool[] = [
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
