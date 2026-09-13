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

  // Gate project-scoped aggregate reads: a non-admin must be assigned to at least one project to touch
  // activity/usage. `/events` is intentionally absent: its own per-subscriber filter withholds every
  // project event from an account with an empty assignment set while still delivering that account's
  // memory nudges and safe instance-wide plugin/activity invalidations. Rejecting the stream itself made
  // EventSource reconnect forever after impersonating an unassigned account.
  if (d.userProjects) {
    const up = d.userProjects;
    // Every core route family that exposes project data. Boundary-matched so a prefix collision cannot
    // sneak past the guard.
    const GATED = ['/activity', '/usage'];
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
