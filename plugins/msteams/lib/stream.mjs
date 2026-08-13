// Teams binding for the shared live-message engine (../../_shared/liveMessage.mjs): the Bot Connector
// transport (adapter.tmSend / tmEdit / tmDelete), a markdown render style, and the final-answer image
// strategy (attachments ahead of the text). The throttled editable message, the streaming answer and the
// brain-event reducer all live in the shared engine — only the genuinely Teams-specific pieces are here.
import { CHUNK, splitContent, footerLine } from './format.mjs';
import { extractImageRefs } from '../../_shared/format.mjs';
import { createLiveMessage } from '../../_shared/liveMessage.mjs';

/** Post a final text to a conversation. Generated-image links become real Teams image attachments (their
 *  relative daemon URLs are dead text here): the links are stripped and the images ride ahead of the
 *  (possibly split) text. Text without image links keeps the plain send path. */
export async function postWithImages(adapter, conversationId, text, replyToId) {
  const { cleaned, files } = extractImageRefs(text);
  const data = typeof adapter.resolveImageFiles === 'function' ? adapter.resolveImageFiles(files) : [];
  if (data.length && typeof adapter.sendImages === 'function') await adapter.sendImages(conversationId, data);
  const body = data.length ? cleaned.trim() : text;
  if (!body) return; // image-only reply — the attachments already stand alone
  const pieces = splitContent(body);
  for (let i = 0; i < pieces.length; i++) {
    // Thread the first text piece under the trigger only when no image preceded it (else the image carried it).
    await adapter.tmSend(conversationId, pieces[i], i === 0 && !data.length && replyToId ? { replyToId } : {});
  }
}

// The connector transport for one editable message. Each closure receives the adapter so it calls the
// same tm* helpers the plugin tests mock. Create returns the new activity id (null on failure), edit
// returns whether the edit landed, remove is best-effort delete.
const transport = {
  create: (a, conversationId, content, extra) => a.tmSend(conversationId, content, extra),
  edit: (a, conversationId, activityId, content) => a.tmEdit(conversationId, activityId, content),
  remove: (a, conversationId, activityId) => a.tmDelete(conversationId, activityId),
  replyRef: (replyToId) => ({ replyToId }),
  hasImages: (a) => typeof a.resolveImageFiles === 'function' && typeof a.sendImages === 'function',
  postImages: (a, conversationId, data, _replyToId, caption) => a.sendImages(conversationId, data, caption),
};

// Teams renders a markdown subset, so the style leans on it: bold tool names, struck-through failures,
// subtext stays plain (Teams has no spoiler/small text in bot messages). A literal `<at>` in model
// output would read as a mention attempt — neutralize it; fences are markdown-native and stay.
const style = {
  mentionSafe: (s) => String(s).replace(/<at>/gi, '‹at›').replace(/<\/at>/gi, '‹/at›'),
  fenceSafe: (s) => s,
  bold: (s) => `**${s}**`,
  strike: (s) => `~~${s}~~`,
  italic: (s) => `_${s}_`,
  subtext: (s) => s,
  summaryLine: (s) => `  ↳ ${s}`,
  // Teams renders a bot's message as markdown, where a single newline is a SOFT wrap: the tool trace
  // came out as one run-on paragraph ("Skill … ToolSearch … CronAdd …" on one line). A blank line is
  // the only separator the documented Teams subset gives a bot, so trace rows are joined by one.
  lineBreak: '\n\n',
};

export const LiveMessage = createLiveMessage({ transport, style, CHUNK, splitContent, postWithImages, footerLine });
