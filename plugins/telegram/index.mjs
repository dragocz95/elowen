// Telegram platform plugin: a grammY (Bot API, long-polling) client. The bot answers when a mapped
// sender writes to it (direct chats always; in groups on @mention or reply, unless configured to answer
// freely). Each sender — a numeric Telegram user id, an @username, or a whole chat id — resolves via this
// plugin's own rolePolicies config to the Elowen projects they may touch plus an optional role prompt.
// Unmapped senders are ignored.
//
// On top of plain chat it provides: slash commands (/model, /reasoning, /display, /new, /help), per-chat
// model and presentation settings, a stateful live tool trace with independent answer delivery, a typing
// indicator, status reactions, proactive pushes (cron/tick echoes) via notify(), voice STT/TTS, and
// admin/owner-gated telegram_* tools for chat and group management.
import { join } from 'node:path';
import { StateStore } from './lib/state.mjs';
import { TelegramAdapter } from './lib/adapter.mjs';
import { registerTools } from './lib/tools.mjs';

export { stripForSpeech, extractImageRefs, stripThinking, parseModelExec, buildReplyContext, splitContent, footerLine } from './lib/format.mjs';
export { askUsesButtons, buildAskKeyboard } from './lib/ask.mjs';
export { senderIsAdmin, matchesId, senderIds, displayNameOf } from './lib/ids.mjs';
export { LiveMessage } from './lib/stream.mjs';
export { resolveDisplaySettings, updateDisplayOverrides } from './lib/display.mjs';

export function register(ctx) {
  const token = typeof ctx.config.botToken === 'string' ? ctx.config.botToken.trim() : '';
  if (!token) { ctx.logger.warn('enabled but no botToken configured — not connecting'); return; }
  const dataDir = ctx.dataDir();
  const state = new StateStore(join(dataDir, 'channel-state.json'));
  // The image-gen/image-edit plugins are data-dir siblings — their generated PNGs upload from there.
  const imageDirs = [join(dataDir, '..', 'image-gen'), join(dataDir, '..', 'image-edit')];
  const adapter = new TelegramAdapter({ ...ctx.config, botToken: token }, ctx.logger, state, ctx.listModels, imageDirs, ctx.resolveProvider, ctx.answerQuestion, ctx.chatCommands('telegram'));
  ctx.registerPlatform(adapter);
  registerTools(ctx, adapter);
  ctx.logger.info('telegram platform registered (slash commands + per-chat display + live tools + chat tools)');
}
