import { streamSSE } from 'hono/streaming';
import { ZodError } from 'zod';
import { logger } from '../../shared/logger.js';
import { discoverPlugins } from '../../plugins/loader.js';
import { bodyLimitBytes, formatZodError, readBoundedBody } from '../validation.js';
import { runWithIdentity } from '../../plugins/policyContext.js';
import { isPluginAllowedForUser } from '../../shared/pluginAccess.js';
import { operatesInstance } from '../../shared/instanceOperator.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ElowenApp, ElowenContext, RouteContext } from '../context.js';
import type { TurnIdentity } from '../../plugins/policyContext.js';
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
  match: { plugin: string; userGrantable: boolean; handler: PluginApiRoute['handler']; access: PluginApiAccess; remainder: string; params?: Record<string, string> },
) {
  // Declared access is enforced centrally; admin uses the setup-tolerant core gate.
  if (match.access === 'admin' && ctx.notAdminUnlessSetup(c)) return c.json({ error: 'forbidden' }, 403);
  // Per-user grant, for a plugin whose manifest opted in. Checked HERE rather than per route, so a
  // plugin cannot grow an ungated endpoint by forgetting one.
  if (match.userGrantable && !isPluginAllowedForUser(c.get('user'), { name: match.plugin, userGrantable: true })) {
    // Say it in the log. From the user's seat a missing grant looks exactly like a broken feature, and an
    // operator debugging that has nothing else to go on — the response is a bare 403 by design.
    log.info(`plugin ${match.plugin} refused for user ${c.get('user')?.id ?? 'anonymous'}: not granted`);
    return c.json({ error: 'forbidden' }, 403);
  }

  // Bounded read, not "buffer then measure": the root dispatcher below is a catch-all with no path
  // pattern to front with bodyLimit middleware (one would cap every core route too), so the cap has to
  // bound the ALLOCATION here. The namespaced surface keeps its streaming middleware as well.
  const raw = await readBoundedBody(c, MAX_API_BODY_BYTES);
  if (raw === null) return c.json({ error: 'payload too large' }, 413);
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
      tokenScope: 'user',
      accessibleProjects: projects === null ? null : [...projects],
    },
  };

  // The handler runs inside an IDENTITY scope so `ctx.currentIdentity()` answers in an API handler the
  // same way it does in a tool. It is explicitly not a turn scope: no Policy, tool policy or session id.
  const identity: TurnIdentity = {
    platform: 'http',
    userId: String(request.auth.userId ?? ''),
    ...(request.auth.userId !== null ? { elowenUserId: request.auth.userId } : {}),
    ...(c.get('user')?.username ? { elowenUsername: c.get('user')!.username } : {}),
    admin: request.auth.admin,
    // Same rule as inside a turn (see `operatesInstance`), not a second opinion: this used to compare the
    // caller against `users.ownerId()` — the FIRST admin by creation order — so a second admin passed every
    // owner gate in a tool and was refused the identical gate on a plugin route.
    owner: operatesInstance({
      userId: request.auth.userId ?? undefined,
      ownerId: ctx.d.users?.ownerId(),
      isAdmin: request.auth.userId !== null ? ctx.d.users?.get(request.auth.userId)?.is_admin === true : false,
    }),
    // An authenticated HTTP call acts for exactly one account, like that account's own chat — there is no
    // room full of other senders here, so per-account state is the right default for a plugin route.
    conversation: 'own',
  };

  try {
    const res = await runWithIdentity(identity, () => match.handler(request));
    if (res.sse && res.body === undefined) {
      return streamSSE(c, async (stream) => {
        const send = (data: string, event?: string) => stream.writeSSE({ data, ...(event ? { event } : {}) });
        // The stream body runs long after the handler returned, i.e. outside the scope above — re-enter
        // it, or a plugin streaming per-user data would suddenly see no identity at all.
        await runWithIdentity(identity, () => res.sse!(send, c.req.raw.signal));
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
    return dispatchPluginApi(c, ctx, { ...match, plugin: name, userGrantable: registry!.userGrantable.has(name) });
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
  // A mount is dropped (per METHOD) only when a core pattern of that method FULLY covers it — every
  // core segment is a param or equals the mount's literal segment, so every request the mount's root
  // could serve is core's. A PARTIAL overlap (the mount has a param where core has a literal, e.g.
  // plugin PATCH '/plugins/skills/:name' beside core PATCH '/plugins/:name/config') is not a
  // conflict: core routes matched before this fall-through dispatcher, so core naturally wins the
  // literal paths and the mount serves the rest. Method-blind or either-side-param matching here
  // used to drop such mounts wholesale, 404ing paths nobody else served.
  const coveringMethods = (mount: string): Set<string> => {
    const segs = mount.split('/').filter(Boolean);
    return new Set(corePatterns
      .filter((p) => p.segs.length === segs.length && p.segs.every((seg, i) => seg.startsWith(':') || seg === segs[i]))
      .map((p) => p.method));
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
  let declaredInactive: { plugin: string; reason: 'disabled' | 'missing'; segs: string[] }[] = [];
  const validate = (registry: { rootApiRoutes: Map<string, { plugin: string; routes: { method?: string }[] }> }) => {
    if (registry === validatedFor) return;
    validatedFor = registry;
    skipped.clear();
    // The skip key is `<METHOD> <mount>`: the same mount can be fine for one method and fully
    // core-shadowed for another. A method-less plugin route is shadowed only on the METHODS core
    // actually covers (an 'ALL' core route covers everything → the '*' key), so it keeps serving the
    // methods core never registered there.
    for (const [mount, entry] of registry.rootApiRoutes) {
      const covered = coveringMethods(mount);
      for (const route of entry.routes) {
        const methods = route.method !== undefined
          ? (covered.has(route.method) || covered.has('ALL') ? [route.method] : [])
          : [...covered].map((m) => (m === 'ALL' ? '*' : m));
        for (const m of methods) {
          skipped.add(`${m} ${mount}`);
          log.warn(`root api mount '${m === '*' ? 'ANY' : m} ${mount}' (plugin ${entry.plugin}) skipped: a core route owns this path — core wins`);
        }
      }
    }
    const onDisk = discoverPlugins(d.pluginDirs ?? []);
    const onDiskNames = new Set(onDisk.map((p) => p.manifest.name));
    const declared: { plugin: string; mount: string; reason: 'disabled' | 'missing' }[] = onDisk
      .flatMap((p) => (p.manifest.provides?.apiRoutes ?? []).map((mount) => ({ plugin: p.manifest.name, mount, reason: 'disabled' as const })));
    // A plugin that is ENABLED but absent from every plugin dir has no manifest to read here, so the
    // loop above cannot see the mounts it owns — the request would fall through to a bare 404 claiming
    // the endpoint never existed. That is the state a user lands in when a subsystem has moved to the
    // registry and the boot reconciler could not reach it, so the mounts are recovered from the registry
    // cache instead. Cache miss simply yields nothing and the 404 stands.
    for (const name of d.config.get().plugins.enabled) {
      if (onDiskNames.has(name)) continue;
      for (const mount of d.marketplace?.declaredRootRoutes(name) ?? []) {
        declared.push({ plugin: name, mount, reason: 'missing' });
      }
    }
    declaredInactive = declared
      .filter((m) => !registry.rootApiRoutes.has(m.mount))
      .map((m) => ({ plugin: m.plugin, reason: m.reason, segs: m.mount.split('/').filter(Boolean) }));
  };
  // Does the request path fall under a declared-but-inactive mount? Same prefix semantics as the live
  // resolver: every mount segment must match (':param' matches any one segment), extra trailing
  // request segments are the handler's sub-path.
  const inactiveOwner = (path: string): { plugin: string; reason: 'disabled' | 'missing' } | undefined => {
    const segs = path.split('/').filter(Boolean);
    return declaredInactive.find((m) =>
      m.segs.length <= segs.length && m.segs.every((seg, i) => seg.startsWith(':') || seg === segs[i]));
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
    if (!match || skipped.has(`${c.req.method} ${match.mount}`) || skipped.has(`* ${match.mount}`)) {
      // No live handler — but if a DISCOVERED plugin declares this mount, the subsystem exists and is
      // merely off: answer an explicit 503 so callers (CLI, spawned agents, MCP tools) get a reason
      // instead of a bare 404. An undeclared path still falls through to Hono's notFound.
      const owner = inactiveOwner(c.req.path);
      if (owner) {
        // Same status, different cause: "disabled" is a setting the user can flip, "missing" means the
        // plugin is switched ON but its code is not on this host — usually a registry that was
        // unreachable at boot. Saying which one it is turns an opaque 503 into an actionable one.
        return c.json({
          error: owner.reason === 'missing'
            ? `${owner.plugin} plugin is enabled but not installed`
            : `${owner.plugin} plugin is disabled`,
        }, 503);
      }
      return next();
    }
    return dispatchPluginApi(c, ctx, { ...match, userGrantable: registry.userGrantable.has(match.plugin) });
  });
}
