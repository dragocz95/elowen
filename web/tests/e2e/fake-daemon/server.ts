// Standalone fake Elowen daemon for the Playwright E2E harness. A small Hono server (the same stack the
// real daemon uses) that answers the endpoints the web polls with canned JSON, plus a scriptable
// `GET /brain/stream` SSE endpoint and an out-of-band control channel. The REAL Next server is pointed
// at this via ELOWEN_DAEMON_URL, so the whole cookie / BFF / EventSource / transcript-reducer pipeline
// runs for real — only the nondeterministic agent brain is faked.
//
// Launched by Playwright's webServer as: node --experimental-strip-types tests/e2e/fake-daemon/server.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ADMIN_TOKEN } from '../seed/fixtures.ts';
import { needsSetup } from './setup.ts';
import { registerAuthRoutes } from './handlers/auth.ts';
import { registerCoreRoutes } from './handlers/core.ts';
import { registerBrainRoutes } from './handlers/brain.ts';
import { registerControlRoutes } from './handlers/control.ts';

const app = new Hono();

// Global auth gate, mirroring the real daemon's `authMiddleware` (src/api/auth.ts): a few public paths
// (plus the out-of-band `/__test/*` control channel, which never carries a token) are always open; while
// the fresh-install lane is armed and no admin exists the whole API is open so onboarding can run; after
// that a request must carry the admin bearer the BFF injects from the session cookie, or it is 401 —
// which is exactly what returns the app to login when the session is cleared or revoked.
function isPublicPath(method: string, path: string): boolean {
  if (path === '/health' || path === '/setup' || path === '/events') return true;
  if (method === 'POST' && path === '/auth/login') return true;
  return path.startsWith('/__test/');
}
app.use('*', async (c, next) => {
  if (isPublicPath(c.req.method, c.req.path)) return next();
  if (needsSetup()) return next();
  if (c.req.header('authorization') === `Bearer ${ADMIN_TOKEN}`) return next();
  return c.json({ error: 'unauthorized' }, 401);
});

registerAuthRoutes(app);
registerCoreRoutes(app);
registerBrainRoutes(app);
registerControlRoutes(app);

// Anything the shell polls that we haven't modeled: answer 200 [] rather than 404, so an unmodeled
// ambient GET never throws in the UI. Non-GET unknowns still 404 (a real missing write is a test bug).
app.get('*', (c) => c.json([]));
app.all('*', (c) => c.json({ error: 'not found', path: c.req.path }, 404));

const port = Number(process.env.FAKE_DAEMON_PORT ?? 4599);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
// eslint-disable-next-line no-console
console.log(`[fake-daemon] listening on http://127.0.0.1:${port}`);
