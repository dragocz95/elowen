'use client';
/** Tiny cross-component channel to open the advisor dock on a specific brain conversation from anywhere
 *  (e.g. the Sessions page). Two consumers must cooperate across a mount gap: the Shell opens the dock
 *  (which mounts BrainChat), and BrainChat then loads the requested conversation. A module-level
 *  `pending` bridges that gap — BrainChat consumes it on mount AND handles the live event when the dock
 *  is already open. `continuable` = the session can be resumed and continued (own web/CLI conversation);
 *  otherwise it opens read-only (a shared Discord channel or a task-worker session). */
export const BRAIN_OPEN_EVENT = 'elowen:open-brain-session';
/** Opens the normal live conversation and optionally seeds its composer. Dashboard + the persistent
 *  Elowen launcher use this instead of implementing a second send path. */
export const BRAIN_COMPOSE_EVENT = 'elowen:open-brain-composer';

export interface BrainOpenRequest { sessionId: string; continuable: boolean; /** The request names a DELEGATED sub-agent transcript: when continuable it opens as a FOCUSED CHILD — the composer stays and its sends ride the subagent send seam — never bound as the account's active conversation. */ delegated?: boolean }

let pending: BrainOpenRequest | null = null;
let pendingComposer: string | null = null;

/** Preserve both drafts when a dashboard/launcher compose request reaches an already-edited chat. */
export function mergeBrainComposerText(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current || current === incoming) return incoming;
  return `${current}\n\n${incoming}`;
}

/** Request the advisor dock to open the given stored session — continue it, focus it as a delegated
 *  child (writable through the subagent send seam), or view it read-only. `delegated` is carried only
 *  when true, so every non-delegated request keeps its historical two-field shape. */
export function openBrainSession(sessionId: string, continuable: boolean, delegated = false): void {
  pending = { sessionId, continuable, ...(delegated ? { delegated: true } : {}) };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(BRAIN_OPEN_EVENT, { detail: pending }));
  }
}

/** Read and clear the pending request (BrainChat calls this once on mount / when handling the event). */
export function consumePendingBrainSession(): BrainOpenRequest | null {
  const req = pending;
  pending = null;
  return req;
}

/** Open the live advisor conversation with `text` ready to edit/send. An empty string simply focuses
 *  the composer. The module-level bridge survives the dock's mount gap, like session requests above. */
export function openBrainComposer(text = ''): void {
  pendingComposer = mergeBrainComposerText(pendingComposer ?? '', text);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(BRAIN_COMPOSE_EVENT, { detail: { text } }));
  }
}

/** BrainChat consumes the pending composer value on mount or when it handles a live compose event. */
export function consumePendingBrainComposer(): string | null {
  const text = pendingComposer;
  pendingComposer = null;
  return text;
}

/** Where a request to open the advisor should land.
 *
 *  A phone gets the full /chat page rather than the dock: the dock is a side panel sized in PIXELS and
 *  anchored to a window edge, with a drag handle and a resizable split, so on a phone it arrived as a
 *  cramped overlay with the conversation squeezed into whatever width was left over.
 *
 *  `mobile` is `undefined` until the viewport has actually been measured, and that case deliberately
 *  resolves to the dock: the measurement lands on mount, long before anyone can tap, and guessing
 *  "mobile" would send a desktop user to a different page for one frame. */
export function advisorOpenTarget(opts: { onChat: boolean; mobile: boolean | undefined }): 'none' | 'chat-page' | 'dock' {
  if (opts.onChat) return 'none'; // that page is already the chat host; popping the dock would duplicate it
  return opts.mobile === true ? 'chat-page' : 'dock';
}
