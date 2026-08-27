// The plugin browser-UI surface of the fake daemon: the authenticated `/plugins/ui` listing and the two
// content-hashed assets it points at (the ESM bundle, and the plugin's OWN stylesheet).
//
// It exists for ONE guarantee, which nothing else in the harness can prove: Elowen is distributed as a
// PREBUILT web app, so on a user's machine there is no Tailwind and no Next build — the host's CSS is
// frozen at publish time and carries only the utilities the host itself uses. A plugin from the registry
// reaching for any other one rendered unstyled, and no test went red. So a plugin now ships its own
// stylesheet, the daemon serves it next to the bundle, and the web app must LINK it and wait for it
// before the page paints. `specs/plugin.css.e2e.ts` measures the result in a real browser.
//
// The hash rules mirror the real route (src/api/routes/pluginUi.ts) exactly: the URL embeds the content
// hash and a hash that is not the current one 404s, so a stale cached URL fails loudly rather than
// serving a mixed generation.
import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { getResponse } from '../overrides.ts';
import { realPlugins } from '../realPlugins.ts';

/** The fixture plugin's name — also its route: `/p/<name>`. */
export const PLUGIN_NAME = 'cssprobe';

// The two arbitrary widths under test, ASSEMBLED at runtime rather than written out anywhere. This file
// sits inside the web app, so Tailwind's own scan reads it — spell either utility out (in code OR in a
// comment) and the HOST stylesheet starts carrying the very rule this test claims only the plugin can
// supply, and the spec passes for the wrong reason. It is not hypothetical: a first draft of this
// comment named the class and did exactly that. Keep the class name un-spellable here.
const widthClass = (px: number) => `w-${'['}${px}px]`;
/** Supplied ONLY by the plugin stylesheet below. */
export const PROBE_WIDTH = 137;
/** Supplied by NOBODY — the negative control. If the host ever did generate arbitrary widths from this
 *  file, this one would be styled too and the spec's control assertion goes red. */
export const CONTROL_WIDTH = 913;

/** The plugin's ESM bundle. Written against `window.ElowenUiRuntime` the way a real built bundle is
 *  (the ui-kit's React shim compiles to exactly these reads), so it renders through the HOST's React. */
export const BUNDLE = `
const runtime = window.ElowenUiRuntime;
const react = runtime.react;
function Probe() {
  return react.createElement('div', null,
    react.createElement('div', { 'data-testid': 'probe', className: ${JSON.stringify(widthClass(PROBE_WIDTH))} }),
    react.createElement('div', { 'data-testid': 'control', className: ${JSON.stringify(widthClass(CONTROL_WIDTH))} }),
  );
}
window.__elowenRegisterPluginUi(${JSON.stringify(PLUGIN_NAME)}, { requiresApiVersion: 1, pages: { '': Probe } });
`;

/** The plugin's stylesheet: one rule, in `@layer utilities`, exactly as `buildPluginUiCss` emits it. */
export const CSS = `@layer utilities{.${widthClass(PROBE_WIDTH).replace(/([[\]])/g, '\\$1')}{width:${PROBE_WIDTH}px}}`;

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
export const BUNDLE_HASH = hash(BUNDLE);
export const CSS_HASH = hash(CSS);

/** The `/plugins/ui` row for the fixture plugin. A spec ARMS it with `seed.response('plugins/ui', …)`;
 *  the default listing stays empty so every other spec keeps the plugin-less shell it was written
 *  against. This is the object a mutation drops `cssUrl` from. */
export const PLUGIN_LISTING = [{
  name: PLUGIN_NAME,
  url: `/plugins/${PLUGIN_NAME}/web/${BUNDLE_HASH}.js`,
  cssUrl: `/plugins/${PLUGIN_NAME}/web/${CSS_HASH}.css`,
  apiVersion: 1,
  label: 'CSS probe',
  nav: [{ label: 'CSS probe', icon: 'Blocks', route: '' }],
  settings: [] as { id: string; label: string }[],
  strings: {} as Record<string, string>,
}];

export function registerPluginRoutes(app: Hono): void {
  app.get('/plugins/ui', (c) => c.json(getResponse('plugins/ui', [] as unknown)));

  app.get('/plugins/:name/web/:file', (c) => {
    const name = c.req.param('name');
    if (name !== PLUGIN_NAME) {
      // A REAL built bundle from `plugins/<name>/web` (see realPlugins.ts). Same content-hash rule as
      // the fixture plugin below and as the real route: only the CURRENT hash resolves.
      const asset = realPlugins().get(name)?.assets.get(c.req.param('file'));
      if (!asset) return c.json({ error: 'not found' }, 404);
      return c.body(asset.body, 200, { 'Content-Type': asset.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    const file = c.req.param('file');
    if (file === `${BUNDLE_HASH}.js`) {
      return c.body(BUNDLE, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    if (file === `${CSS_HASH}.css`) {
      return c.body(CSS, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    return c.json({ error: 'not found' }, 404);
  });
}
