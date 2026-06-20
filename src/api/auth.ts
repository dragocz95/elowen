import type { MiddlewareHandler } from 'hono';
import type { UserStore } from '../store/userStore.js';

// Public paths reachable without a token.
function isPublic(method: string, path: string, hasAvatarSig: boolean): boolean {
  if (path === '/health') return true;
  if (path === '/setup') return true; // fresh-install check, reachable before any user exists
  if (method === 'POST' && path === '/auth/login') return true;
  // A signed avatar request (?sig=…) carries its own short-lived HMAC and is validated in the route,
  // so it doesn't need a session token — that's the whole point of finding W2's fix (no token in the
  // <img> URL). Only the signed form is open; the unsigned form still requires a bearer/token.
  if (method === 'GET' && hasAvatarSig && /^\/users\/[^/]+\/avatar$/.test(path)) return true;
  return false;
}

export function authMiddleware(users: UserStore, tokenTtlDays?: () => number): MiddlewareHandler {
  return async (c, next) => {
    if (isPublic(c.req.method, c.req.path, c.req.query('sig') != null)) return next();
    // Setup mode: before the first user is created the daemon is open, so the onboarding page can
    // detect tooling, save config and create the first admin. As soon as one user exists, auth is
    // enforced on every request again.
    if (users.count() === 0) return next();
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const token = bearer ?? c.req.query('token');
    const principal = token ? users.principalForToken(token, tokenTtlDays?.()) : null;
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', principal.user);
    c.set('token', token);
    c.set('tokenScope', principal.scope);
    return next();
  };
}
