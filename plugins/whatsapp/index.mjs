// WhatsApp platform plugin: a Baileys (WhatsApp Web multi-device) client. The bot answers when a
// mapped sender writes to it (direct chat always; in groups on @mention or reply, unless configured to
// answer freely). Each sender — a phone number, a JID, or a whole group JID — resolves via this plugin's
// own senderPolicies config to the Elowen projects they may touch plus an optional role prompt. Unmapped
// senders are ignored.
//
// On top of plain chat it provides: text commands (/model, /thinking, /new, /help, /stop, /status,
// /compact, /restart), a per-chat model picker (native buttons with a numbered-text fallback), live
// streaming replies (edit-in-place with a tool-call trace), a typing indicator, status reactions,
// proactive pushes (cron/tick echoes) via notify(), and admin/owner-gated whatsapp_* tools for group
// management and outbound messaging.
//
// Pairing: on first connect the socket emits a QR (rendered as ASCII into the plugin logs + a PNG in the
// data dir) or, when a phoneNumber is configured, an 8-char pairing code. Credentials persist to the
// data dir and are reused across reconnects.
//
// Buttons caveat: native WhatsApp buttons/list are unreliable on personal accounts (often render blank —
// they are really a Business-API feature). Every interactive prompt therefore ALSO carries a readable
// numbered-text body, and the response parser accepts both a button/list reply AND a plain-text number.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { StateStore } from './lib/state.mjs';
import { WhatsAppAdapter } from './lib/adapter.mjs';
import { registerTools } from './lib/tools.mjs';

export { stripThinking, extractImageRefs, parseModelExec, buildReplyContext, splitContent, footerLine } from './lib/format.mjs';
export { parseAskReply } from './lib/ask.mjs';
export { senderIsAdmin } from './lib/jid.mjs';
export { LiveMessage } from './lib/stream.mjs';

export function register(ctx) {
  const dataDir = ctx.dataDir();
  const state = new StateStore(join(dataDir, 'channel-state.json'));
  const authDir = join(dataDir, 'auth');
  try { mkdirSync(authDir, { recursive: true }); } catch { /* exists */ }
  // The image-gen/image-edit plugins are data-dir siblings — their generated PNGs upload from there.
  const imageDirs = [join(dataDir, '..', 'image-gen'), join(dataDir, '..', 'image-edit')];
  const adapter = new WhatsAppAdapter({ ...ctx.config }, ctx.logger, state, ctx.listModels, imageDirs, authDir, join(dataDir, 'qr.png'), ctx.answerQuestion, ctx.chatCommands('whatsapp'));
  ctx.registerPlatform(adapter);
  registerTools(ctx, adapter);
  ctx.logger.info('whatsapp platform registered (text commands + model picker + streaming + group tools)');
}
