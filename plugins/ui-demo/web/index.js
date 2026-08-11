/** ui-demo browser bundle — written as plain JS on purpose: the runtime contract needs no build step
 *  for a simple page (React and the curated components come from window.ElowenUiRuntime), which keeps
 *  this file an honest, dependency-free template for plugin authors. */
const runtime = window.ElowenUiRuntime;
const { react: React, components, api } = runtime;
const h = React.createElement;

function Row(label, value) {
  return h('div', { className: 'flex items-center justify-between gap-4 border-b border-border/60 py-2 text-sm', key: label },
    h('span', { className: 'text-text-muted' }, label),
    h('span', { className: 'font-mono' }, value));
}

function DemoPage({ plugin }) {
  const [stats, setStats] = React.useState(null);
  const [error, setError] = React.useState(false);
  const load = React.useCallback(() => {
    setError(false);
    api(`/plugins/${plugin}/api/stats`).then(setStats).catch(() => setError(true));
  }, [plugin]);
  React.useEffect(() => { load(); }, [load]);

  return h('div', { className: 'max-w-xl space-y-4', 'data-testid': 'ui-demo-page' },
    h('h1', { className: 'text-lg font-semibold' }, 'Plugin UI demo'),
    h('p', { className: 'text-sm text-text-muted' },
      'This page is rendered from a runtime plugin bundle. It calls the plugin\u2019s own authenticated API route below.'),
    error
      ? h('p', { className: 'text-sm text-danger' }, 'The plugin API call failed.')
      : stats
        ? h('div', { className: 'rounded-lg border border-border bg-surface px-4 py-2' },
            Row('Server time', stats.now),
            Row('Plugin loaded at', stats.startedAt),
            Row('Seen as user id', String(stats.you.userId)),
            Row('Admin', stats.you.admin ? 'yes' : 'no'))
        : h('p', { className: 'text-sm text-text-muted' }, 'Loading\u2026'),
    h(components.Button, { onClick: load }, 'Refresh'));
}

window.__elowenRegisterPluginUi('ui-demo', {
  requiresApiVersion: 1,
  pages: { '': DemoPage },
});
