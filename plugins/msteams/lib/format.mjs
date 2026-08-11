// Teams-flavoured formatting: shared splitting/reply-context helpers sized for Teams message limits.
import { splitContent as splitAtChunk, parseModelExec, runtimeFooter } from '../../_shared/format.mjs';

export { parseModelExec };

/** Teams caps a message payload around 28KB; markdown text well under that keeps every client happy. */
export const CHUNK = 20000;

/** Split a Teams reply into ≤CHUNK pieces without breaking a fenced code block (shared core + our size). */
export const splitContent = (text) => splitAtChunk(text, CHUNK);

/** The markup Teams' runtime footer is wrapped in. Bot messages have no small-text style there, and a
 *  plain trailing line reads as one more sentence of the answer — Teams renders the paragraph break
 *  before it far tighter than Discord does. A blockquote is the one muted BLOCK that Teams documents as
 *  supported on desktop, iOS and Android alike (headers and horizontal rules are not), so the footer
 *  gets its own quoted strip the way Discord subtext does, italic inside for the same hierarchy.
 *  Named and passed like every other surface's fence so the footer itself stays one shared shape. */
const FOOTER_FENCE = { open: '> *', close: '*' };

/** The runtime footer under a final reply: `model · context %` from the idle event, or ''. */
export const footerLine = (idle) => runtimeFooter(idle, FOOTER_FENCE);
