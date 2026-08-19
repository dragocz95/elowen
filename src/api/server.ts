import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ZodError } from 'zod';
import { createRouteContext, type ElowenApp } from './context.js';
import { registerRoutes } from './routes/index.js';
import { bodyLimitBytes, formatZodError } from './validation.js';
import type { ServerDeps } from './deps.js';
import { ELOWEN_VERSION } from './version.js';
import { startLoopLagMonitor, watchLoopLag } from '../shared/eventLoopLag.js';

export type { ServerDeps };

/** A login body is a username and a password — anything larger is not a login attempt. Capped here
 *  because `/auth/login` is public: without a hard pre-parse limit an unauthenticated caller can make
 *  the daemon buffer an unbounded chunked body before the schema ever rejects it. */
const MAX_LOGIN_BODY_BYTES = 16 * 1024;

/** Build the daemon's REST app: wire the global error handler and the two public probes (`/health`,
 *  `/setup`), then register every route family through {@link registerRoutes} (which installs the
 *  auth/tenancy guards first). All per-server state and access helpers live on the shared route
 *  context; the families themselves are in src/api/routes/*. */
export function createServer(d: ServerDeps): ElowenApp {
  const ctx = createRouteContext(d);
  const { log } = ctx;
  const loopLag = startLoopLagMonitor();
  watchLoopLag(loopLag, log);
  const app: ElowenApp = new Hono();
  // Split the one number a client can measure into the two it needs: wall-clock from dispatch to
  // response-ready (this header) versus how long the request waited to be served (client total minus
  // this). During a stall storm, `/health` measured 19.9 s from curl while the handler itself ran in
  // under a millisecond — without this header that gap is indistinguishable from a slow handler.
  // What it measures, precisely: dispatch → response READY, wall clock. That INCLUDES event-loop
  // stalls the handler itself sat through, and for a streamed response it covers only creating the
  // stream, not writing it. ONLY on /health: it is the probe this split was built to explain, and a
  // per-route duration on public and error responses would be a small timing side-channel for free.
  // Registered first so the duration covers the whole app work for that route.
  app.use('*', async (c, next) => {
    const startedMs = performance.now();
    await next();
    if (c.req.path === '/health') c.res.headers.set('Server-Timing', `app;dur=${(performance.now() - startedMs).toFixed(1)}`);
  });
  app.use('*', cors());
  app.use('/auth/login', bodyLimitBytes(MAX_LOGIN_BODY_BYTES));
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
  // Event loop percentiles ride along on the probe that already exists, because the question "is the
  // daemon keeping up" has no other answer from outside: a starved loop and a slow provider look
  // identical in every other signal, and CPU graphs show a single core busy either way. Reading the
  // histogram is a few arithmetic ops, so the probe stays the ~1 ms round-trip it is today.
  // The pool rides along beside it for the same reason: a delegated turn waiting in the admission queue
  // and a provider being slow are indistinguishable from outside, and "the pool is saturated" is a
  // diagnosis nobody can reach without the per-runner counts, the queue depth and the oldest wait.
  app.get('/health', c => c.json({
    ok: true,
    version: ELOWEN_VERSION,
    eventLoop: loopLag.lag(),
    ...(d.subagentPool ? { subagentPool: d.subagentPool() } : {}),
  }));
  // Public: lets the web decide whether to show onboarding (no users yet) or the login form.
  app.get('/setup', c => c.json({ needsSetup: d.users ? d.users.count() === 0 : false }));

  // Registered before auth so even an authentication/agent-scope rejection from the global guards cannot
  // leave sensitive request-debug responses cacheable. Route-level admin checks still own authorization.
  app.use('/brain/debug/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'private, no-store');
  });

  registerRoutes(app, ctx);
  return app;
}
