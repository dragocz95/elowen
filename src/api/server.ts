import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ZodError } from 'zod';
import type { User, TokenScope } from '../store/userStore.js';
import { createRouteContext, type OrcaApp } from './context.js';
import { registerRoutes } from './routes/index.js';
import { formatZodError } from './validation.js';
import type { ServerDeps } from './deps.js';
import { ORCA_VERSION } from './version.js';

export type { ServerDeps };

/** Build the daemon's REST app: wire the global error handler and the two public probes (`/health`,
 *  `/setup`), then register every route family through {@link registerRoutes} (which installs the
 *  auth/tenancy guards first). All per-server state and access helpers live on the shared route
 *  context; the families themselves are in src/api/routes/*. */
export function createServer(d: ServerDeps): Hono<{ Variables: { user: User; token: string; tokenScope: TokenScope } }> {
  const ctx = createRouteContext(d);
  const { log } = ctx;
  const app: OrcaApp = new Hono<{ Variables: { user: User; token: string; tokenScope: TokenScope } }>();
  app.use('*', cors());
  // Single source of truth for malformed-body handling: most POST/PATCH routes call `c.req.json()`
  // without a per-route catch, and Hono throws a SyntaxError on invalid JSON. Convert that to a clean
  // 400 instead of leaking a default 500 with no useful body.
  app.onError((err, c) => {
    if (err instanceof SyntaxError) return c.json({ error: 'invalid JSON body' }, 400);
    // A failed `parseBody` schema validation — the single source of truth for malformed request bodies.
    if (err instanceof ZodError) return c.json({ error: formatZodError(err) }, 400);
    log.error('unhandled route error', err);
    return c.json({ error: 'internal error' }, 500);
  });
  app.get('/health', c => c.json({ ok: true, version: ORCA_VERSION }));
  // Public: lets the web decide whether to show onboarding (no users yet) or the login form.
  app.get('/setup', c => c.json({ needsSetup: d.users ? d.users.count() === 0 : false }));

  registerRoutes(app, ctx);
  return app;
}
