// Auth endpoints the web BFF and LoginGate hit: login (credential check → token), the session probe
// (`/auth/me`), and the fresh-install check (`/setup`). The server's global auth gate (server.ts) has
// already enforced access before these run, so `/auth/me` only needs to shape the principal: the admin
// when a valid bearer is present, otherwise null — the real daemon returns `{ user: c.get('user') }`,
// which is undefined in setup mode (guard passes through with no user), and the gate opens the shell on
// that 200 so the root page's fresh-install check can route to onboarding.
import type { Hono } from 'hono';
import { ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_TOKEN, TARGET_TOKEN, IMPERSONATION_RETURN_CODE, TOKEN_TTL_DAYS, adminUser, targetUser } from '../../seed/fixtures.ts';
import { needsSetup, addUser, listUsers } from '../setup.ts';
import { getResponse } from '../overrides.ts';

function principal(authorization: string | undefined) {
  if (authorization === `Bearer ${ADMIN_TOKEN}`) return adminUser;
  if (authorization === `Bearer ${TARGET_TOKEN}`) return targetUser;
  return null;
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

  app.get('/auth/me', (c) => c.json({ user: principal(c.req.header('authorization')) }));

  app.post('/users/:id/impersonate', (c) => {
    if (principal(c.req.header('authorization'))?.id !== adminUser.id) return c.json({ error: 'forbidden' }, 403);
    if (Number(c.req.param('id')) !== targetUser.id) return c.json({ error: 'user not found' }, 404);
    return c.json({ token: TARGET_TOKEN, returnCode: IMPERSONATION_RETURN_CODE, user: targetUser, tokenTtlDays: TOKEN_TTL_DAYS });
  });

  app.post('/auth/impersonation/stop', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { returnCode?: unknown };
    if (principal(c.req.header('authorization'))?.id !== targetUser.id || body.returnCode !== IMPERSONATION_RETURN_CODE) {
      return c.json({ error: 'invalid impersonation return' }, 403);
    }
    return c.json({ token: ADMIN_TOKEN, user: adminUser, tokenTtlDays: TOKEN_TTL_DAYS });
  });

  // Fresh-install probe: reports the setup-lane state (true only while setup mode is armed AND no admin
  // exists yet). Default (no lane armed) → false, exactly as before.
  app.get('/setup', (c) => c.json({ needsSetup: needsSetup() }));

  // The onboarding directory + bootstrap-admin create, open during setup (no users yet) like the real
  // route. Creating the first user flips `needsSetup` false — the moment auth re-engages upstream.
  //
  // `listUsers()` only ever holds what the ONBOARDING lane created, so outside that lane the directory
  // is empty and `/users` renders its empty state — which left the users register, one of the app's core
  // registers, measured by nothing that runs a layout engine. A spec that needs the register laid out
  // seeds a directory with `seed.response('users', [...])`; the default is unchanged.
  app.get('/users', (c) => c.json(getResponse('users', listUsers())));
  app.post('/users', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: unknown };
    const username = typeof body.username === 'string' ? body.username : '';
    return c.json(addUser(username), 201);
  });
}
