// Telegram binding for the shared live-message engine (../../_shared/liveMessage.mjs): the grammY
// transport (bot.api.sendMessage / editMessageText / deleteMessage via the adapter's tg* helpers), the
// plain-text render style, and the final-answer image strategy (photos ahead of the text). The throttled
// editable message, the streaming answer and the brain-event reducer all live in the shared engine — only
// the pieces that genuinely differ from Discord/other surfaces stay here. Telegram messages are sent
// without a parse_mode, so the markdown decorations render as plain text.
import { CHUNK, extractImageRefs, splitContent, footerLine } from './format.mjs';
import { createLiveMessage } from '../../_shared/liveMessage.mjs';

/** Post a final text to a chat. Generated-image links become real Telegram photo uploads (their relative
 *  daemon URLs are dead text here): the links are stripped and the images ride ahead of the (possibly
 *  split) text. Text without image links — or an adapter without image dirs (tests use bare fakes) —
 *  keeps the plain send path. */
export async function postWithImages(adapter, chatId, text, replyToId) {
  const { cleaned, files } = extractImageRefs(text);
  const data = typeof adapter.resolveImageFiles === 'function' ? adapter.resolveImageFiles(files) : [];
  const reply = replyToId ? { reply_parameters: { message_id: replyToId, allow_sending_without_reply: true } } : {};
  if (data.length && typeof adapter.sendPhotos === 'function') await adapter.sendPhotos(chatId, data, reply);
  const body = data.length ? cleaned.trim() : text;
  if (!body) return; // image-only reply — the photos already stand alone
  const pieces = splitContent(body);
  for (let i = 0; i < pieces.length; i++) {
    // Anchor the first text piece to the trigger only when no image preceded it (else the image carried it).
    await adapter.tgSend(chatId, pieces[i], i === 0 && !data.length ? reply : {});
  }
}

// The grammY transport for one editable message. Each closure receives the adapter so it calls the same
// tg* helpers the plugin tests mock. Create returns the new message id (null on failure), edit returns
// whether the edit landed, remove is best-effort delete (tgDelete swallows its own errors).
const transport = {
  create: (a, chatId, content, extra) => a.tgSend(chatId, content, extra).then((id) => id ?? null),
  edit: (a, chatId, messageId, content) => a.tgEdit(chatId, messageId, content),
  remove: (a, chatId, messageId) => a.tgDelete(chatId, messageId),
  replyRef: (replyToId) => ({ reply_parameters: { message_id: replyToId, allow_sending_without_reply: true } }),
  hasImages: (a) => typeof a.resolveImageFiles === 'function' && typeof a.sendPhotos === 'function',
  postImages: (a, chatId, data) => a.sendPhotos(chatId, data, {}),
};

// Telegram sends plain text (no parse_mode), so the style is all-identity — nothing to escape
// (mentions/fences are inert) and no bold/strike/italic/subtext markers — with a plain `  ↳` output line.
// The fold rule and summaries come from the shared core (../../_shared/liveTrace.mjs).
const style = {
  mentionSafe: (s) => s,
  fenceSafe: (s) => s,
  bold: (s) => s,
  strike: (s) => s,
  italic: (s) => s,
  subtext: (s) => s,
  summaryLine: (s) => `  ↳ ${s}`,
};

export const LiveMessage = createLiveMessage({ transport, style, CHUNK, splitContent, postWithImages, footerLine });
