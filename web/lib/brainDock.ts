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

export interface BrainOpenRequest { sessionId: string; continuable: boolean }

let pending: BrainOpenRequest | null = null;
let pendingComposer: string | null = null;

/** Preserve both drafts when a dashboard/launcher compose request reaches an already-edited chat. */
export function mergeBrainComposerText(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current || current === incoming) return incoming;
  return `${current}\n\n${incoming}`;
}

/** Request the advisor dock to open the given stored session — continue it, or view it read-only. */
export function openBrainSession(sessionId: string, continuable: boolean): void {
  pending = { sessionId, continuable };
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
