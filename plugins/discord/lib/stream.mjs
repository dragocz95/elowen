// Discord binding for the shared live-message engine (../../_shared/liveMessage.mjs): the Discord REST
// transport, the markdown render style, and the final-answer image strategy. The throttled editable
// message, the streaming answer and the brain-event reducer all live in the shared engine — only the
// pieces that genuinely differ from Telegram/other surfaces stay here.
import { CHUNK, extractImageRefs, splitContent, footerLine } from './format.mjs';
import { createLiveMessage } from '../../_shared/liveMessage.mjs';

/** Post a final text to a channel. Generated-image links become real Discord file uploads (their
 *  relative daemon URLs are dead text on Discord): the links are stripped and the files ride the
 *  FIRST chunk of the (possibly split) message. Text without image links — or an adapter without
 *  image dirs (tests use bare fakes) — keeps the plain JSON path. */
export async function postWithImages(adapter, channelId, text, replyToId) {
  const { cleaned, files } = extractImageRefs(text);
  const data = typeof adapter.resolveImageFiles === 'function' ? adapter.resolveImageFiles(files) : [];
  const out = data.length ? (cleaned.trim() || '🎨') : text; // nothing loadable → keep the original text
  const pieces = splitContent(out);
  // The first piece is a real Discord reply to the triggering message (fail_if_not_exists:false —
  // a deleted trigger degrades to a plain message instead of a 400).
  const ref = replyToId ? { message_reference: { message_id: replyToId, fail_if_not_exists: false } } : {};
  for (let i = 0; i < pieces.length; i++) {
    if (i === 0 && data.length) await adapter.uploadImages(channelId, pieces[i], data, 0, i === 0 ? ref : {});
    else await adapter.rest('POST', `/channels/${channelId}/messages`, { content: pieces[i], ...(i === 0 ? ref : {}) });
  }
}

// The Discord REST transport for one editable message. Each closure receives the adapter so it calls the
// same `adapter.rest` the plugin tests mock. Create returns the new message id (null on failure), edit
// returns whether the PATCH landed, remove is best-effort DELETE.
const transport = {
  create: (a, channelId, content, extra) =>
    a.rest('POST', `/channels/${channelId}/messages`, { content, ...extra }).then((msg) => msg?.id ?? null, () => null),
  edit: (a, channelId, messageId, content) =>
    a.rest('PATCH', `/channels/${channelId}/messages/${messageId}`, { content }).then(() => true, () => false),
  remove: (a, channelId, messageId) =>
    a.rest('DELETE', `/channels/${channelId}/messages/${messageId}`).catch(() => {}),
  replyRef: (replyToId) => ({ message_reference: { message_id: replyToId, fail_if_not_exists: false } }),
  hasImages: (a) => typeof a.resolveImageFiles === 'function' && typeof a.uploadImages === 'function',
  postImages: (a, channelId, data) => a.uploadImages(channelId, '', data, 0, {}),
};

// Discord renders markdown, so the style escapes @everyone/<@ ping injection, neutralizes ``` fences, and
// uses **bold**/~~strike~~, a `-#` subtext line and `_italic_`; the fold rule, output summaries and diff
// summary come straight from the shared core (../../_shared/liveTrace.mjs).
const style = {
  mentionSafe: (s) => s.replace(/@(?=everyone|here)/gi, '@​').replace(/<@(?=[!&]?\d)/g, '<@​'),
  fenceSafe: (s) => s.replace(/```/g, "'''"),
  bold: (s) => `**${s}**`,
  strike: (s) => `~~${s}~~`,
  italic: (s) => `_${s}_`,
  subtext: (s) => `-# ${s}`,
  summaryLine: (s) => `-# ↳ ${s}`,
};

export const LiveMessage = createLiveMessage({ transport, style, CHUNK, splitContent, postWithImages, footerLine });
