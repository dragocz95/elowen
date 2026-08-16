/** esbuild toolchain for plugin browser-UI bundles: one TS/TSX/JS entry → one self-contained
 *  same-origin ESM file the daemon serves on a content-hash URL (the daemon hashes it — the build
 *  emits a plain `index.js`). React imports are aliased to shims that read the HOST's instance from
 *  `window.ElowenUiRuntime`, so a bundle can never ship a second React (two copies break hooks). */
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const shim = (name) => fileURLToPath(new URL(`./shims/${name}.cjs`, import.meta.url));

/** This package's own directory — the resolution base for the Tailwind compile below, so
 *  `tailwindcss/theme.css` resolves against the kit's dependencies rather than the plugin's. */
const kitDir = fileURLToPath(new URL('.', import.meta.url));

/** Bundle `entry` into the ESM file at `outfile`. Throws on any build error. */
export async function buildPluginUiBundle({ entry, outfile, minify = false, nodePaths }) {
  await build({
    entryPoints: [entry],
    outfile,
    // Extra module resolution roots — e.g. the host web app's node_modules, so a bundle may use the
    // SAME icon/library versions the app ships without duplicating them in the repo root.
    ...(nodePaths && nodePaths.length > 0 ? { nodePaths } : {}),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    // Modern evergreen browsers — the web app itself targets the same class of engines.
    target: ['es2022'],
    jsx: 'automatic',
    minify,
    legalComments: 'none',
    alias: {
      // esbuild picks the LONGEST matching alias, so the jsx-runtime entries win over plain `react`.
      react: shim('react'),
      'react-dom': shim('react-dom'),
      'react/jsx-runtime': shim('jsx-runtime'),
      'react/jsx-dev-runtime': shim('jsx-runtime'),
    },
  });
}

/** Compile the plugin's OWN stylesheet from the FINISHED bundle at `bundle` and write it to `outfile`.
 *
 *  Why this exists: Elowen ships a PREBUILT web app (`web-dist/` is in `package.json → files`), so on a
 *  user's machine there is no Tailwind and no Next build — the host's CSS is frozen at publish time and
 *  carries only the utilities the HOST itself uses. A plugin from the registry that reaches for any other
 *  utility rendered unstyled there, with nothing the user could do about it. So the plugin brings its own.
 *
 *  Three scoping rules make that safe to drop into a running app, and each is load-bearing:
 *  - everything lands in `@layer utilities`, so the host's own utilities (declared in the same layer, but
 *    earlier in the cascade order the host establishes) are not globally outranked by a plugin's sheet;
 *  - NO preflight — a plugin must never reset the host's elements;
 *  - NO prefix — the plugin shares class names with the shared components it renders from
 *    `window.ElowenUiRuntime`, which are styled by the host's sheet.
 *
 *  The theme is `@reference`d, never imported: referencing emits `var(--token, fallback)` instead of
 *  inlining the value, so the plugin reads the HOST's live variables and follows a skin
 *  (`web/skins/*` override the tokens on `:root[data-skin]`). Inlining them would freeze every plugin
 *  on the default palette. Returns the emitted CSS. */
export async function buildPluginUiCss({ bundle, outfile }) {
  // Loaded lazily so `buildPluginUiBundle` — the far more common call — never pays for Tailwind's
  // native scanner just to bundle JS.
  const { compile } = await import('@tailwindcss/node');
  const { Scanner } = await import('@tailwindcss/oxide');

  const source = resolve(bundle);
  const css = [
    // Declare the layer order the host uses, so `utilities` sorts where the host puts it.
    '@layer theme, base, components, utilities;',
    // Reference-only: gives the compiler the design system (Tailwind's defaults + the host tokens)
    // WITHOUT emitting a single variable or preflight rule of its own.
    '@reference "tailwindcss/theme.css";',
    `@reference ${JSON.stringify(resolve(kitDir, 'theme.css'))};`,
    // The finished bundle is the only scan target: class names survive minification as plain string
    // literals, so the built file is a complete and honest record of what the plugin actually uses.
    `@source ${JSON.stringify(source)};`,
    '@layer utilities { @tailwind utilities; }',
  ].join('\n');

  const compiler = await compile(css, { base: kitDir, onDependency: () => {} });
  const out = compiler.build(new Scanner({ sources: compiler.sources }).scan());
  await mkdir(dirname(resolve(outfile)), { recursive: true });
  await writeFile(resolve(outfile), out, 'utf8');
  return out;
}
