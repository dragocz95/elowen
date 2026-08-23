/**
 * dependency-cruiser — architecture guard. Complements knip (dead code) and ESLint (dead imports):
 * here we forbid circular dependencies, flag orphan modules, and keep the backend (`src/`) and the web
 * app (`web/`) from importing each other. Run `npm run depcruise`; `npm run depgraph` renders an SVG
 * (needs graphviz `dot`).
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make modules hard to reason about, test and tree-shake.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan modules (nothing imports them) are usually dead code — confirm and remove.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)[^/]+\\.config\\.(ts|js|mjs|cjs)$',
          '(^|/)tests?/',
          '\\.(test|spec)\\.',
          '(^|/)scripts/',
          '(^|/)src/daemon/index\\.ts$',
          '(^|/)web/(app|instrumentation|proxy)',
          // A plugin's entry is loaded dynamically by the plugin loader, never imported statically —
          // both the TypeScript compile units and the JavaScript plugins that ship an index.mjs.
          '(^|/)plugins/[^/]+/src/index\\.ts$',
          '(^|/)plugins/[^/]+/index\\.mjs$',
        ],
      },
      to: {},
    },
    {
      name: 'backend-not-to-web',
      severity: 'error',
      comment: 'The daemon/backend (src) must never import the web app (web).',
      from: { path: '^src/' },
      to: { path: '^web/' },
    },
    {
      name: 'web-not-to-backend',
      severity: 'error',
      comment: 'The web app (web) talks to the daemon over HTTP — it must never import src/ directly, '
        + 'except the ONE types-only file src/shared/wireContract.ts (the daemon<->web wire contract). It is '
        + 'the exception because a TYPE-ONLY import is erased before the bundler resolves it; RUNTIME code '
        + 'here fails `next build`, which neither tsc nor vitest catches. The '
        + 'rest of src/shared/ is runtime Node code (logger, apiClient, execs, …) the web must not bundle.',
      from: { path: '^web/' },
      to: { path: '^src/', pathNot: '^src/shared/wireContract\\.ts$' },
    },
    {
      name: 'core-not-to-plugins',
      severity: 'error',
      comment: 'The daemon core (src) must NEVER import a plugin — not even type-only. The contract '
        + 'lives in src/plugins/api.ts (AgentsControl, LspControl and friends) + src/shared/agentEvents.ts; '
        + 'core reaches a running subsystem exclusively through the loaded registry\'s control.',
      from: { path: '^src/' },
      to: { path: '^plugins/' },
    },
    {
      name: 'plugin-runtime-not-to-core',
      severity: 'error',
      comment: 'A plugin may import src/ TYPE-ONLY (erased at compile time — PluginContext, store '
        + 'contracts, seam shapes). A runtime import would drag the daemon\'s module graph into the '
        + 'built plugin and break its process independence; a plugin reaches the host through the '
        + 'context it is handed. The rule is written for ALL of plugins/ rather than once per plugin '
        + 'name, so a plugin added tomorrow is guarded the day it lands instead of the day someone '
        + 'remembers to name it here.',
      from: { path: '^plugins/' },
      to: { path: '^src/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'plugin-shared-not-to-core',
      severity: 'error',
      comment: 'packages/plugin-shared ships to npm as @elowen/plugin-shared and is imported by plugins '
        + 'that may live in another repository entirely, where src/ does not exist — so unlike plugins/ it '
        + 'may not reach into the daemon even type-only. What it needs from the host it takes as an '
        + 'argument. Two contract tests pin its behaviour against the daemon (inlineReasoningParity, '
        + 'lifecycleMessageParity); that pinning is a comparison of source text, never an import.',
      from: { path: '^packages/plugin-shared/' },
      to: { path: '^(src|web|plugins)/' },
    },
    {
      name: 'plugin-bundle-not-to-web-app',
      severity: 'error',
      comment: 'A plugin browser bundle (plugins/*/web-src) is built standalone by elowen-plugin-ui-kit '
        + 'and must reach the app ONLY through window.ElowenUiRuntime, narrowed in its own runtime module. '
        + 'Importing web/ would bundle a second copy of the app (a second react-query client, a second set '
        + 'of components) into a file the daemon serves next to the real one. Its TESTS are exempt: they '
        + 'run inside the web app and install the real runtime from web/lib/pluginUi.',
      from: { path: '^plugins/[^/]+/web-src/', pathNot: '\\.(test|spec)\\.[tj]sx?$' },
      to: { path: '^web/' },
    },
    {
      name: 'no-test-in-prod',
      severity: 'error',
      comment: 'Production code must not import test files.',
      from: { pathNot: '(^|/)tests?/|\\.(test|spec)\\.' },
      to: { path: '(^|/)tests?/|\\.(test|spec)\\.' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // web/public is vendored static output (Monaco editor bundle, model icons) — not source.
    // web/tests/e2e is the Playwright harness: a standalone fake daemon + specs that deliberately
    // type-only-import src/brain/events (the wire contract) and `@playwright/test`; it is not part of
    // the web app's module graph, so keep it out of the architecture guard entirely.
    exclude: { path: 'node_modules|/dist/|/web-dist/|/\\.next/|/coverage/|web/public/|web/tests/e2e/|plugins/[^/]+/web/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    },
  },
};
