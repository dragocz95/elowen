// See shims/react.cjs — same trick for `react/jsx-runtime` (and jsx-dev-runtime), which esbuild's
// `jsx: 'automatic'` mode imports from every file containing JSX.
const runtime = typeof window !== 'undefined' ? window.ElowenUiRuntime : undefined;
if (!runtime) throw new Error('@elowen/plugin-ui-kit: window.ElowenUiRuntime is missing — plugin bundles only run inside the Elowen web app');
module.exports = runtime.jsxRuntime;
