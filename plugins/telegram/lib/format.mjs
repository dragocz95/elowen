// Telegram text/format helpers. The transport-neutral pieces (stripForSpeech, extractImageRefs,
// stripThinking, parseModelExec, the fenced-split core) live in elowen-plugin-shared/format; only Telegram's
// own chunk size, reply-quote and footer stay here.
// Telegram messages are sent as PLAIN TEXT (no parse_mode), so no markup ever needs escaping and a stray
// `<`, `&` or unbalanced `*` in a model answer can never crash a send — the safe, consistent choice for
// arbitrary agent output (see the plugin README/notes on the HTML-vs-plaintext trade-off).
import { splitContent as splitAtChunk, extractImageRefs, stripThinking, parseModelExec, stripForSpeech, runtimeFooter, stripRuntimeFooter } from 'elowen-plugin-shared/format';
export { extractImageRefs, stripThinking, parseModelExec, stripForSpeech };

export const CHUNK = 4000; // Telegram caps a text message at 4096 chars — stay comfortably under it
const REPLY_EXCERPT = 300; // quoted-reply excerpt length

/** Split a Telegram reply into ≤CHUNK pieces without breaking a fenced code block (shared core + our size). */
export const splitContent = (text) => splitAtChunk(text, CHUNK);

/** Quote context for a reply: who is being answered + a capped excerpt of what they said. Built from a
 *  Telegram `reply_to_message` (its sender name + text/caption); empty when the message is not a reply. */
export function buildReplyContext(name, body) {
  const content = String(body ?? '').trim();
  if (!content) return '';
  const excerpt = content.length > REPLY_EXCERPT ? `${content.slice(0, REPLY_EXCERPT)}…` : content;
  return `[Replying to ${name || 'someone'}: "${excerpt}"]`;
}

/** The markup Telegram's runtime footer is wrapped in — shared by the writer (`footerLine`) and the
 *  reader (`withoutFooter`), so the two can never drift into recognising different shapes. */
const FOOTER_FENCE = { open: '— ', close: '' };

/** Runtime footer: `model · 42 %` as a dim line under the final answer. Empty when the idle event
 *  carried no usable data (defensive: never render a `?%` footer). */
export const footerLine = (idle) => runtimeFooter(idle, FOOTER_FENCE);

/** Drop our own trailing footer from a message before it is fed back as prompt context. */
export const withoutFooter = (text) => stripRuntimeFooter(text, FOOTER_FENCE);

