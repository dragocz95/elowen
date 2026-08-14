// Build the browser-UI bundles of bundled plugins that ship TS/React sources: a plugin with a
// `web-src/index.{tsx,ts,jsx,js}` gets it bundled to `web/index.js` (what the manifest's `web.entry`
// points at) via elowen-plugin-ui-kit. A plain-JS plugin has no `web-src/` and keeps its
// checked-in bundle untouched. Runs inside `npm run build` BEFORE plugins/ is copied into dist/, so
// the shipped tree carries the built bundles.
import { readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPluginUiBundle } from 'elowen-plugin-ui-kit/build';

const pluginsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins');
const ENTRY_NAMES = ['index.tsx', 'index.ts', 'index.jsx', 'index.js'];

for (const name of readdirSync(pluginsDir)) {
  const dir = join(pluginsDir, name);
  if (!statSync(dir).isDirectory()) continue;
  const src = join(dir, 'web-src');
  if (!existsSync(src)) continue;
  const entry = ENTRY_NAMES.map((f) => join(src, f)).find((f) => existsSync(f));
  if (!entry) throw new Error(`[build-plugins-web] ${name}: web-src/ exists but has no index.{tsx,ts,jsx,js} entry`);
  // Resolve shared browser deps (lucide-react…) from the web app's tree — one version, no root copy.
  await buildPluginUiBundle({ entry, outfile: join(dir, 'web', 'index.js'), nodePaths: [join(pluginsDir, '..', 'web', 'node_modules')] });
  console.log(`[build-plugins-web] ${name}: web-src → web/index.js`);
}
