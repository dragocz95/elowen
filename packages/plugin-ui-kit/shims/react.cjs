// Compiled INTO every plugin bundle in place of `react` (see build.js): the plugin must render with
// the HOST's React instance — a second copy breaks hooks and context. CJS on purpose: esbuild turns
// named ESM imports from a CJS module into property accesses, so `import { useState } from 'react'`
// works without enumerating React's exports here.
const runtime = typeof window !== 'undefined' ? window.ElowenUiRuntime : undefined;
if (!runtime) throw new Error('elowen-plugin-ui-kit: window.ElowenUiRuntime is missing — plugin bundles only run inside the Elowen web app');
module.exports = runtime.react;
