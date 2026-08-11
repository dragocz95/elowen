/** ui-demo — reference plugin for the browser UI platform (plugin platform F0).
 *
 *  The daemon half is deliberately tiny: one authenticated API route the demo page calls. The browser
 *  half lives in web/index.js — a plain ESM bundle registered via window.__elowenRegisterPluginUi and
 *  served by the daemon on an immutable content-hash URL (see the manifest's `web` block).
 */
export function register(ctx) {
  const startedAt = new Date().toISOString();
  ctx.registerApiRoute({
    path: 'stats',
    access: 'user',
    handler: async (req) => ({
      body: {
        plugin: 'ui-demo',
        now: new Date().toISOString(),
        startedAt,
        // Echo the verified identity block so the demo page can show what a plugin API sees.
        you: { userId: req.auth.userId, admin: req.auth.admin },
      },
    }),
  });
}
