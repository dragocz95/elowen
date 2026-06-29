import { authMiddleware } from './auth.js';
import { classifySession } from '../overseer/sessionInfo.js';
import type { OrcaApp, RouteContext } from './context.js';

/** Register the authentication + tenancy guards as global (`*`) middleware. MUST run before any route
 *  family is registered so every handler downstream sees a validated `user`/`tokenScope` and is gated.
 *  No-op without a user store (open/single-user mode keeps the API ungated). */
export function registerAuthGuards(app: OrcaApp, ctx: RouteContext): void {
  const { d } = ctx;
  if (!d.users) return;
  const users = d.users;
  app.use('*', authMiddleware(users, () => d.config.get().security.tokenTtlDays));

  // Capability gate for the agent service token. A spawned worker/overseer/pilot runs with
  // --dangerously-skip-permissions, so a prompt-injected agent must NOT reach the admin surface
  // (users, /config, project register/delete). Allow ONLY the verbs its CLI actually drives:
  //   • close its task        → PATCH /tasks/:id
  //   • submit a plan         → POST  /plan/:jobId/submit  (+ GET /plan/:jobId)
  //   • overseer poll/decide  → GET /missions/:id/overseer/next, POST /missions/:id/overseer/decide
  //   • read-only listings    → GET /tasks, /tasks/ready, /sessions   (orca ls|ready|sessions)
  //   • ask the autopilot     → POST /tasks/:id/ask, GET /tasks/:id/ask/:askId   (orca ask)
  // The human reply (POST /tasks/:id/ask/:askId/reply) is deliberately NOT allowed — an agent must
  // not answer its own question. Project ownership of the affected row is still enforced downstream
  // (canAccessProject etc.), so the agent can't cross tenancy even within the allow-list.
  const agentAllowed = (method: string, path: string): boolean => {
    if (method === 'GET') {
      if (path === '/tasks' || path === '/tasks/ready' || path === '/sessions') return true;
      if (path === '/notes') return true; // read a mission's handoff notes (orca note ls)
      if (/^\/plan\/[^/]+$/.test(path)) return true;
      if (/^\/missions\/[^/]+\/overseer\/next$/.test(path)) return true;
      if (/^\/tasks\/[^/]+\/ask\/[^/]+$/.test(path)) return true; // long-poll an ask's reply (orca ask)
    }
    if (method === 'PATCH' && /^\/tasks\/[^/]+$/.test(path)) return true;
    if (method === 'POST') {
      if (path === '/notes') return true; // leave a handoff note for later phases (orca note add)
      if (/^\/plan\/[^/]+\/submit$/.test(path)) return true;
      if (/^\/missions\/[^/]+\/overseer\/decide$/.test(path)) return true;
      if (/^\/tasks\/[^/]+\/ask$/.test(path)) return true; // post an open question to the autopilot (orca ask)
    }
    return false;
  };
  app.use('*', async (c, next) => {
    if (c.get('tokenScope') !== 'agent') return next();
    if (!agentAllowed(c.req.method, c.req.path)) return c.json({ error: 'forbidden' }, 403);
    return next();
  });

  // Gate the project-scoped surface: a non-admin must be assigned to the daemon's project to
  // touch its tasks/missions/sessions. Admin passes (canAccess checks is_admin). Without a
  // userProjects store this is a no-op (single-user mode keeps full access).
  if (d.userProjects) {
    const up = d.userProjects;
    // Every route family that exposes the daemon's project data — including the activity log and
    // the live SSE event stream, which carry task/mission ids + statuses. Boundary-matched so
    // '/tasksfoo' can't sneak past '/tasks'.
    const GATED = ['/tasks', '/missions', '/sessions', '/activity', '/events', '/usage'];
    app.use('*', async (c, next) => {
      const p = c.req.path;
      if (!GATED.some((g) => p === g || p.startsWith(g + '/'))) return next();
      // An advisor session is per-user, not project-scoped: its access is governed by ownership in
      // the route's own sessionAccessible check, so the project gate must not pre-empt it (the user
      // need not be assigned to the daemon's project to reach their own advisor).
      const sess = p.match(/^\/sessions\/([^/]+)/);
      if (sess?.[1] && classifySession(decodeURIComponent(sess[1])).role === 'advisor') return next();
      if (users.count() === 0) return next(); // setup mode — no users to gate yet
      const u = c.get('user');
      if (u && up.canAccess(u.id, d.project.id)) return next();
      return c.json({ error: 'forbidden' }, 403);
    });
  }
}
