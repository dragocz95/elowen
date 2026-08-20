// Microsoft Teams platform plugin: an Azure Bot Framework bot. Inbound activities arrive on the daemon
// webhook /hooks/msteams/messages (Microsoft's JWT is validated there); replies, typing indicators and
// media go out through the Bot Connector REST API with an Entra client-credentials token. Each sender —
// an Entra object ID, a UPN/email, or a whole conversation id — resolves via this plugin's rolePolicies
// to the Elowen projects they may touch plus an optional role prompt. Unmapped senders are ignored unless
// delegated account linking explicitly admits verified active tenant members.
import { join } from 'node:path';
import { StateStore } from './lib/state.mjs';
import { MsTeamsAdapter } from './lib/adapter.mjs';
import { PeopleDirectory } from './lib/directory.mjs';
import { TeamsAccountLinking } from './lib/accountLinking.mjs';
import { registerTools } from './lib/tools.mjs';
import { registerMicrosoftTools } from './lib/microsoftTools.mjs';
import { readBrand } from './lib/brand.mjs';
import { platformImageDirs } from 'elowen-plugin-shared/images';

export { matchesId, senderIds, senderIsAdmin, displayNameOf } from './lib/ids.mjs';
export { splitContent, footerLine, CHUNK } from './lib/format.mjs';
export { makeTokenVerifier } from './lib/auth.mjs';
export { ConnectorClient } from './lib/connector.mjs';
export { TeamsAccountError, TeamsAccountLinking } from './lib/accountLinking.mjs';

