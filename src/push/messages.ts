/** Web-push payloads built daemon-side and rendered verbatim by the service worker. User-facing text
 *  is Czech (formal) — the SW does no i18n. `actions` map to inline notification buttons; an empty
 *  `actions` array means tap-to-open only (the SW opens `url`).
 *
 *  Only the owner-chat turn notification is built here. The mission builders (review/needs_input/
 *  stalled/blocked/done) live in the agents plugin (plugins/agents/src/push/messages.ts); PushPayload
 *  keeps the full kind union because plugin-built payloads flow through the host push seam. */

type PushKind = 'review' | 'needs_input' | 'stalled' | 'blocked' | 'done' | 'turn_done';

interface PushAction { action: string; title: string }

export interface PushPayload {
  kind: PushKind;
  title: string;
  body: string;
  /** `m-<epicId>` — present for every kind; the SW uses it as the notification `tag` so repeated
   *  notifications about the same mission collapse on the device. */
  missionId?: string;
  /** The phase/task the action targets (review approve/rerun). */
  taskId?: string;
  /** The agent tmux session (`elowen-<agent>`) a needs_input answer is sent to. */
  session?: string;
  /** Opened PR url, when a finished mission has one. */
  prUrl?: string;
  actions: PushAction[];
  /** App path the SW opens on a plain tap / the `open` action. */
  url: string;
}

/** Cut by CODE POINT, not by UTF-16 unit: slicing mid-surrogate ends the text in half an emoji, which a
 *  phone renders as the replacement glyph. Czech diacritics are BMP and were never at risk. */
const trim = (s: string, n = 140): string => {
  const points = Array.from(s);
  return points.length > n ? `${points.slice(0, n - 1).join('')}…` : s;
};

/** How much of an answer is examined. The preview shown is two orders of magnitude shorter, so this only
 *  has to be long enough that an answer opening with a code block still has prose left after flattening.
 *  It also bounds the work: this runs synchronously on the daemon's event loop for every notified turn,
 *  over text the model may have quoted from anywhere, and a scanner is not something to leave open-ended. */
const PREVIEW_SCAN_LIMIT = 4_000;

/** Flatten one answer into a single line a notification can show. A phone renders no markdown, so its
 *  syntax would arrive as literal punctuation; code blocks are dropped outright because a fenced diff or
 *  command says nothing useful in two lines and would crowd out the sentence that does. */
export function notificationPreview(text: string): string {
  return text
    .slice(0, PREVIEW_SCAN_LIMIT)
    .replace(/```[\s\S]*?```/g, ' ')
    // An answer cut off mid-block (or one still streaming) leaves a fence with no partner. Everything from
    // it on is code, so drop the remainder rather than let backticks and diff markers through as prose.
    .replace(/```[\s\S]*$/, ' ')
    .replace(/`([^`]+)`/g, '$1')
    // The URL is bounded rather than "anything up to a bracket": an unclosed `](` would otherwise make the
    // engine rescan the rest of the text at every occurrence, which is quadratic on repeated ones.
    .replace(/!?\[([^\]]*)\]\([^)\s]{0,500}\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '• ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An owner-chat turn the user started finished while their device was off screen — a plain FYI, with the
 *  opening of the answer so it can be read without unlocking. The conversation name is the title: it says
 *  WHICH chat replied, which a fixed banner never did. No action; a tap opens the conversation. */
export function buildTurnDone(input: { title: string; preview?: string; productName?: string }): PushPayload {
  const preview = notificationPreview(input.preview ?? '');
  return {
    kind: 'turn_done',
    title: input.title ? trim(input.title, 60) : `${input.productName ?? 'Elowen'} dokončil práci`,
    body: preview ? trim(preview, 180) : 'Vaše konverzace je hotová.',
    actions: [],
    url: '/chat',
  };
}
