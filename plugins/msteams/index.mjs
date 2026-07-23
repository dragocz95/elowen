// Microsoft Teams platform plugin: an Azure Bot Framework bot. Inbound activities arrive on the daemon
// webhook /hooks/msteams/messages (Microsoft's JWT is validated there); replies, typing indicators and
// media go out through the Bot Connector REST API with an Entra client-credentials token. Each sender —
// an Entra object ID, a UPN/email, or a whole conversation id — resolves via this plugin's rolePolicies
// to the Elowen projects they may touch plus an optional role prompt. Unmapped senders are ignored.
import { join } from 'node:path';
import { StateStore } from './lib/state.mjs';
import { MsTeamsAdapter } from './lib/adapter.mjs';
import { registerTools } from './lib/tools.mjs';

export { matchesId, senderIds, senderIsAdmin, displayNameOf } from './lib/ids.mjs';
export { splitContent, buildReplyContext, footerLine, CHUNK } from './lib/format.mjs';
export { makeTokenVerifier } from './lib/auth.mjs';
export { ConnectorClient } from './lib/connector.mjs';

export function register(ctx) {
  const appId = typeof ctx.config.appId === 'string' ? ctx.config.appId.trim() : '';
  const appPassword = typeof ctx.config.appPassword === 'string' ? ctx.config.appPassword.trim() : '';
  const tenantId = typeof ctx.config.tenantId === 'string' ? ctx.config.tenantId.trim() : '';
  if (!appId || !appPassword || !tenantId) {
    ctx.logger.warn('enabled but appId/appPassword/tenantId are not all configured — not connecting');
    return;
  }
  const dataDir = ctx.dataDir();
  const state = new StateStore(join(dataDir, 'channel-state.json'));
  // The image-gen/image-edit plugins are data-dir siblings — their generated PNGs upload from there.
  const imageDirs = [join(dataDir, '..', 'image-gen'), join(dataDir, '..', 'image-edit')];
  // chatCommands passes LAZILY (a function) so a plugin registered after msteams — or a live reload —
  // is always reflected in /help and dispatch.
  const adapter = new MsTeamsAdapter(
    { ...ctx.config, appId, appPassword, tenantId },
    ctx.logger, state, ctx.listModels, imageDirs, ctx.resolveProvider, ctx.answerQuestion,
    () => ctx.chatCommands('msteams'),
  );
  ctx.registerHttpRoute({ path: 'messages', handler: (req) => adapter.handleWebhook(req) });
  ctx.registerPlatform(adapter);
  registerTools(ctx, adapter);
  ctx.logger.info('msteams platform registered (webhook /hooks/msteams/messages + chat tools)');
}
