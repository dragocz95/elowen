/** esbuild toolchain for plugin browser-UI bundles: one TS/TSX/JS entry → one self-contained
 *  same-origin ESM file the daemon serves on a content-hash URL (the daemon hashes it — the build
 *  emits a plain `index.js`). React imports are aliased to shims that read the HOST's instance from
 *  `window.ElowenUiRuntime`, so a bundle can never ship a second React (two copies break hooks). */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const shim = (name) => fileURLToPath(new URL(`./shims/${name}.cjs`, import.meta.url));

/** Bundle `entry` into the ESM file at `outfile`. Throws on any build error. */
export async function buildPluginUiBundle({ entry, outfile, minify = false }) {
  await build({
    entryPoints: [entry],
    outfile,
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
