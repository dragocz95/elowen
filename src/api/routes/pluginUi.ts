import { readFileSync, existsSync } from 'node:fs';
import type { ElowenApp, RouteContext } from '../context.js';
import type { PluginWebUi } from '../../plugins/api.js';

/** Localize one webUi's menu metadata for a UI language: manifest English is the fallback, the plugin's
 *  `i18n/<lang>.json` `web` block overrides per nav route / settings id. */
function localized(w: PluginWebUi, lang: string): { nav: PluginWebUi['nav']; settings: PluginWebUi['settings'] } {
  const over = lang ? w.i18n?.[lang] : undefined;
  return {
    nav: w.nav.map((n) => ({ ...n, label: over?.nav?.[n.route ?? ''] ?? n.label })),
    settings: w.settings.map((s) => ({ ...s, label: over?.settings?.[s.id] ?? s.label })),
  };
}

/** Browser UI surface of the plugin platform: the authenticated listing the web app builds its menus
 *  from, plus the bundle bytes on an immutable content-hash URL. Both read the LIVE registry, so a
 *  plugin toggle/reload changes the listing (and 404s a stale bundle URL) with no re-mounting. */
export function registerPluginUiRoutes(app: ElowenApp, ctx: RouteContext): void {
  const { d } = ctx;

  // Enabled plugins with a browser UI. User-authed, not admin — the menu is every user's chrome. The
  // nav/settings metadata come from the manifest so menus never wait for (or execute) the bundle's JS.
  app.get('/plugins/ui', async (c) => {
    const registry = await d.plugins?.get().catch(() => undefined);
    const lang = c.req.query('lang') ?? '';
    return c.json([...(registry?.webUi.values() ?? [])].map((w) => ({
      name: w.plugin,
      url: `/plugins/${w.plugin}/web/${w.hash}.js`,
      apiVersion: w.requiresApiVersion,
      ...localized(w, lang),
    })));
  });

  // The built ESM bundle. The URL embeds the content hash, so it caches immutably for a year; a hash
  // that is not the CURRENT one 404s (same rule as themed assets: after a reload swaps the bundle, a
  // stale cached URL must fail loudly rather than serve mixed generations).
  app.get('/plugins/:name/web/:file', async (c) => {
    const registry = await d.plugins?.get().catch(() => undefined);
    const w = registry?.webUi.get(c.req.param('name'));
    if (!w || c.req.param('file') !== `${w.hash}.js`) return c.json({ error: 'not found' }, 404);
    if (!existsSync(w.file)) return c.json({ error: 'bundle missing' }, 404);
    return c.body(readFileSync(w.file, 'utf8'), 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
}
