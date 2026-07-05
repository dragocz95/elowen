'use client';
/** Tiny cross-component channel to open the advisor dock on a specific brain conversation from anywhere
 *  (e.g. the Sessions page). Two consumers must cooperate across a mount gap: the Shell opens the dock
 *  (which mounts BrainChat), and BrainChat then loads the requested conversation. A module-level
 *  `pending` bridges that gap — BrainChat consumes it on mount AND handles the live event when the dock
 *  is already open. `continuable` = the session can be resumed and continued (own web/CLI conversation);
 *  otherwise it opens read-only (a shared Discord channel or a task-worker session). */
export const BRAIN_OPEN_EVENT = 'orca:open-brain-session';

export interface BrainOpenRequest { sessionId: string; continuable: boolean }

let pending: BrainOpenRequest | null = null;

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
