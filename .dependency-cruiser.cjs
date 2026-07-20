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
        + 'except src/shared/ which is the framework-neutral daemon↔web wire contract (types only).',
      from: { path: '^web/' },
      to: { path: '^src/', pathNot: '^src/shared/' },
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
    exclude: { path: 'node_modules|/dist/|/web-dist/|/\\.next/|/coverage/|web/public/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    },
  },
};
