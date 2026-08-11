// See shims/react.cjs — same trick for `react-dom`. Note there is deliberately NO shim for
// `react-dom/client`: a plugin never owns a root (the host renders its components), so an import of
// createRoot should fail the build loudly instead of resolving to undefined at runtime.
const runtime = typeof window !== 'undefined' ? window.ElowenUiRuntime : undefined;
if (!runtime) throw new Error('@elowen/plugin-ui-kit: window.ElowenUiRuntime is missing — plugin bundles only run inside the Elowen web app');
module.exports = runtime.reactDom;
