import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { missionsListPayload } from './api/missions.js';
import { sessionsListPayload } from './api/sessions.js';
import type { ApiAuth } from './api/http.js';
import type { PluginContext } from '../../../src/plugins/api.js';
import type { AgentsRuntime } from './runtime.js';

/** The subsystem's brain tools — ElowenListMissions + ElowenListSessions, moved out of the core
 *  Elowen* control plane (src/brain/tools) with byte-identical names, labels, descriptions and
 *  parameter schemas so a prompt cache sees the same tool bytes (only the advertised ORDER changed,
 *  a one-time invalidation the extraction plan accepts).
 *
 *  Two deliberate differences from the core originals:
 *  - They execute IN-PROCESS against the plugin runtime instead of a localhost REST round-trip (the
 *    host's service token is agent-scoped and may not read '/missions'), serving the exact payload the
 *    corresponding GET routes return.
 *  - As plugin tools they are COMPOSED into every session kind (the platform composes plugin tools
 *    everywhere and gates at execute time), where the core built-ins were owner-chat-only by
 *    construction. The execute-time isAdminSession() gate below restores the same boundary: a channel
 *    or task-worker turn gets a refusal, never the owner's control-plane data. */
export function registerAgentsTools(ctx: PluginContext, rt: () => AgentsRuntime): void {
  // The all-access view the owner-chat REST calls carried (the owner's advisor token is an admin user
  // token): unrestricted tenancy, keyed to the operator's account when the turn resolves one.
  const auth = (): ApiAuth => ({
    userId: ctx.currentIdentity()?.elowenUserId ?? null,
    admin: true,
    tokenScope: 'user',
    agentTask: null,
    accessibleProjects: null,
  });
  const refusal = { content: [{ type: 'text' as const, text: 'This tool is only available in the owner\'s own chat session.' }], details: {} };

  ctx.registerTool(defineTool({
    name: 'ElowenListMissions', label: 'List missions',
    description: 'List Elowen autopilot missions.',
    parameters: Type.Object({}),
    execute: async () => {
      if (!ctx.isAdminSession()) return refusal;
      return { content: [{ type: 'text' as const, text: JSON.stringify(missionsListPayload(rt(), ctx.host.stores().tasks, auth())) }], details: {} };
    },
  }));

  ctx.registerTool(defineTool({
    name: 'ElowenListSessions', label: 'List sessions',
    description: 'List the running Elowen agent sessions — the background worker/pilot/overseer agents launched in tmux for your projects, each with its role and project. This is NOT the list of CLI chat clients or brain conversations: an empty result means no agent is currently running, not that nobody is connected. Use it to see what agent work is live before spawning more or stopping one.',
    parameters: Type.Object({}),
    execute: async () => {
      if (!ctx.isAdminSession()) return refusal;
      return { content: [{ type: 'text' as const, text: JSON.stringify(await sessionsListPayload(ctx.host.tmux(), rt, auth())) }], details: {} };
    },
  }));
}
