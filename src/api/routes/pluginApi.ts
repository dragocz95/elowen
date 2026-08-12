import { streamSSE } from 'hono/streaming';
import { ZodError } from 'zod';
import { logger } from '../../shared/logger.js';
import { discoverPlugins } from '../../plugins/loader.js';
import { bodyLimitBytes, formatZodError } from '../validation.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ElowenApp, ElowenContext, RouteContext } from '../context.js';
import type { PluginApiAccess, PluginApiRequest, PluginApiRoute } from '../../plugins/api.js';

/** Authenticated plugin API payloads are app traffic (JSON bodies, small uploads), not webhooks — a
 *  larger cap than /hooks but still bounded, because the dispatcher buffers the body whole. */
const MAX_API_BODY_BYTES = 4 * 1024 * 1024;

const log = logger('plugin-api');

/** The core of both plugin API dispatchers (namespaced + root-mounted): enforce the route's declared
 *  access against the request's validated identity, build the PluginApiRequest, run the handler and
 *  map its response — buffered body or SSE stream. Shared so the two surfaces cannot drift. */
async function dispatchPluginApi(
  c: ElowenContext,
  ctx: RouteContext,
  match: { handler: PluginApiRoute['handler']; access: PluginApiAccess; remainder: string; params?: Record<string, string> },
) {
  // Declared access, enforced centrally. An agent service token reaches ONLY a route that opted into
  // `access: 'agent'` (it runs with skipped permissions — same deny-by-default as the core agent
  // allow-list); task-level pinning is the handler's job via `auth.agentTask`. `admin` uses the
  // setup-tolerant gate the core config routes use, so onboarding can configure an admin-level plugin.
  const scope = c.get('tokenScope') === 'agent' ? 'agent' as const : 'user' as const;
  if (scope === 'agent' && match.access !== 'agent') return c.json({ error: 'forbidden' }, 403);
  if (scope === 'user' && match.access === 'admin' && ctx.notAdminUnlessSetup(c)) return c.json({ error: 'forbidden' }, 403);

  const raw = Buffer.from(await c.req.arrayBuffer());
  if (raw.length > MAX_API_BODY_BYTES) return c.json({ error: 'payload too large' }, 413);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  const projects = ctx.accessibleProjects(c);
  const request: PluginApiRequest = {
    method: c.req.method,
    path: match.remainder,
    query: c.req.query(),
    headers,
    params: match.params ?? {},
    body: () => Promise.resolve(raw),
    json: <T = unknown>() => Promise.resolve(JSON.parse(raw.toString('utf8')) as T),
    auth: {
      userId: c.get('user')?.id ?? null,
      admin: !ctx.notAdmin(c),
      tokenScope: scope,
      agentTask: c.get('agentTask') ?? null,
      accessibleProjects: projects === null ? null : [...projects],
    },
  };

  try {
    const res = await match.handler(request);
    if (res.sse && res.body === undefined) {
      return streamSSE(c, async (stream) => {
        const send = (data: string, event?: string) => stream.writeSSE({ data, ...(event ? { event } : {}) });
        await res.sse!(send, c.req.raw.signal);
      });
    }
    const status = (res.status ?? 200) as ContentfulStatusCode;
    const body = res.body;
    if (body === undefined || typeof body === 'string') return c.body(body ?? '', status, res.headers ?? {});
    if (body instanceof Uint8Array) return c.body(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, status, res.headers ?? {});
    return c.json(body, status, res.headers ?? {});
  } catch (error) {
    // Body-shape failures map exactly like the core route families' onError, so a grandfathered
    // root-mounted route keeps its clients' 400 contract (invalid JSON / zod shape errors).
    if (error instanceof SyntaxError) return c.json({ error: 'invalid JSON body' }, 400);
    if (error instanceof ZodError) return c.json({ error: formatZodError(error) }, 400);
    // The failure detail stays daemon-side — same rule as /hooks: a caller learns nothing about the
    // handler's internals from the response.
    log.warn(`plugin api handler failed for ${c.req.path}: ${error instanceof Error ? error.message : String(error)}`);
    return c.json({ error: 'plugin api handler failed' }, 500);
  }
}

/** Authenticated plugin API mounts: one catch-all dispatcher over `/plugins/<name>/api/<path>`, resolved
 *  against the CURRENT plugin registry on every request (a plugin reload is reflected with no
 *  re-mounting). Registered AFTER the global auth guards, so every request reaching a handler carries a
 *  validated user/tokenScope — the dispatcher then enforces the route's declared access level and hands
 *  the handler a verified identity block. This is the first-class sibling of the public `/hooks`
 *  surface: same resolution rules, but the daemon owns authentication instead of the plugin. */
export function registerPluginApiRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d } = ctx;
  app.use('/plugins/:name/api/*', bodyLimitBytes(MAX_API_BODY_BYTES));
  app.all('/plugins/:name/api/*', async (c) => {
    const name = c.req.param('name');
    const registry = await d.plugins?.get().catch(() => undefined);
    // Path remainder from the RAW path (not a decoded param) so an encoded slash cannot fold segments.
    const mount = `/plugins/${name}/api/`;
    if (!c.req.path.startsWith(mount)) return c.json({ error: 'not found' }, 404);
    const match = registry?.apiRoute(name, c.req.path.slice(mount.length), c.req.method);
    if (!match) return c.json({ error: 'not found' }, 404);
    return dispatchPluginApi(c, ctx, match);
  });
}

