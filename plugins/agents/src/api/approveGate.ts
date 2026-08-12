import { json, canProject } from './http.js';
import { logger } from '../lib/logger.js';
import type { PluginContext } from '../../../../src/plugins/api.js';
import type { AgentsRuntime } from '../runtime.js';

const log = logger('approve-gate');

/** Human approval of an escalated phase: accept its result and release the review gate it holds,
 *  re-opening only the dependents no OTHER predecessor still gates (mirrors the agent-approved
 *  verdict). The escalations inbox calls this instead of blindly opening every blocked dependent.
 *  ROOT-mounted at the grandfathered POST /tasks/:id/approve-gate; access:'user' keeps agent tokens
 *  out exactly like the core allow-list did (approving a gate is a human act). */
export function registerApproveGateApi(ctx: PluginContext, rt: () => AgentsRuntime): void {
  ctx.registerApiRoute({
    rootMount: '/tasks/:id/approve-gate', path: '', method: 'POST', access: 'user',
    handler: async (req) => {
      if (req.path !== '') return json({ error: 'not found' }, 404);
      const id = req.params['id']!;
      const existing = ctx.host.stores().tasks.get(id);
      if (!existing) return json({ error: 'task not found' }, 404);
      if (!canProject(req.auth, existing.project_id)) return json({ error: 'forbidden' }, 403);
      const r = rt();
      const released = r.review.releaseGatedDependents(id);
      // The escalation froze the whole mission (state 'stalled'); approving here is the human action that
      // un-freezes it. Resume so the released dependents spawn now instead of the mission sitting idle —
      // a stalled mission no longer ticks itself, so without this the approval would release the gate but
      // nothing would ever pick the work up. The phase's parent IS the epic; mission id is `m-<epicId>`.
      if (existing.parent_id) void r.engine.resumeStalled(`m-${existing.parent_id}`).catch((e) => log.error('approve-gate resume failed', e));
      return json({ released });
    },
  });
}
