import { parseBody } from '../validation.js';
import { advisorStartSchema } from '../schemas/advisor.js';
import type { OrcaApp, RouteContext } from '../context.js';

/** Per-user advisor lifecycle (status/start/stop). Full-scope callers only — a spawned agent must not
 *  start or stop a human's advisor; each route acts on the caller's own `orca-advisor-<userId>`. */
export function registerAdvisorRoutes(app: OrcaApp, ctx: RouteContext): void {
  const { d } = ctx;
  // Per-user advisor lifecycle. Full-scope (non-agent) callers only — a spawned agent must not be able
  // to start/stop a human's advisor. Each acts on the caller's own session (`orca-advisor-<userId>`).
  app.get('/advisor/status', async c => {
    if (!d.advisor) return c.json({ running: false, exec: '', session: null });
    if (c.get('tokenScope') === 'agent') return c.json({ error: 'forbidden' }, 403);
    return c.json(await d.advisor.status(c.get('user').id));
  });
  app.post('/advisor/start', async c => {
    if (!d.advisor) return c.json({ error: 'advisor unavailable' }, 503);
    if (c.get('tokenScope') === 'agent') return c.json({ error: 'forbidden' }, 403);
    const { exec } = await parseBody(c, advisorStartSchema);
    try { return c.json(await d.advisor.start(c.get('user').id, exec), 201); }
    catch (e) {
      // A permission rejection is the user's fault (403); a spawn/tmux failure is ours (500).
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg === 'exec not allowed for user' ? 403 : 500);
    }
  });
  app.post('/advisor/stop', async c => {
    if (!d.advisor) return c.json({ ok: true });
    if (c.get('tokenScope') === 'agent') return c.json({ error: 'forbidden' }, 403);
    await d.advisor.stop(c.get('user').id);
    return c.json({ ok: true });
  });
}
