import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { BrainStore } from '../store/brainStore.js';

/** Append the user's prompt. Called by BrainService before session.prompt(), because the terminal
 *  agent_end event carries only the assistant/tool messages produced during the turn. */
export function projectUserTurn(store: BrainStore, sessionId: string, text: string): void {
  store.appendMessage({ id: randomUUID(), sessionId, parentId: null, role: 'user', content: { role: 'user', content: text } });
  store.touchSession(sessionId);
}

/** Mirror a finished turn into SQLite (the sole store). Only agent_end carries the settled messages. */
export function projectEvent(store: BrainStore, sessionId: string, event: AgentSessionEvent): void {
  if (event.type !== 'agent_end') return;
  for (const m of event.messages) {
    const role = (m as { role?: string }).role ?? 'assistant';
    if (role === 'user') continue; // the user turn is already persisted by projectUserTurn — avoid a dup
    store.appendMessage({ id: randomUUID(), sessionId, parentId: null, role, content: m });
  }
  store.touchSession(sessionId);
}

/** Rebuild an in-memory PI session manager pre-seeded with the stored history (D1). Spike-proven:
 *  messages appended before createAgentSession appear as session.messages. */
export function rehydrate(store: BrainStore, sessionId: string, cwd: string): SessionManager {
  const sm = SessionManager.inMemory(cwd);
  for (const row of store.getMessages(sessionId)) {
    const msg = JSON.parse(row.content) as { role: string; content: unknown };
    sm.appendMessage(msg as never);
  }
  return sm;
}
