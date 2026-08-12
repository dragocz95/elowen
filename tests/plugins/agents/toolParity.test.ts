import { describe, it, expect } from 'vitest';
import { registerAgentsTools } from '../../../plugins/agents/src/tools.js';
import { buildElowenTools } from '../../../src/brain/tools/index.js';
import { composeSessionTools } from '../../../src/brain/session/capabilities.js';
import type { PluginContext } from '../../../src/plugins/api.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** PROMPT-CACHE PARITY BASELINE for the brain tools that moved into the agents plugin (F2 step 6).
 *  The advertised bytes of a tool (name, description, parameter schema) feed the model's cached prompt
 *  prefix, so they are pinned here EXACTLY as the core built-ins shipped them. Changing any of these
 *  strings invalidates every cached prompt — if that is intended, update the baseline consciously.
 *  The advertised ORDER did change once with the extraction (plugin tools compose after the core
 *  groups); the ordered-set test below makes that position visible and locked. */

const BASELINE = [
  {
    name: 'ElowenListMissions',
    label: 'List missions',
    description: 'List Elowen autopilot missions.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'ElowenListSessions',
    label: 'List sessions',
    description: 'List the running Elowen agent sessions — the background worker/pilot/overseer agents launched in tmux for your projects, each with its role and project. This is NOT the list of CLI chat clients or brain conversations: an empty result means no agent is currently running, not that nobody is connected. Use it to see what agent work is live before spawning more or stopping one.',
    parameters: { type: 'object', properties: {} },
  },
];

function capturedAgentsTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const ctx = {
    registerTool: (t: ToolDefinition) => { tools.push(t); },
    isAdminSession: () => false,
    currentIdentity: () => null,
    host: { stores: () => ({ tasks: { get: () => null } }), tmux: () => ({ list: async () => [] }) },
  } as unknown as PluginContext;
  registerAgentsTools(ctx, () => { throw new Error('runtime must not be touched at registration'); });
  return tools;
}

describe('agents plugin tool parity (prompt cache)', () => {
  it('registers the moved tools byte-identical to the core originals', () => {
    const tools = capturedAgentsTools();
    expect(tools.map((t) => t.name)).toEqual(BASELINE.map((b) => b.name));
    for (const b of BASELINE) {
      const t = tools.find((x) => x.name === b.name)!;
      expect(t.label).toBe(b.label);
      expect(t.description).toBe(b.description);
      // The parameter schema reaches the model as JSON — compare the serialized form, additional
      // typebox symbols/metadata do not travel on the wire.
      expect(JSON.parse(JSON.stringify(t.parameters))).toMatchObject(b.parameters);
    }
  });

  it('refuses outside an admin (owner-chat) session instead of serving control-plane data', async () => {
    for (const t of capturedAgentsTools()) {
      const res = await t.execute('call-1', {}, undefined as never, undefined as never);
      expect(res.content[0]!.text).toContain("only available in the owner's own chat session");
    }
  });

  it('locks the ordered advertised owner-chat tool set (core groups first, plugin tools after)', () => {
    const composed = composeSessionTools({
      kind: 'owner-chat',
      elowenTools: () => buildElowenTools({ url: 'http://x', token: 't' }),
      pluginTools: capturedAgentsTools(),
    } as never);
    expect(composed.map((t) => t.name)).toEqual([
      // Core Elowen control plane + LSP (owner-chat only).
      'ElowenListTasks', 'ElowenCreateTask', 'ElowenUpdateTask', 'ElowenPlan',
      'ElowenGetTask', 'ElowenStopTask', 'ElowenTaskOutput',
      'LspDiagnostics', 'LspGoToDefinition', 'LspFindReferences', 'LspHover', 'LspDocumentSymbol', 'LspWorkspaceSymbol',
      // Plugin tools compose after the core groups — the agents plugin's tools land HERE.
      'ElowenListMissions', 'ElowenListSessions',
      // Owner-chat always carries the plan-mode exit tool last.
      'ExitPlanMode',
    ]);
  });
});
