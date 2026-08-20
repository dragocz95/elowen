// Teams-flavoured formatting: shared splitting/reply-context helpers sized for Teams message limits.
import { splitContent as splitAtChunk, parseModelExec, runtimeFooter } from 'elowen-plugin-shared/format';

export { parseModelExec };

/** Teams caps a message payload around 28KB; markdown text well under that keeps every client happy. */
export const CHUNK = 20000;

/** Split a Teams reply into ≤CHUNK pieces without breaking a fenced code block (shared core + our size). */
export const splitContent = (text) => splitAtChunk(text, CHUNK);

/** The markup Teams' runtime footer is wrapped in. Bot messages there have no small-text style at all —
 *  Teams documents only bold, italic, strikethrough, monospace, blockquote and links for text-only
 *  messages, so nothing can actually shrink the type the way Discord's `-#` subtext does. What is left is
 *  weight: a blockquote draws a full-width bordered strip that dwarfs a one-line footer, so the footer is
 *  an em-dash lead-in in italic instead — the same shape the Telegram adapter uses, with no box around it.
 *  The dash follows the opening `*` with no space so Teams cannot read the line as a bullet item.
 *
 *  The leading non-breaking space is what sets the footer a line below the answer. The engine already
 *  joins body and footer with a blank line, but Teams renders that break tight, and markdown drops an
 *  EMPTY paragraph — so the gap has to be a paragraph holding something, and U+00A0 is that something
 *  while still looking blank.
 *  Named and passed like every other surface's fence so the footer itself stays one shared shape. */
const FOOTER_FENCE = { open: '\u00a0\n\n*— ', close: '*' };

/** The runtime footer under a final reply: `model · context %` from the idle event, or ''. */
export const footerLine = (idle) => runtimeFooter(idle, FOOTER_FENCE);
