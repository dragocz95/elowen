import type { MiddlewareHandler } from 'hono';
import type { UserStore } from '../store/userStore.js';

// Public paths reachable without a token.
function isPublic(method: string, path: string): boolean {
  if (path === '/health') return true;
  if (path === '/setup') return true; // fresh-install check, reachable before any user exists
  if (method === 'POST' && path === '/auth/login') return true;
  return false;
}

export function authMiddleware(users: UserStore): MiddlewareHandler {
  return async (c, next) => {
    if (isPublic(c.req.method, c.req.path)) return next();
    // Setup mode: before the first user is created the daemon is open, so the onboarding page can
    // detect tooling, save config and create the first admin. As soon as one user exists, auth is
    // enforced on every request again.
    if (users.count() === 0) return next();
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const token = bearer ?? c.req.query('token');
    const user = token ? users.userForToken(token) : null;
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', user);
    c.set('token', token);
    return next();
  };
}
