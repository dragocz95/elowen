/** Durable owner-facing activity state for one conversation.
 *
 * This module owns transition policy. BrainStore owns the atomic compare-and-set writes; callers can use the
 * decision result to keep transient/live state and the durable projection on the same vocabulary. */

export const CONVERSATION_ACTIVITY_STATES = ['idle', 'working', 'done', 'failed'] as const;
export type ConversationActivityState = typeof CONVERSATION_ACTIVITY_STATES[number];
export type ConversationActivitySurface = 'web' | 'cli';
export type ConversationActivityChanged = (sessionId: string) => void;

/** Keep owner surface validation at the activity boundary so callers do not grow surface branches. */
export function conversationActivitySurface(value: string | undefined, fallback: ConversationActivitySurface): ConversationActivitySurface {
  return value === 'web' || value === 'cli' ? value : fallback;
}

/** Public detail is deliberately short: this is a status hint, never a transcript or prompt channel. */
export const CONVERSATION_ACTIVITY_DETAIL_MAX = 240;
export function boundedConversationActivityDetail(value: string | undefined | null): string {
  if (!value) return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CONVERSATION_ACTIVITY_DETAIL_MAX);
}

export interface ConversationActivitySnapshot {
  state: ConversationActivityState;
  seq: number;
  readSeq: number;
  turnId: string | null;
  bootId: string | null;
  detail: string;
  at: string | null;
  webParticipatedAt: string | null;
}

export interface ConversationActivityStore {
  getSessionActivity(sessionId: string): ConversationActivitySnapshot | undefined;
  beginSessionActivity(sessionId: string, turnId: string, surface: ConversationActivitySurface, detail?: string): boolean;
  settleSessionActivity(sessionId: string, turnId: string, surface: ConversationActivitySurface, state: 'done' | 'failed', detail?: string): boolean;
  resetSessionActivity(sessionId: string, turnId?: string): boolean;
  ackSessionActivity(sessionId: string, readSeq?: number, surface?: ConversationActivitySurface): boolean;
}

/** Reset is neutral, not a new unread event. Keep an established web baseline current while leaving
 * CLI-only sessions unlinked from web participation. */
export function resetConversationActivity(
  store: ConversationActivityStore,
  sessionId: string,
  turnId?: string,
  onChanged?: (sessionId: string) => void,
): void {
  const before = store.getSessionActivity(sessionId);
  const changed = store.resetSessionActivity(sessionId, turnId ?? before?.turnId ?? undefined);
  if (before?.webParticipatedAt != null) store.ackSessionActivity(sessionId, undefined, 'web');
  if (changed) onChanged?.(sessionId);
}

export function conversationActivityUnread(activity: ConversationActivitySnapshot): boolean {
  return activity.webParticipatedAt !== null && activity.readSeq < activity.seq;
}
