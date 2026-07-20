// Auth endpoints the web BFF and LoginGate hit: login (credential check → token), the session probe
// (`/auth/me`), and the fresh-install check (`/setup`). The server's global auth gate (server.ts) has
// already enforced access before these run, so `/auth/me` only needs to shape the principal: the admin
// when a valid bearer is present, otherwise null — the real daemon returns `{ user: c.get('user') }`,
// which is undefined in setup mode (guard passes through with no user), and the gate opens the shell on
// that 200 so the root page's fresh-install check can route to onboarding.
import type { Hono } from 'hono';
import { ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_TOKEN, TOKEN_TTL_DAYS, adminUser } from '../../seed/fixtures.ts';
import { needsSetup, addUser, listUsers } from '../setup.ts';

/** True when the request carries the admin bearer the BFF injects from the session cookie. */
function isAuthed(authorization: string | undefined): boolean {
  return authorization === `Bearer ${ADMIN_TOKEN}`;
}

export function registerAuthRoutes(app: Hono): void {
  app.post('/auth/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    if (body.username !== ADMIN_USERNAME || body.password !== ADMIN_PASSWORD) {
      return c.json({ error: 'invalid credentials' }, 401);
    }
    return c.json({ token: ADMIN_TOKEN, user: adminUser, tokenTtlDays: TOKEN_TTL_DAYS });
  });

  app.post('/auth/logout', (c) => c.json({ ok: true }));

  app.get('/auth/me', (c) => c.json({ user: isAuthed(c.req.header('authorization')) ? adminUser : null }));

  // Fresh-install probe: reports the setup-lane state (true only while setup mode is armed AND no admin
  // exists yet). Default (no lane armed) → false, exactly as before.
  app.get('/setup', (c) => c.json({ needsSetup: needsSetup() }));

  // The onboarding directory + bootstrap-admin create, open during setup (no users yet) like the real
  // route. Creating the first user flips `needsSetup` false — the moment auth re-engages upstream.
  app.get('/users', (c) => c.json(listUsers()));
  app.post('/users', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown };
    const username = typeof body.username === 'string' ? body.username : '';
    return c.json(addUser(username), 201);
  });
}
