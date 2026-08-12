import { describe, it, expect } from 'vitest';
import { registerAgentsTools } from '../../../plugins/agents/src/tools.js';
import { registerWorkTools } from '../../../plugins/work/src/tools.js';
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

type FakeAccess = { owner: boolean; admin: boolean; projectIds: number[] };
const CHANNEL_ADMIN: FakeAccess = { owner: false, admin: true, projectIds: [] };

function capturedAgentsTools(access: FakeAccess = CHANNEL_ADMIN, rt?: () => unknown): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const ctx = {
    registerTool: (t: ToolDefinition) => { tools.push(t); },
    // Present but deliberately UNUSED by the gate: admin scope is not owner truth (see below).
    isAdminSession: () => access.admin,
    currentAccess: () => ({ ...access, permissionBoundary: null }),
    currentIdentity: () => null,
    host: { stores: () => ({ tasks: { get: () => ({ project_id: 1 }) } }), tmux: () => ({ list: async () => [] }) },
  } as unknown as PluginContext;
  registerAgentsTools(ctx, (rt ?? (() => { throw new Error('runtime must not be touched at registration'); })) as never);
  return tools;
}

/** Minimal runtime the mission listing reads: two missions in different projects, no PRs. */
function fakeRuntime(): unknown {
  return {
    missions: {
      live: () => [{ id: 'm-a', epic_id: 'a' }, { id: 'm-b', epic_id: 'b' }],
      get: () => null,
    },
    missionGit: { pendingPrMissionIds: () => [], prInfo: () => null },
  };
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

  it('refuses a platform admin who is not the owner instead of serving control-plane data', async () => {
    // The Discord-moderator case: admin project scope WITHOUT owner truth. Gating on isAdminSession()
    // would serve them the operator's missions; the owner gate refuses.
    for (const t of capturedAgentsTools(CHANNEL_ADMIN, fakeRuntime)) {
      const res = await t.execute('call-1', {}, undefined as never, undefined as never);
      expect(res.content[0]!.text).toContain("only available in the owner's own chat session");
    }
  });

  it("admits the owner's own sub-agent, which READ_ONLY_AGENT_TOOLS lists these tools for", async () => {
    // A read-only child inherits owner but is not an admin chat session — the case the isAdminSession()
    // gate advertised two permanently-refusing tools to.
    const owned = { owner: true, admin: true, projectIds: [] };
    const [missions] = capturedAgentsTools(owned, fakeRuntime);
    const res = await missions!.execute('call-1', {}, undefined as never, undefined as never);
    expect(res.content[0]!.text).not.toContain('only available');
    expect(JSON.parse(res.content[0]!.text as string)).toHaveLength(2);
  });

  it('scopes the listing to a project-restricted owner child rather than the whole estate', async () => {
    // tasks.get() answers project_id 1 for every epic, so a child scoped to project 2 must see none.
    const scoped = { owner: true, admin: false, projectIds: [2] };
    const [missions] = capturedAgentsTools(scoped, fakeRuntime);
    const res = await missions!.execute('call-1', {}, undefined as never, undefined as never);
    expect(JSON.parse(res.content[0]!.text as string)).toEqual([]);
  });

  it('locks the ordered advertised owner-chat tool set (plugins load alphabetically: agents, then work)', () => {
    // The whole Elowen* control plane is plugin-owned now, so this order is the LOAD order of the
    // plugins rather than a core group boundary — pinned here because it is what a cached prompt
    // prefix sees.
    const workTools: ToolDefinition[] = [];
    registerWorkTools({
      registerTool: (t: ToolDefinition) => { workTools.push(t); },
      currentAccess: () => ({ owner: true, admin: true, projectIds: [], permissionBoundary: null }),
      currentIdentity: () => ({ elowenUserId: 1 }),
      host: { elowenCli: () => ({ url: 'http://x', tokenForUser: () => 't' }) },
    } as unknown as PluginContext);
    const composed = composeSessionTools({
      kind: 'owner-chat',
      pluginTools: [...capturedAgentsTools(), ...workTools],
    } as never);
    expect(composed.map((t) => t.name)).toEqual([
      // The agents plugin's tools.
      'ElowenListMissions', 'ElowenListSessions',
      // The work plugin's task control plane.
      'ElowenListTasks', 'ElowenCreateTask', 'ElowenUpdateTask', 'ElowenPlan',
      'ElowenGetTask', 'ElowenStopTask', 'ElowenTaskOutput',
      // Owner-chat always carries the plan-mode exit tool last.
      'ExitPlanMode',
    ]);
  });
});
