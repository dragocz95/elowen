// Discord platform plugin: a dependency-free gateway client (Node's global WebSocket + fetch).
// The bot answers when mentioned in a server; the sender's Discord roles resolve — via this plugin's
// own rolePolicies config — to the Elowen projects they may touch plus an extra role prompt (a per-role
// instructions pattern). Unmapped senders (and DMs, which carry no roles) are ignored.
//
// On top of plain chat it provides: slash commands (/model, /reasoning, /display, /new, /help), per-channel model
// and presentation settings, a stateful live tool trace with independent answer delivery, a
// typing indicator, proactive pushes (cron/tick echoes) via notify(), and an admin-only `discord_api`
// tool for server management (messages, roles, channels — the whole REST surface).
import { join } from 'node:path';
import { StateStore } from './lib/state.mjs';
import { DiscordAdapter } from './lib/adapter.mjs';
import { registerTools } from './lib/tools.mjs';

export { stripForSpeech, extractImageRefs, stripThinking, parseModelExec, memberIsAdmin, displayNameOf, resolveMentions, buildReplyContext, splitContent, footerLine } from './lib/format.mjs';
export { askUsesButtons, buildAskComponents } from './lib/ask.mjs';
export { LiveMessage } from './lib/stream.mjs';
export { resolveDisplaySettings, updateDisplayOverrides } from './lib/display.mjs';

export function register(ctx) {
  const token = typeof ctx.config.botToken === 'string' ? ctx.config.botToken.trim() : '';
  if (!token) { ctx.logger.warn('enabled but no botToken configured — not connecting'); return; }
  const dataDir = ctx.dataDir();
  const state = new StateStore(join(dataDir, 'channel-state.json'));
  // The image-gen/image-edit plugins are data-dir siblings — their generated PNGs upload from there.
  const imageDirs = [join(dataDir, '..', 'image-gen'), join(dataDir, '..', 'image-edit')];
  const adapter = new DiscordAdapter({ ...ctx.config, botToken: token }, ctx.logger, state, ctx.listModels, imageDirs, ctx.resolveProvider, ctx.answerQuestion, ctx.chatCommands('discord'));
  ctx.registerPlatform(adapter);
  registerTools(ctx, adapter);
  ctx.logger.info('discord platform registered (slash commands + per-channel display + live tools + server tools)');
}