/** Browser-safe projection of the learned Teams directory. Routing details stay daemon-only. */
export function peopleForUi(people, profilePhotos = false, bindingFor = () => null) {
  return people.map((person) => {
    const binding = person.aad ? bindingFor(person.aad) : null;
    return {
      key: String(person.key),
      name: typeof person.name === 'string' ? person.name : '',
      upn: typeof person.upn === 'string' ? person.upn : '',
      aadObjectId: typeof person.aad === 'string' ? person.aad : '',
      teamsId: typeof person.id === 'string' ? person.id : '',
      teamsAvatarUrl: profilePhotos && person.aad ? `/api/plugins/msteams/people/${encodeURIComponent(String(person.aad))}/avatar` : '',
      hasPersonalChat: Boolean(person.conv),
      lastSeenAt: Number(person.at) || null,
      identity: binding ? { linked: true, user: binding.user, ...(binding.linkedAt ? { linkedAt: binding.linkedAt } : {}) } : { linked: false },
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.upn.localeCompare(b.upn));
}

/** Browser-safe proactive-message targets learned from real Teams traffic. Connector routing details
 * (serviceUrl, tenant, bot id) stay inside channel-state.json and never cross the API boundary. */
export function notificationDestinationsForUi(state, people) {
  const destinations = [];
  const seen = new Set();
  for (const person of people.list()) {
    const id = typeof person.conv === 'string' ? person.conv.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    destinations.push({
      id,
      kind: 'person',
      label: person.name || person.upn || 'Teams direct chat',
      group: 'Microsoft Teams · Direct chats',
      ...(person.upn ? { subtitle: person.upn } : {}),
    });
  }
  for (const [id, entry] of Object.entries(state.all())) {
    if (id.startsWith('_') || seen.has(id) || !entry || typeof entry !== 'object') continue;
    const ref = entry.ref;
    if (!ref || typeof ref !== 'object' || typeof ref.serviceUrl !== 'string') continue;
    const type = String(ref.conversationType ?? '');
    const channel = type === 'channel';
    const label = String(ref.channelName ?? ref.conversationName ?? '').trim()
      || `${channel ? 'Teams channel' : 'Teams chat'} · ${id.slice(0, 18)}${id.length > 18 ? '…' : ''}`;
    seen.add(id);
    destinations.push({
      id,
      kind: channel ? 'channel' : 'chat',
      label,
      group: channel
        ? (ref.teamName ? `Microsoft Teams · ${ref.teamName}` : 'Microsoft Teams · Channels')
        : 'Microsoft Teams · Chats',
    });
  }
  return destinations;
}

export function register(ctx) {
  // The sideloadable app package (manifest + icons) an admin uploads to the org's Teams app catalog,
  // built by the live adapter from the current config. Registered UP FRONT and reporting 503 while no
  // adapter exists — precisely what this answered as a core route, which looked the adapter up among
  // the registered platforms and 503'd when it found none. Registering it after the credential check
  // would turn that into a 404 on an enabled-but-unconfigured instance.
  let adapter = null;
  let accountLinking = null;
  const dataDir = ctx.dataDir();
  const state = new StateStore(join(dataDir, 'channel-state.json'));
  const people = new PeopleDirectory(state, ctx.logger);
  ctx.registerNotificationDestinationProvider({
    platform: 'msteams',
    list: () => notificationDestinationsForUi(state, people),
  });
  const brand = readBrand(dataDir, ctx.logger);
  const agentName = typeof ctx.config.agentName === 'string' && ctx.config.agentName.trim()
    ? ctx.config.agentName.trim()
    : brand.agentName;
  const productName = typeof ctx.config.productName === 'string' && ctx.config.productName.trim()
    ? ctx.config.productName.trim()
    : brand.productName;
  const fileStem = agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'elowen';
  ctx.registerApiRoute({
    rootMount: '/plugins/msteams/app-package', path: '', method: 'GET', access: 'admin',
    handler: async (req) => {
      if (req.path !== '') return { status: 404, body: { error: 'not found' } };
      if (!adapter?.appPackage) return { status: 503, body: { error: 'msteams plugin not enabled' } };
      return {
        body: new Uint8Array(adapter.appPackage()),
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${fileStem}-teams-app.zip"`,
        },
      };
    },
  });
  ctx.registerApiRoute({
    rootMount: '/plugins/msteams/people', path: '', method: 'GET', access: 'admin',
    handler: async (req) => {
      if (req.path !== '') return { status: 404, body: { error: 'not found' } };
      return {
        body: {
          active: adapter !== null,
          people: peopleForUi(people.list(), Boolean(adapter?.graph), (objectId) => accountLinking?.bindingFor(objectId) ?? null),
        },
      };
    },
  });
  ctx.registerApiRoute({
    rootMount: '/plugins/msteams/people/:id/account', path: '', method: 'GET', access: 'admin',
    handler: async (req) => {
      if (req.path !== '' || !accountLinking) return { status: accountLinking ? 404 : 503, body: { error: accountLinking ? 'not found' : 'Microsoft account linking is not configured' } };
      const { person } = people.resolve({ aadObjectId: req.params.id });
      if (!person) return { status: 404, body: { error: 'Teams person not found' } };
      return { body: await accountLinking.accountStatus(person) };
    },
  });
  ctx.registerApiRoute({
    rootMount: '/plugins/msteams/people/:id/account', path: '', method: 'PATCH', access: 'admin',
    handler: async (req) => {
      if (req.path !== '' || !accountLinking) return { status: accountLinking ? 404 : 503, body: { error: accountLinking ? 'not found' : 'Microsoft account linking is not configured' } };
      const { person } = people.resolve({ aadObjectId: req.params.id });
      if (!person) return { status: 404, body: { error: 'Teams person not found' } };
      const body = await req.json();
      const userId = Number(body?.userId);
      if (!Number.isInteger(userId) || userId <= 0) return { status: 400, body: { error: 'userId must be a positive integer' } };
      try {
        await accountLinking.linkExisting(person, userId, body?.replace === true);
        return { body: await accountLinking.accountStatus(person) };
      } catch (error) {
        const conflict = /already|linked|replace|conflict/i.test(String(error?.message ?? ''));
        return { status: conflict ? 409 : 400, body: { error: error?.message ?? String(error) } };
      }
    },
  });
  ctx.registerApiRoute({
    rootMount: '/plugins/msteams/people/:id/signout', path: '', method: 'POST', access: 'admin',
    handler: async (req) => {
      if (req.path !== '' || !accountLinking) return { status: accountLinking ? 404 : 503, body: { error: accountLinking ? 'not found' : 'Microsoft account linking is not configured' } };
      const { person } = people.resolve({ aadObjectId: req.params.id });
      if (!person) return { status: 404, body: { error: 'Teams person not found' } };
      await accountLinking.signOutPerson(person);
      return { body: await accountLinking.accountStatus(person) };
    },
  });
  ctx.registerApiRoute({
    rootMount: '/plugins/msteams/people/:id/avatar', path: '', method: 'GET', access: 'admin',
    handler: async (req) => {
      if (req.path !== '' || !adapter) return { status: 404, body: { error: 'not found' } };
      const photo = await adapter.personPhoto(req.params.id).catch((error) => {
        ctx.logger.warn(`msteams profile photo: ${error?.message ?? error}`);
        return null;
      });
      if (!photo) return { status: 404, body: { error: 'not found' } };
      return { body: photo.body, headers: { 'content-type': photo.contentType, 'cache-control': 'private, max-age=300' } };
    },
  });

  const appId = typeof ctx.config.appId === 'string' ? ctx.config.appId.trim() : '';
  const appPassword = typeof ctx.config.appPassword === 'string' ? ctx.config.appPassword.trim() : '';
  const tenantId = typeof ctx.config.tenantId === 'string' ? ctx.config.tenantId.trim() : '';
  if (!appId || !appPassword || !tenantId) {
    ctx.logger.warn('enabled but appId/appPassword/tenantId are not all configured — not connecting');
    return;
  }
  const imageDirs = platformImageDirs(dataDir);
  const config = { ...ctx.config, appId, appPassword, tenantId, agentName, productName, brandIcon: brand.icon };
  if (config.accountLinking === true) {
    const connectionName = typeof config.oauthConnectionName === 'string' ? config.oauthConnectionName.trim() : '';
    if (connectionName) {
      config.oauthConnectionName = connectionName;
      accountLinking = new TeamsAccountLinking(config, ctx.host.externalUsers(), ctx.logger);
    } else {
      // Keep the transport up for diagnostics, but every mapped message fails closed in the adapter.
      ctx.logger.error('msteams account linking enabled without oauthConnectionName — account access denied');
    }
  }
  // chatCommands passes LAZILY (a function) so a plugin registered after msteams — or a live reload —
  // is always reflected in /help and dispatch.
  adapter = new MsTeamsAdapter(
    config,
    ctx.logger, state, ctx.listModels, imageDirs, ctx.resolveProvider, ctx.answerQuestion,
    () => ctx.chatCommands('msteams'),
    // Accounts a rolePolicy may name in `elowenUser`, so a Teams sender can act as their own Elowen
    // user. Read live: an account added after startup must be nameable without restarting the plugin.
    () => ctx.host.stores().usersRead.list(),
    accountLinking,
  );
  ctx.registerHttpRoute({ path: 'messages', handler: (req) => adapter.handleWebhook(req) });
  ctx.registerPlatform(adapter);
  registerTools(ctx, adapter);
  registerMicrosoftTools(ctx, accountLinking, config);
  ctx.logger.info('msteams platform registered (webhook /hooks/msteams/messages + Teams and delegated Microsoft 365 tools)');
}
