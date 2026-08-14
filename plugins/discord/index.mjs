// Discord platform plugin: a dependency-free gateway client (Node's global WebSocket + fetch).
// The bot answers when mentioned in a server; the sender's Discord roles resolve — via this plugin's
// own rolePolicies config — to the Elowen projects they may touch plus an extra role prompt (a per-role
// instructions pattern). Unmapped senders (and DMs, which carry no roles) are ignored.
//
// On top of plain chat it provides: slash commands (/model, /reasoning, /display, /new, /help), per-channel model
// and presentation settings, a stateful live tool trace with independent answer delivery, a
// typing indicator, proactive pushes (cron/tick echoes) via notify(), and an admin-only `DiscordApi`
// tool for server management (messages, roles, channels — the whole REST surface).
import { join } from 'node:path';
import { StateStore } from './lib/state.mjs';
import { DiscordAdapter } from './lib/adapter.mjs';
import { registerTools } from './lib/tools.mjs';
import { listGuildChannels } from './lib/channels.mjs';
import { platformImageDirs } from 'elowen-plugin-shared/images';

export { stripForSpeech, extractImageRefs, stripThinking, parseModelExec, memberIsAdmin, displayNameOf, resolveMentions, buildReplyContext, splitContent, footerLine, withoutFooter } from './lib/format.mjs';
export { buildAskComponents } from './lib/ask.mjs';
export { LiveMessage } from './lib/stream.mjs';
export { resolveDisplaySettings, updateDisplayOverrides } from './lib/display.mjs';

export function register(ctx) {
  // Registered BEFORE the token check: an instance with the plugin on but no bot token still shows a
  // channel picker, and it must answer "no destinations" rather than 404 — which is exactly what this
  // said as a core route. Bailing out first would turn an empty picker into a broken one.
  ctx.registerApiRoute({
    rootMount: '/plugins/discord/channels', path: '', method: 'GET', access: 'admin',
    handler: async (req) => {
      if (req.path !== '') return { status: 404, body: { error: 'not found' } };
      return { body: await listGuildChannels(ctx.config) };
    },
  });

  const token = typeof ctx.config.botToken === 'string' ? ctx.config.botToken.trim() : '';
  if (!token) { ctx.logger.warn('enabled but no botToken configured — not connecting'); return; }
  const dataDir = ctx.dataDir();
  const state = new StateStore(join(dataDir, 'channel-state.json'));
  const imageDirs = platformImageDirs(dataDir);
  // Pass chatCommands LAZILY (a function, not a snapshot) so a plugin registered after Discord — or a live
  // plugin reload — is always reflected in the registered slash set, /help and dispatch.
  const adapter = new DiscordAdapter({ ...ctx.config, botToken: token }, ctx.logger, state, ctx.listModels, imageDirs, ctx.resolveProvider, ctx.answerQuestion, () => ctx.chatCommands('discord'));
  ctx.registerPlatform(adapter);
  registerTools(ctx, adapter);
  ctx.logger.info('discord platform registered (slash commands + per-channel display + live tools + server tools)');
}