/** ROOT-mounted plugin API routes (PluginApiRoute.rootMount): a fallback catch-all registered LAST, so
 *  every core route wins by construction — it only runs for a path no core handler answered. Resolution
 *  is live against the current registry (reload-safe: the dispatcher itself is registered exactly once,
 *  so a plugin reload swaps handlers without ever stacking a second registration). On top of the
 *  ordering guarantee, each registry generation is validated against the core route table snapshot:
 *  a mount a core pattern would shadow is dropped for that generation with a WARN (core wins, loudly). */
export function registerRootPluginApiRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d } = ctx;
  // Snapshot of the core route patterns registered BEFORE this catch-all. Wildcard patterns are
  // middleware (`app.use('*')`, the namespaced plugin dispatcher) — they never terminally own a path,
  // so they are not conflicts.
  const corePatterns = app.routes
    .filter((r) => !r.path.includes('*'))
    .map((r) => ({ method: r.method, segs: r.path.split('/').filter(Boolean) }));
  const coversMount = (mount: string): boolean => {
    const segs = mount.split('/').filter(Boolean);
    // Params wildcard on EITHER side: a pattern mount ('/tasks/:id/ask') conflicts with a core route
    // only when every segment pair is compatible (equal literals, or a param on either side).
    return corePatterns.some((p) =>
      p.segs.length === segs.length && p.segs.every((seg, i) => seg.startsWith(':') || segs[i]!.startsWith(':') || seg === segs[i]));
  };
  // Conflict validation runs once per registry GENERATION (object identity): a reload re-validates,
  // a steady state costs one map lookup per request.
  let validatedFor: unknown;
  const skipped = new Set<string>();
  // Root mounts DECLARED by a discovered plugin (manifest provides.apiRoutes) that are NOT live in
  // this registry generation — i.e. the owning plugin is disabled (or failed to load). A request
  // hitting one of these answers an explicit 503 instead of a bare 404, so a CLI or spawned agent
  // can tell "subsystem off" from "no such endpoint". Recomputed per generation: enabling/disabling
  // a plugin reloads the registry, so the disk scan runs once per toggle, not per request.
  let declaredInactive: { plugin: string; segs: string[] }[] = [];
  const validate = (registry: { rootApiRoutes: Map<string, { plugin: string }> }) => {
    if (registry === validatedFor) return;
    validatedFor = registry;
    skipped.clear();
    for (const [mount, entry] of registry.rootApiRoutes) {
      if (coversMount(mount)) {
        skipped.add(mount);
        log.warn(`root api mount '${mount}' (plugin ${entry.plugin}) skipped: a core route owns this path — core wins`);
      }
    }
    declaredInactive = discoverPlugins(d.pluginDirs ?? [])
      .flatMap((p) => (p.manifest.provides?.apiRoutes ?? []).map((mount) => ({ plugin: p.manifest.name, mount })))
      .filter((m) => !registry.rootApiRoutes.has(m.mount))
      .map((m) => ({ plugin: m.plugin, segs: m.mount.split('/').filter(Boolean) }));
  };
  // Does the request path fall under a declared-but-inactive mount? Same prefix semantics as the live
  // resolver: every mount segment must match (':param' matches any one segment), extra trailing
  // request segments are the handler's sub-path.
  const inactiveOwner = (path: string): string | undefined => {
    const segs = path.split('/').filter(Boolean);
    return declaredInactive.find((m) =>
      m.segs.length <= segs.length && m.segs.every((seg, i) => seg.startsWith(':') || seg === segs[i]))?.plugin;
  };
  // Middleware with fall-through, NOT a terminal `app.all('*')`: an unmatched path must continue to
  // whatever is registered AFTER this dispatcher (daemon/index.ts adds the /ws/terminal upgrade on the
  // returned app) and then to Hono's own notFound. The terminal catch-all swallowed exactly those —
  // the WS upgrade answered 404 and the terminal stream died (caught by api-e2e's ticket gate).
  app.use(async (c, next) => {
    const registry = await d.plugins?.get().catch(() => undefined);
    if (!registry) return next();
    validate(registry);
    const match = registry.rootApiRoute(c.req.path, c.req.method);
    if (!match || skipped.has(match.mount)) {
      // No live handler — but if a DISCOVERED plugin declares this mount, the subsystem exists and is
      // merely off: answer an explicit 503 so callers (CLI, spawned agents, MCP tools) get a reason
      // instead of a bare 404. An undeclared path still falls through to Hono's notFound.
      const owner = inactiveOwner(c.req.path);
      if (owner) return c.json({ error: `${owner} plugin is disabled` }, 503);
      return next();
    }
    return dispatchPluginApi(c, ctx, match);
  });
}
