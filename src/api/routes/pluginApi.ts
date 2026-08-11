import { logger } from '../../shared/logger.js';
import { bodyLimitBytes } from '../validation.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ElowenApp, RouteContext } from '../context.js';
import type { PluginApiRequest } from '../../plugins/api.js';

/** Authenticated plugin API payloads are app traffic (JSON bodies, small uploads), not webhooks — a
 *  larger cap than /hooks but still bounded, because the dispatcher buffers the body whole. */
const MAX_API_BODY_BYTES = 4 * 1024 * 1024;

const log = logger('plugin-api');

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

    // Declared access, enforced centrally. An agent service token reaches ONLY a route that opted into
    // `access: 'agent'` (it runs with skipped permissions — same deny-by-default as the core agent
    // allow-list); task-level pinning is the handler's job via `auth.agentTask`. `admin` uses the
    // setup-tolerant gate the core config routes use, so onboarding can configure an admin-level plugin.
    const scope = c.get('tokenScope') === 'agent' ? 'agent' as const : 'user' as const;
    if (scope === 'agent' && match.access !== 'agent') return c.json({ error: 'forbidden' }, 403);
    if (scope === 'user' && match.access === 'admin' && ctx.notAdminUnlessSetup(c)) return c.json({ error: 'forbidden' }, 403);

    const raw = Buffer.from(await c.req.arrayBuffer());
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    const projects = ctx.accessibleProjects(c);
    const request: PluginApiRequest = {
      method: c.req.method,
      path: match.remainder,
      query: c.req.query(),
      headers,
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
      const status = (res.status ?? 200) as ContentfulStatusCode;
      const body = res.body;
      if (body === undefined || typeof body === 'string') return c.body(body ?? '', status, res.headers ?? {});
      if (body instanceof Uint8Array) return c.body(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, status, res.headers ?? {});
      return c.json(body, status, res.headers ?? {});
    } catch (error) {
      // The failure detail stays daemon-side — same rule as /hooks: a caller learns nothing about the
      // handler's internals from the response.
      log.warn(`plugin api handler failed for ${c.req.path}: ${error instanceof Error ? error.message : String(error)}`);
      return c.json({ error: 'plugin api handler failed' }, 500);
    }
  });
}
