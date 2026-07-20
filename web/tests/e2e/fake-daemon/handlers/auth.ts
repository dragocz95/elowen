// Auth endpoints the web BFF and LoginGate hit: login (credential check → token), the session probe
// (`/auth/me`), and the fresh-install check (`/setup`). The web proxy is the real auth boundary in this
// harness, so `/auth/me` simply returns the admin — a request only reaches here with the injected bearer.
import type { Hono } from 'hono';
import { ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_TOKEN, TOKEN_TTL_DAYS, adminUser } from '../../seed/fixtures.ts';

export function registerAuthRoutes(app: Hono): void {
  app.post('/auth/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    if (body.username !== ADMIN_USERNAME || body.password !== ADMIN_PASSWORD) {
      return c.json({ error: 'invalid credentials' }, 401);
    }
    return c.json({ token: ADMIN_TOKEN, user: adminUser, tokenTtlDays: TOKEN_TTL_DAYS });
  });

  app.post('/auth/logout', (c) => c.json({ ok: true }));

  app.get('/auth/me', (c) => c.json({ user: adminUser }));

  app.get('/setup', (c) => c.json({ needsSetup: false }));
}
