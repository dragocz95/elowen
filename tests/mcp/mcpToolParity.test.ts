import { describe, it, expect } from 'vitest';
import { CORE_MCP_TOOLS } from '../../src/mcp/tools.js';
import { AGENTS_MCP_TOOLS } from '../../plugins/agents/src/mcpTools.js';
import type { PluginMcpTool } from '../../src/plugins/api.js';

/** Golden pin of the daemon /mcp tool surface (batch 3b split: core in src/mcp/tools.ts, the agents
 *  dozen in plugins/agents/src/mcpTools.ts). Spawned agents carry these tool names, descriptions and
 *  argument shapes in their prompts and habits, so ANY drift — a rename, a reworded description, a
 *  changed/removed argument, a reorder — must fail here and be a deliberate decision, never a side
 *  effect of a refactor. Each line is `name :: args (?, in declaration order) :: description`. */
const shape = (t: PluginMcpTool): string => {
  const args = Object.entries(t.inputSchema).map(([k, v]) => (v.isOptional() ? `${k}?` : k)).join(',');
  return `${t.name} :: ${args || '-'} :: ${t.description}`;
};

describe('daemon /mcp tool surface parity (core + agents plugin)', () => {
  it('core tools match the pinned ordered surface', () => {
    expect(CORE_MCP_TOOLS.map(shape)).toEqual([
      'elowen_request :: method,path,body? :: Call any Elowen REST endpoint (full control). Generic escape hatch — every endpoint works without a dedicated tool.',
      'elowen_tasks :: - :: List all tasks.',
      'elowen_create_task :: title,project_id?,description? :: Create a task.',
      'elowen_plan :: goal,project_id?,name?,exec?,autoModel?,autonomy?,maxSessions?,engage?,dryRun?,prompt?,prEnabled? :: Plan a goal into an epic with phases (autopilot). Supports full planning options: set engage:true to immediately start a mission; autonomy (L0-L3) controls agent freedom; maxSessions controls parallelism; exec overrides the executor; autoModel lets the planner pick per-phase models; dryRun previews phases without persisting; prompt supplies a custom planner prompt; prEnabled (true/false/null) controls PR-native mode.',
      'elowen_task_update :: id,status?,title?,type?,priority?,description?,exec?,deps? :: Update a task: any of status (open/in_progress/blocked/closed/cancelled), title, type, priority, description, exec override, or deps. Only the fields you pass are changed.',
      'elowen_task_close :: id,result_summary?,outcome? :: Close a task with a verdict: `result_summary` (what was done) and `outcome` (e.g. ok/fail). Drives the post-done overseer review gate for mission phases.',
      "elowen_task_usage :: id :: Read a task's agent token/cost usage from the executor CLI's local session storage. Null usage means no matching session was found.",
    ]);
  });

  it('agents plugin tools match the pinned ordered surface', () => {
    expect(AGENTS_MCP_TOOLS.map(shape)).toEqual([
      'elowen_sessions :: - :: List live agent sessions.',
      'elowen_note_add :: target,body :: Leave a handoff note for later agents working the same mission. `target` is the epic id.',
      "elowen_notes :: target :: Read a mission's handoff notes left by earlier phases (oldest-first). `target` is the epic id.",
      'elowen_missions :: - :: List live missions (plus disengaged ones with a pending PR), each with its PR info.',
      'elowen_mission_engage :: epicId,autonomy?,maxSessions? :: Engage the autopilot on an epic: spawn a mission that drives its phases to completion. `epicId` is required; autonomy (e.g. L0..L3) and maxSessions default server-side.',
      'elowen_mission_pause :: id :: Pause a running mission: kill its running agents, revert their tasks, then mark it paused. `id` is the mission id (e.g. `m-<epicId>`).',
      'elowen_mission_resume :: id :: Resume a paused mission: flip it active, re-park the overseer, then tick. `id` is the mission id.',
      'elowen_mission_disengage :: id :: Disengage (stop) a mission entirely, tearing down its agents. `id` is the mission id.',
      'elowen_session_spawn :: taskId,exec? :: Manually launch a worker agent for a task in a fresh tmux session. `taskId` is required; `exec` optionally overrides the executor (must be allowed).',
      'elowen_session_kill :: name :: Kill a live tmux session by name (e.g. `elowen-<task>`).',
      'elowen_session_send_keys :: name,keys :: Send key tokens to a session via tmux send-keys. `keys` is a non-empty array of plain tokens (e.g. ["Enter"], ["h","i"]); leading-dash tokens are rejected.',
      "elowen_session_read_pane :: name,ansi? :: Capture the last ~60 lines of a session's pane. Set `ansi` to keep colour/escape codes; otherwise plain text.",
    ]);
  });

  it('the composed surface stays 19 unique names with no core/plugin collision', () => {
    const names = [...CORE_MCP_TOOLS, ...AGENTS_MCP_TOOLS].map((t) => t.name);
    expect(names).toHaveLength(19);
    expect(new Set(names).size).toBe(19);
  });

  it('every agents MCP tool is declared in the manifest provides.mcpTools (deny-by-default)', async () => {
    const manifest = (await import('../../plugins/agents/elowen-plugin.json', { with: { type: 'json' } })).default as { provides?: { mcpTools?: string[] } };
    expect(manifest.provides?.mcpTools).toEqual(AGENTS_MCP_TOOLS.map((t) => t.name));
  });
});
