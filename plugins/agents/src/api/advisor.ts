import { z } from 'zod';
import { json } from './http.js';
import type { PluginContext } from '../../../../src/plugins/api.js';
import type { AgentsRuntime } from '../runtime.js';

/** Start the caller's advisor with a chosen executor (the allow-list check happens in advisor.start). */
const advisorStartSchema = z.object({ exec: z.string().min(1) });

/** Per-user tmux-advisor lifecycle (status/start/stop), ROOT-mounted at the grandfathered '/advisor'
 *  paths. access:'user' — the dispatcher already refuses an agent service token for a non-agent route,
 *  which is exactly the old core guard (a spawned agent must not start/stop a human's advisor). Each
 *  route acts on the CALLER's own `elowen-advisor-<userId>`. With the plugin disabled the declared
 *  mount answers the explicit 503. */
export function registerAdvisorApi(ctx: PluginContext, rt: () => AgentsRuntime): void {
  ctx.registerApiRoute({
    rootMount: '/advisor', path: '', method: 'GET', access: 'user',
    handler: async (req) => {
      if (req.path !== 'status') return json({ error: 'not found' }, 404);
      const advisor = rt().advisor();
      if (!advisor || req.auth.userId === null) return json({ running: false, exec: '', session: null });
      return json(await advisor.status(req.auth.userId));
    },
  });
  ctx.registerApiRoute({
    rootMount: '/advisor', path: '', method: 'POST', access: 'user',
    handler: async (req) => {
      const advisor = rt().advisor();
      if (req.path === 'start') {
        if (!advisor || req.auth.userId === null) return json({ error: 'advisor unavailable' }, 503);
        const { exec } = advisorStartSchema.parse(await req.json());
        try { return json(await advisor.start(req.auth.userId, exec), 201); }
        catch (e) {
          // A permission rejection is the user's fault (403); a spawn/tmux failure is ours (500).
          const msg = (e as Error).message;
          return json({ error: msg }, msg === 'exec not allowed for user' ? 403 : 500);
        }
      }
      if (req.path === 'stop') {
        if (!advisor || req.auth.userId === null) return json({ ok: true });
        await advisor.stop(req.auth.userId);
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    },
  });
}
