import { OAUTH_BUILTIN } from '../../../brain/providers.js';
import { oauthBuiltinCatalog } from '../../../brain/models.js';
import { oauthImageCatalog } from '../../../brain/imageService.js';
import type { ElowenApp, RouteContext } from '../../context.js';

/** ── Brain provider OAuth (admin): connect an Anthropic / GitHub Copilot / OpenAI account. ──
 *  The UI starts a flow, shows authUrl (+ userCode for device flows), polls status, and posts the
 *  pasted code when the flow asks for input. Tokens persist in the brain's AuthStorage. */
export function registerBrainOAuthRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d, notAdminUnlessSetup: notAdmin } = ctx;

  const oauthProviderOf = (type: string): string | undefined => OAUTH_BUILTIN[type];

  app.get('/brain/oauth/status', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brainOauth) return c.json({});
    const out: Record<string, boolean> = {};
    for (const [type, builtin] of Object.entries(OAUTH_BUILTIN)) out[type] = d.brainOauth.connected(builtin);
    return c.json(out);
  });

  // The account's full built-in catalog — what the settings model picker offers for selection.
  app.get('/brain/oauth/:type/catalog', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const type = c.req.param('type');
    if (!oauthProviderOf(type)) return c.json({ error: 'unknown oauth provider' }, 404);
    // `imageModels` marks the subset the picker badges as image models: they enable through the same
    // allowlist as the chat models, but only an image plugin may pick one.
    return c.json({ models: await oauthBuiltinCatalog(type), imageModels: oauthImageCatalog(type) });
  });

  app.post('/brain/oauth/:type/start', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brainOauth) return c.json({ error: 'oauth unavailable' }, 503);
    const builtin = oauthProviderOf(c.req.param('type'));
    if (!builtin) return c.json({ error: 'unknown oauth provider' }, 404);
    return c.json(d.brainOauth.start(builtin, { method: c.req.query('method') }), 201);
  });

  app.get('/brain/oauth/flow/:id', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const flow = d.brainOauth?.get(c.req.param('id'));
    return flow ? c.json(flow) : c.json({ error: 'unknown flow' }, 404);
  });

  app.post('/brain/oauth/flow/:id/input', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    if (typeof b.value !== 'string' || !b.value.trim()) return c.json({ error: 'value must be a non-empty string' }, 400);
    if (!d.brainOauth?.submitInput(c.req.param('id'), b.value.trim())) return c.json({ error: 'flow is not waiting for input' }, 409);
    return c.json({ ok: true });
  });

  app.delete('/brain/oauth/:type', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    if (!d.brainOauth) return c.json({ error: 'oauth unavailable' }, 503);
    const builtin = oauthProviderOf(c.req.param('type'));
    if (!builtin) return c.json({ error: 'unknown oauth provider' }, 404);
    await d.brainOauth.disconnect(builtin);
    return c.json({ ok: true });
  });
}
