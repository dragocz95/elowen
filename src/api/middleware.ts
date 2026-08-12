import { authMiddleware } from './auth.js';
import { classifySession } from '../shared/sessionInfo.js';
import type { ElowenApp, RouteContext } from './context.js';

/** Register the authentication + tenancy guards as global (`*`) middleware. MUST run before any route
 *  family is registered so every handler downstream sees a validated `user`/`tokenScope` and is gated.
 *  No-op without a user store (open/single-user mode keeps the API ungated). */
export function registerAuthGuards(app: ElowenApp, ctx: RouteContext): void {
  const { d } = ctx;
  if (!d.users) return;
  const users = d.users;
  app.use('*', authMiddleware(users, () => d.config.get().security.tokenTtlDays));

  // Capability gate for the agent service token. A spawned worker/overseer/pilot runs with
  // --dangerously-skip-permissions, so a prompt-injected agent must NOT reach the admin surface
  // (users, /config, project register/delete). Allow ONLY the verbs its CLI actually drives:
  //   • close its task        → PATCH /tasks/:id
  //   • submit a plan         → POST  /plan/:jobId/submit  (+ GET /plan/:jobId)
  //   • read-only listings    → GET /tasks, /tasks/ready, /sessions   (elowen ls|ready|sessions)
  //   • ask the autopilot     → POST /tasks/:id/ask, GET /tasks/:id/ask/:askId   (elowen ask)
  //   • read its control guide → GET /tasks/:id/guide   (elowen help)
  // Its task PATCH is field-scoped to status/outcome in the route (close only), not the full patch surface.
  // The human reply (POST /tasks/:id/ask/:askId/reply) is deliberately NOT allowed — an agent must
  // not answer its own question. Project ownership of the affected row is still enforced downstream
  // (canAccessProject etc.), so the agent can't cross tenancy even within the allow-list.
  const agentAllowed = (method: string, path: string): boolean => {
    if (method === 'GET') {
      if (path === '/tasks' || path === '/tasks/ready' || path === '/sessions') return true;
      if (/^\/plan\/[^/]+$/.test(path)) return true;
      if (/^\/tasks\/[^/]+\/ask\/[^/]+$/.test(path)) return true; // long-poll an ask's reply (elowen ask)
      if (/^\/tasks\/[^/]+\/guide$/.test(path)) return true; // fetch the agent control guide (elowen help)
    }
    // Authenticated plugin API surface: pass the scope through — the pluginApi dispatcher then refuses
    // any route that did not declare `access: 'agent'` (deny-by-default stays intact; this only moves
    // the decision to where the declared access level is known).
    if (/^\/plugins\/[^/]+\/api\//.test(path)) return true;
    if (method === 'PATCH' && /^\/tasks\/[^/]+$/.test(path)) return true;
    if (method === 'POST') {
      if (/^\/plan\/[^/]+\/submit$/.test(path)) return true;
      if (/^\/tasks\/[^/]+\/ask$/.test(path)) return true; // post an open question to the autopilot (elowen ask)
    }
    // The overseer poll/decide verbs (GET /missions/:id/overseer/next, POST …/decide) and the handoff
    // notes (GET/POST /notes, elowen note ls|add) are NOT listed here: they are plugin root-mounted
    // routes declared access:'agent', so they pass through the rootApiRoute carve-out below — and
    // degrade explicitly (503) when the agents plugin is disabled.
    return false;
  };
  // Which task a `/tasks/...` request targets, or null when the route carries no task id. `/tasks/ready`
  // is the ready-queue listing, not a task — every other allow-listed `/tasks/<seg>` is an id.
  const targetTask = (path: string): string | null => {
    if (path === '/tasks' || path === '/tasks/ready') return null;
    const m = /^\/tasks\/([^/]+)/.exec(path);
    if (!m?.[1]) return null;
    // A malformed escape (`/tasks/%`) makes decodeURIComponent throw, and throwing HERE would turn an
    // authorisation decision into a 500 on a request an agent can send. The raw segment is no task id,
    // so it simply fails the comparison below and the caller gets its 403.
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  };
  app.use('*', async (c, next) => {
    if (c.get('tokenScope') !== 'agent') return next();
    if (!agentAllowed(c.req.method, c.req.path)) {
      // Root-mounted plugin routes (PluginApiRoute.rootMount): pass through ONLY a route that itself
      // declared access:'agent' — the root dispatcher enforces the same rule again, so this carve-out
      // (the root twin of the /plugins/:name/api/ one above) never widens the deny-by-default gate.
      const match = (await d.plugins?.get().catch(() => undefined))?.rootApiRoute(c.req.path, c.req.method);
      if (!match || match.access !== 'agent') return c.json({ error: 'forbidden' }, 403);
    }
    // A worker is spawned with a token minted for ITS task, so the allow-listed task verbs are pinned
    // to that task: without this, every agent in a project shares one credential and agent A could
    // close/ask-on/read task B (the project gate above can't see an intra-project crossing). A final
    // mission phase legitimately closes its parent epic (see agent-guide-phase), so the epic passes too.
    // An UNBOUND agent token (the shared service token the overseer/pilot run on) keeps the old reach.
    const bound = c.get('agentTask');
    if (bound) {
      const target = targetTask(c.req.path);
      if (target !== null && target !== bound && target !== d.taskRefs?.get(bound)?.parent_id) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }
    return next();
  });

  // Gate the project-scoped surface: a non-admin must be assigned to AT LEAST ONE project to touch
  // tasks/missions/sessions/activity/events/usage. This is only a coarse "has any access" pre-filter —
  // every gated route family then scopes to the caller's accessible projects (accessibleProjects /
  // canAccessProject / the SSE per-subscriber filter), so a user assigned to a non-home project sees
  // exactly that project's data and nothing else. Keying on the daemon's home project would wrongly
  // lock out users assigned only to other registered projects. Admin passes; no userProjects store
  // (single-user mode) is a no-op with full access.
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
      if (u && (up.isAdmin(u.id) || up.forUser(u.id).length > 0)) return next();
      return c.json({ error: 'forbidden' }, 403);
    });
  }
}
