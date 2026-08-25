import { authMiddleware } from './auth.js';
import type { ElowenApp, RouteContext } from './context.js';

/** Register the authentication + tenancy guards as global (`*`) middleware. MUST run before any route
 *  family is registered so every handler downstream sees a validated `user`/`tokenScope` and is gated.
 *  No-op without a user store (open/single-user mode keeps the API ungated). */
export function registerAuthGuards(app: ElowenApp, ctx: RouteContext): void {
  const { d } = ctx;
  if (!d.users) return;
  const users = d.users;
  app.use('*', authMiddleware(users, () => d.config.get().security.tokenTtlDays));

  // Gate the project-scoped surface: a non-admin must be assigned to AT LEAST ONE project to touch
  // activity/events/usage. This is only a coarse "has any access" pre-filter —
  // every gated route family then scopes to the caller's accessible projects (accessibleProjects /
  // canAccessProject / the SSE per-subscriber filter), so a user assigned to a non-home project sees
  // exactly that project's data and nothing else. Keying on the daemon's home project would wrongly
  // lock out users assigned only to other registered projects. Admin passes; no userProjects store
  // (single-user mode) is a no-op with full access.
  if (d.userProjects) {
    const up = d.userProjects;
    // Every core route family that exposes project data. Boundary-matched so a prefix collision cannot
    // sneak past the guard.
    const GATED = ['/activity', '/events', '/usage'];
    app.use('*', async (c, next) => {
      const p = c.req.path;
      if (!GATED.some((g) => p === g || p.startsWith(g + '/'))) return next();
      if (users.count() === 0) return next(); // setup mode — no users to gate yet
      const u = c.get('user');
      if (u && (up.isAdmin(u.id) || up.forUser(u.id).length > 0)) return next();
      return c.json({ error: 'forbidden' }, 403);
    });
  }
}
