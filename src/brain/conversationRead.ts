import type { BrainStore } from '../store/brainStore.js';
import { extractText } from './messageView.js';

/** The plugin-facing answer to "what did the agent last say here" (see PluginHostStores.conversationsRead).
 *  Ownership is decided HERE against the session row, so a plugin holding a session id never learns
 *  anything about a conversation that is not the caller's. A turn persists several assistant rows — the
 *  tool-call steps carry no text — so the newest few are scanned for the first one with display text. */
export function lastAssistantText(store: BrainStore, sessionId: string, userId: number): { text: string; at: string } | null {
  const session = store.getSession(sessionId);
  if (!session || session.user_id !== userId) return null;
  for (const row of store.recentAssistantMessages(sessionId, 8)) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.content); } catch { continue; }
    const text = extractText(parsed).trim();
    if (text) return { text, at: row.created_at };
  }
  return null;
}
