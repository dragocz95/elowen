import { readFileSync, existsSync } from 'node:fs';
import { isPluginAllowedForUser } from '../../shared/pluginAccess.js';
import type { ElowenApp, RouteContext } from '../context.js';
import type { PluginUiVisibility, PluginWebUi } from '../../plugins/api.js';

/** Which of this plugin's account/project panels the account may see, or null for "no opinion". A probe
 *  that throws hides that plugin's panels and is warned: one plugin answering badly must not empty
 *  everybody's menu, and showing a panel whose owner just failed is the wrong way to guess. */
function visibilityOf(probe: PluginUiVisibility | undefined, plugin: string, userId: number | null, admin: boolean, warn?: (m: string) => void): { account?: readonly string[]; project?: readonly string[] } | null {
  if (!probe) return null;
  try {
    return probe({ userId, isAdmin: admin });
  } catch (error) {
    warn?.(`plugin "${plugin}" ui visibility probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return { account: [], project: [] };
  }
}

/** Localize one webUi's menu metadata for a UI language: manifest English is the fallback, the plugin's
 *  `i18n/<lang>.json` `web` block overrides per nav route / account/user/project/settings id. View strings
 *  merge the same way — per key, so a partial locale still falls back to the manifest English string.
 *
 *  `visible` is the plugin's own per-account answer (see PluginContext.registerUiVisibility): an omitted
 *  surface keeps every declared panel, an empty array drops them all. Filtering HERE rather than in the
 *  browser means a hidden panel's id never leaves the daemon, and an empty array reaches the web app as a
 *  surface with no entries — which already renders no tab and no section rather than an empty shell. */
function localized(w: PluginWebUi, lang: string, admin: boolean, visible: { account?: readonly string[]; project?: readonly string[] } | null): { label?: string; nav: PluginWebUi['nav']; account: PluginWebUi['account']; user: PluginWebUi['user']; project: PluginWebUi['project']; settings: PluginWebUi['settings']; strings: Record<string, string> } {
  const over = lang ? w.i18n?.[lang] : undefined;
  const label = over?.label ?? w.label;
  const shown = <T extends { id: string }>(items: T[], allowed: readonly string[] | undefined): T[] =>
    (allowed === undefined ? items : items.filter((item) => allowed.includes(item.id)));
  return {
    ...(label ? { label } : {}),
    nav: w.nav.map((n) => ({ ...n, label: over?.nav?.[n.route ?? ''] ?? n.label })),
    account: shown(w.account, visible?.account).map((s) => ({ ...s, label: over?.account?.[s.id] ?? s.label })),
    // User-detail panels are an administrator surface. Filter the metadata on the server so an ordinary
    // account never learns or accidentally mounts controls intended to operate on another account.
    user: admin ? w.user.map((s) => ({ ...s, label: over?.user?.[s.id] ?? s.label })) : [],
    project: shown(w.project, visible?.project).map((s) => ({ ...s, label: over?.project?.[s.id] ?? s.label })),
    settings: w.settings.map((s) => ({ ...s, label: over?.settings?.[s.id] ?? s.label })),
    strings: { ...(w.strings ?? {}), ...(over?.strings ?? {}) },
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
    const user = c.get('user');
    // A per-user-granted plugin is chrome only for the users who hold the grant. Filtered SERVER-side:
    // the web builds its menu purely from this list, so a client-side filter would still leave the
    // page reachable by typing its URL.
    const visible = [...(registry?.webUi.values() ?? [])].filter((w) =>
      (!w.adminOnly || user?.is_admin === true)
      && isPluginAllowedForUser(user, { name: w.plugin, userGrantable: registry?.userGrantable.has(w.plugin) }));
    return c.json(visible.map((w) => ({
      name: w.plugin,
      url: `/plugins/${w.plugin}/web/${w.hash}.js`,
      // The plugin's own stylesheet, when it ships one. Absent for every plugin that does not, so an
      // older plugin (and an older listing consumer) is untouched.
      ...(w.cssHash ? { cssUrl: `/plugins/${w.plugin}/web/${w.cssHash}.css` } : {}),
      apiVersion: w.requiresApiVersion,
      ...localized(w, lang, user?.is_admin === true, visibilityOf(
        registry?.uiVisibility.get(w.plugin), w.plugin, user?.id ?? null, user?.is_admin === true, (m) => ctx.log.warn(m),
      )),
    })));
  });

  // The built ESM bundle, and the plugin's own stylesheet when it ships one. Both URLs embed the
  // content hash, so they cache immutably for a year; a hash that is not the CURRENT one 404s (same
  // rule as themed assets: after a reload swaps the asset, a stale cached URL must fail loudly rather
  // than serve mixed generations). One route for both so the grant check below cannot be forgotten on
  // one of them — a stylesheet is a second door into the same plugin.
  app.get('/plugins/:name/web/:file', async (c) => {
    const registry = await d.plugins?.get().catch(() => undefined);
    const w = registry?.webUi.get(c.req.param('name'));
    const file = c.req.param('file');
    const asset = w && file === `${w.hash}.js`
      ? { path: w.file, type: 'text/javascript; charset=utf-8', missing: 'bundle missing' }
      : w?.cssHash && w.cssFile && file === `${w.cssHash}.css`
        ? { path: w.cssFile, type: 'text/css; charset=utf-8', missing: 'stylesheet missing' }
        : undefined;
    if (!w || !asset) return c.json({ error: 'not found' }, 404);
    const user = c.get('user');
    if (w.adminOnly && user?.is_admin !== true) return c.json({ error: 'forbidden' }, 403);
    // Same grant as the listing: hiding a plugin from the menu is worthless if its assets are still
    // downloadable, since together they carry the plugin's whole UI.
    if (!isPluginAllowedForUser(user, { name: w.plugin, userGrantable: registry?.userGrantable.has(w.plugin) })) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!existsSync(asset.path)) return c.json({ error: asset.missing }, 404);
    return c.body(readFileSync(asset.path, 'utf8'), 200, {
      'Content-Type': asset.type,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
}
