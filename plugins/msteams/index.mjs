// Microsoft Teams platform plugin: an Azure Bot Framework bot. Inbound activities arrive on the daemon
// webhook /hooks/msteams/messages (Microsoft's JWT is validated there); replies, typing indicators and
// media go out through the Bot Connector REST API with an Entra client-credentials token. Each sender —
// an Entra object ID, a UPN/email, or a whole conversation id — resolves via this plugin's rolePolicies
// to the Elowen projects they may touch plus an optional role prompt. Unmapped senders are ignored.
import { join } from 'node:path';
import { StateStore } from './lib/state.mjs';
import { MsTeamsAdapter } from './lib/adapter.mjs';
import { registerTools } from './lib/tools.mjs';
import { platformImageDirs } from '../_shared/images.mjs';

export { matchesId, senderIds, senderIsAdmin, displayNameOf } from './lib/ids.mjs';
export { splitContent, footerLine, CHUNK } from './lib/format.mjs';
export { makeTokenVerifier } from './lib/auth.mjs';
export { ConnectorClient } from './lib/connector.mjs';

export function register(ctx) {
  // The sideloadable app package (manifest + icons) an admin uploads to the org's Teams app catalog,
  // built by the live adapter from the current config. Registered UP FRONT and reporting 503 while no
  // adapter exists — precisely what this answered as a core route, which looked the adapter up among
  // the registered platforms and 503'd when it found none. Registering it after the credential check
  // would turn that into a 404 on an enabled-but-unconfigured instance.
  let adapter = null;
  ctx.registerApiRoute({
    rootMount: '/plugins/msteams/app-package', path: '', method: 'GET', access: 'admin',
    handler: async (req) => {
      if (req.path !== '') return { status: 404, body: { error: 'not found' } };
      if (!adapter?.appPackage) return { status: 503, body: { error: 'msteams plugin not enabled' } };
      return {
        body: new Uint8Array(adapter.appPackage()),
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="elowen-teams-app.zip"',
        },
      };
    },
  });

  const appId = typeof ctx.config.appId === 'string' ? ctx.config.appId.trim() : '';
  const appPassword = typeof ctx.config.appPassword === 'string' ? ctx.config.appPassword.trim() : '';
  const tenantId = typeof ctx.config.tenantId === 'string' ? ctx.config.tenantId.trim() : '';
  if (!appId || !appPassword || !tenantId) {
    ctx.logger.warn('enabled but appId/appPassword/tenantId are not all configured — not connecting');
    return;
  }
  const dataDir = ctx.dataDir();
  const state = new StateStore(join(dataDir, 'channel-state.json'));
  const imageDirs = platformImageDirs(dataDir);
  // chatCommands passes LAZILY (a function) so a plugin registered after msteams — or a live reload —
  // is always reflected in /help and dispatch.
  adapter = new MsTeamsAdapter(
    { ...ctx.config, appId, appPassword, tenantId },
    ctx.logger, state, ctx.listModels, imageDirs, ctx.resolveProvider, ctx.answerQuestion,
    () => ctx.chatCommands('msteams'),
  );
  ctx.registerHttpRoute({ path: 'messages', handler: (req) => adapter.handleWebhook(req) });
  ctx.registerPlatform(adapter);
  registerTools(ctx, adapter);
  ctx.logger.info('msteams platform registered (webhook /hooks/msteams/messages + chat tools)');
}
