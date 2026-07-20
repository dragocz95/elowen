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
        + 'except the ONE types-only file src/shared/wireContract.ts (the daemon↔web wire contract). The '
        + 'rest of src/shared/ is runtime Node code (logger, apiClient, execs, …) the web must not bundle.',
      from: { path: '^web/' },
      to: { path: '^src/', pathNot: '^src/shared/wireContract\\.ts$' },
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
    exclude: { path: 'node_modules|/dist/|/web-dist/|/\\.next/|/coverage/|web/public/|web/tests/e2e/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    },
  },
};
