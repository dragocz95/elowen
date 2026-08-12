import { z } from 'zod';
import type { PluginMcpTool } from '../../../src/plugins/api.js';

/** The agents-domain tools of the daemon's OWN /mcp server, moved out of the core toolset with the
 *  subsystem (batch 3b): every route they proxy (/sessions, /missions, /notes) is a plugin root mount,
 *  so with the plugin disabled the tools vanish from `tools/list` instead of failing at call time.
 *  Names, descriptions and input schemas are BYTE-IDENTICAL to the pre-extraction core registrations —
 *  spawned agents carry them in their prompts and habits — and are pinned by
 *  tests/mcp/mcpToolParity.test.ts. Handlers are pure REST proxies over the caller-bound request fn,
 *  so registering them never constructs the plugin runtime (safe in the sub-agent runner too). */
export const AGENTS_MCP_TOOLS: PluginMcpTool[] = [
  {
    name: 'elowen_sessions',
    description: 'List live agent sessions.',
    inputSchema: {},
    run: (_a, req) => req('GET', '/sessions'),
  },
  {
    name: 'elowen_note_add',
    description: 'Leave a handoff note for later agents working the same mission. `target` is the epic id.',
    inputSchema: { target: z.string(), body: z.string() },
    run: (a, req) => req('POST', '/notes', { scope: 'mission', target: a.target, body: a.body }),
  },
  {
    name: 'elowen_notes',
    description: "Read a mission's handoff notes left by earlier phases (oldest-first). `target` is the epic id.",
    inputSchema: { target: z.string() },
    run: (a, req) => req('GET', `/notes?scope=mission&target=${encodeURIComponent(a.target as string)}`),
  },
  // ---- Mission lifecycle ----
  {
    name: 'elowen_missions',
    description: 'List live missions (plus disengaged ones with a pending PR), each with its PR info.',
    inputSchema: {},
    run: (_a, req) => req('GET', '/missions'),
  },
  {
    name: 'elowen_mission_engage',
    description: 'Engage the autopilot on an epic: spawn a mission that drives its phases to completion. `epicId` is required; autonomy (e.g. L0..L3) and maxSessions default server-side.',
    inputSchema: { epicId: z.string(), autonomy: z.string().optional(), maxSessions: z.number().optional() },
    run: (a, req) => req('POST', '/missions', a),
  },
  {
    name: 'elowen_mission_pause',
    description: 'Pause a running mission: kill its running agents, revert their tasks, then mark it paused. `id` is the mission id (e.g. `m-<epicId>`).',
    inputSchema: { id: z.string() },
    run: (a, req) => req('PATCH', `/missions/${encodeURIComponent(a.id as string)}`, { action: 'pause' }),
  },
  {
    name: 'elowen_mission_resume',
    description: 'Resume a paused mission: flip it active, re-park the overseer, then tick. `id` is the mission id.',
    inputSchema: { id: z.string() },
    run: (a, req) => req('PATCH', `/missions/${encodeURIComponent(a.id as string)}`, { action: 'resume' }),
  },
  {
    name: 'elowen_mission_disengage',
    description: 'Disengage (stop) a mission entirely, tearing down its agents. `id` is the mission id.',
    inputSchema: { id: z.string() },
    run: (a, req) => req('DELETE', `/missions/${encodeURIComponent(a.id as string)}`),
  },
  // ---- Live session control ----
  {
    name: 'elowen_session_spawn',
    description: 'Manually launch a worker agent for a task in a fresh tmux session. `taskId` is required; `exec` optionally overrides the executor (must be allowed).',
    inputSchema: { taskId: z.string(), exec: z.string().optional() },
    run: (a, req) => req('POST', '/sessions', a),
  },
  {
    name: 'elowen_session_kill',
    description: 'Kill a live tmux session by name (e.g. `elowen-<task>`).',
    inputSchema: { name: z.string() },
    run: (a, req) => req('DELETE', `/sessions/${encodeURIComponent(a.name as string)}`),
  },
  {
    name: 'elowen_session_send_keys',
    description: 'Send key tokens to a session via tmux send-keys. `keys` is a non-empty array of plain tokens (e.g. ["Enter"], ["h","i"]); leading-dash tokens are rejected.',
    inputSchema: { name: z.string(), keys: z.array(z.string()) },
    run: (a, req) => req('POST', `/sessions/${encodeURIComponent(a.name as string)}/keys`, { keys: a.keys }),
  },
  {
    name: 'elowen_session_read_pane',
    description: "Capture the last ~60 lines of a session's pane. Set `ansi` to keep colour/escape codes; otherwise plain text.",
    inputSchema: { name: z.string(), ansi: z.boolean().optional() },
    run: (a, req) => req('GET', `/sessions/${encodeURIComponent(a.name as string)}/pane${a.ansi ? '?ansi=1' : ''}`),
  },
];
