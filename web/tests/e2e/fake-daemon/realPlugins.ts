// REAL plugin browser bundles, served by the fake daemon so a spec can measure a `/p/<plugin>` page in a
// real browser.
//
// WHY THIS EXISTS: the fake daemon's `/plugins/ui` is empty by default, so before this file every plugin
// page in the harness rendered the host's "plugin unavailable" notice and the entire `/p/*` surface —
// the plugin host frame, a plugin's own register, its toolbar, its pager, its takeover — was unverified
// by anything that runs a layout engine. The `cssprobe` fixture next door proves the STYLESHEET contract
// with a two-div bundle; it deliberately renders nothing a layout assertion could stand on.
//
// It is OPT-IN twice over, because other specs are written against the plugin-less shell:
//   1. `/plugins/ui` still answers `[]` unless a spec arms the override (`seed.realPlugins()`), and
//   2. nothing is read from disk until something asks for the listing.
//
// It is DERIVED, not hand-written: every field comes out of the plugin's own `elowen-plugin.json`, hashed
// and shaped by the same rules as `src/plugins/loader.ts` + `src/api/routes/pluginUi.ts`. A manifest that
// declares a bundle it does not ship, or a nav entry it does not register, fails the spec instead of
// being papered over by a fixture that says what the test wished were true.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** `web/tests/e2e/fake-daemon` → the repo root. */
const repoRoot = resolve(here, '../../../..');

/** Directories that CONTAIN plugin folders. `E2E_PLUGIN_DIRS` (colon-separated, absolute) adds an
 *  out-of-tree checkout — the plugin registry lives in its own repository, so its pages can only be
 *  measured when the operator points the harness at that checkout. The repo's own `plugins/` is always
 *  included, which is what makes the core-owned plugin pages verifiable with no extra setup. */
function pluginRoots(): string[] {
  const extra = (process.env.E2E_PLUGIN_DIRS ?? '').split(':').map((p) => p.trim()).filter((p) => p !== '');
  return [join(repoRoot, 'plugins'), ...extra].filter((dir) => existsSync(dir));
}

/** One row of `GET /plugins/ui`, plus the on-disk assets its URLs point at. */
export interface RealPlugin {
  listing: {
    name: string;
    url: string;
    cssUrl?: string;
    apiVersion: number;
    label?: string;
    nav: { label: string; icon?: string; route?: string }[];
    account: { id: string; label: string; icon?: string; placement?: string }[];
    user: { id: string; label: string; icon?: string }[];
    project: { id: string; label: string; icon?: string }[];
    settings: { id: string; label: string; icon?: string; layout?: string }[];
    strings: Record<string, string>;
  };
  assets: Map<string, { body: string; type: string }>;
}

const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

/** Read one plugin directory, or `null` when it declares no browser UI / ships no built bundle. The
 *  second case is normal: a registry checkout that has not run `npm run build:web` has manifests but no
 *  `web/index.js`, and a spec must skip that plugin rather than assert against a 404. */
function readPlugin(dir: string, name: string): RealPlugin | null {
  const manifestPath = join(dir, 'elowen-plugin.json');
  if (!existsSync(manifestPath)) return null;
  let manifest: { web?: Record<string, unknown> };
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { web?: Record<string, unknown> }; }
  catch { return null; }
  const web = manifest.web;
  if (!web || typeof web.entry !== 'string') return null;

  // Same escape rule as the loader: a manifest may not reach outside its own directory.
  const inside = (rel: string) => {
    const path = resolve(dir, rel);
    return path === dir || path.startsWith(dir + sep) ? path : null;
  };
  const entryPath = inside(web.entry);
  if (!entryPath || !existsSync(entryPath)) return null;

  const assets = new Map<string, { body: string; type: string }>();
  const jsHash = hash(entryPath);
  assets.set(`${jsHash}.js`, { body: readFileSync(entryPath, 'utf8'), type: 'text/javascript; charset=utf-8' });

  let cssUrl: string | undefined;
  if (typeof web.css === 'string') {
    const cssPath = inside(web.css);
    // A declared stylesheet that is missing is exactly the silent-breakage case the css contract exists
    // to end, so it must not be quietly dropped here either — the listing keeps no cssUrl and the page
    // paints with host utilities only, which is what `plugin.css.e2e.ts` already measures.
    if (cssPath && existsSync(cssPath)) {
      const cssHash = hash(cssPath);
      assets.set(`${cssHash}.css`, { body: readFileSync(cssPath, 'utf8'), type: 'text/css; charset=utf-8' });
      cssUrl = `/plugins/${name}/web/${cssHash}.css`;
    }
  }

  const arr = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);
  return {
    listing: {
      name,
      url: `/plugins/${name}/web/${jsHash}.js`,
      ...(cssUrl ? { cssUrl } : {}),
      apiVersion: typeof web.requiresApiVersion === 'number' ? web.requiresApiVersion : 1,
      ...(typeof web.label === 'string' ? { label: web.label } : {}),
      // The harness always browses as the admin, so `user` panels are listed the way the real route
      // lists them for an administrator, and no visibility probe narrows account/project.
      nav: arr(web.nav), account: arr(web.account), user: arr(web.user), project: arr(web.project),
      settings: arr(web.settings),
      strings: (web.strings ?? {}) as Record<string, string>,
    },
    assets,
  };
}

let cache: Map<string, RealPlugin> | null = null;

/** Every plugin with a built browser bundle, keyed by name. Read once per fake-daemon process. */
export function realPlugins(): Map<string, RealPlugin> {
  if (cache) return cache;
  const found = new Map<string, RealPlugin>();
  for (const root of pluginRoots()) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || found.has(entry.name)) continue;
      const plugin = readPlugin(join(root, entry.name), entry.name);
      if (plugin) found.set(entry.name, plugin);
    }
  }
  cache = found;
  return found;
}
