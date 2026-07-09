import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { BrainStore } from '../store/brainStore.js';
import { extractText, NO_REPLY_NUDGE } from './messageView.js';
import { currentMeter } from './openrouterMeter.js';

/** Append the user's prompt. Called by BrainService before session.prompt(), because the terminal
 *  agent_end event carries only the assistant/tool messages produced during the turn. */
export function projectUserTurn(store: BrainStore, sessionId: string, text: string): void {
  store.appendMessage({ id: randomUUID(), sessionId, parentId: null, role: 'user', content: { role: 'user', content: text } });
  store.touchSession(sessionId);
}

/** Mirror a finished turn into SQLite (the sole store). Only agent_end carries the settled messages.
 *  Stamps the turn's real provider cost (OpenRouter / an OpenRouter-backed proxy) onto its last assistant
 *  row: pi-ai drops `usage.cost` for models it has no price sheet for (e.g. `sarah-mimo-v2.5`), so without
 *  this their chat/channel spend persists as $0 and never reaches usageByModel/usageByDay. Only stamps
 *  when a meter is ambient (the turn ran under runWithMeter) AND it saw a provider-reported cost; stamps
 *  the per-`agent_end` DELTA so a thinking-only nudge (a second agent_end under one meter) can't double it. */
export function projectEvent(store: BrainStore, sessionId: string, event: AgentSessionEvent): void {
  if (event.type !== 'agent_end') return;
  const meter = currentMeter();
  const costDelta = meter?.reported ? meter.costUsd - meter.stampedUsd : 0;
  if (meter && costDelta > 0) meter.stampedUsd = meter.costUsd;
  // The last assistant message of the turn carries the stamp; the model is uniform across the turn, so
  // lumping the turn's cost on one row is exact for the per-model aggregates that read it.
  let lastAssistant = -1;
  event.messages.forEach((m, i) => { if (((m as { role?: string }).role ?? 'assistant') === 'assistant') lastAssistant = i; });
  event.messages.forEach((m, i) => {
    const role = (m as { role?: string }).role ?? 'assistant';
    if (role === 'user') return; // the user turn is already persisted by projectUserTurn — avoid a dup
    if (i === lastAssistant && costDelta > 0) stampCost(m, costDelta);
    store.appendMessage({ id: randomUUID(), sessionId, parentId: null, role, content: m });
  });
  store.touchSession(sessionId);
}

/** Set `usage.cost.total` on a message to the provider-reported cost pi-ai dropped. Overrides pi-ai's
 *  estimate (0 for a model it can't price) while preserving the token fields under `usage`. */
function stampCost(m: unknown, cost: number): void {
  const msg = m as { usage?: { cost?: { total?: number } } };
  msg.usage = { ...(msg.usage ?? {}) };
  msg.usage.cost = { ...(msg.usage.cost ?? {}), total: cost };
}

/** Mirror a just-finished in-context compaction into the store. Called from the factory's session
 *  subscription on every PI `compaction_end` (auto at the threshold, manual `/compact`, overflow
 *  recovery), so every compaction behaves identically. PI's compaction is an in-memory-context operation
 *  that writes NOTHING to the store on its own, so without this the full pre-compaction log stays in
 *  SQLite: the transcript reads stale AND the token savings evaporate on the next rehydrate
 *  (respawn/restart/eviction). Client notification (`compacted`) is a separate concern the chat-brain
 *  spawner fans out from the same event, AFTER this store mutation, so a refetch sees the shrunk log.
 *
 *  CRUCIAL: we do NOT serialize `session.messages` — those live entries carry the ephemeral live-prompt
 *  framing (memory/permissions/turn-context blocks, mode instructions, NO_REPLY_NUDGE) and raw image
 *  bytes, none of which may ever land in brain_messages. The STORE's own rows are the single clean source
 *  of history. After compaction `session.messages` is `[compactionSummary, ...keptTail]`; we keep exactly
 *  the matching trailing STORE rows (original clean text + original timestamps) and drop the older ones,
 *  inserting a `compaction` divider (carrying PI's summary for rehydrate) at the cut point.
 *
 *  Mapping PI's kept tail → store rows: every kept PI message has a 1:1 clean store row EXCEPT (a) the
 *  leading compactionSummary (we insert our own divider instead) and (b) any NO_REPLY_NUDGE user message
 *  — prompted straight to PI on a thinking-only turn, never `projectUserTurn`'d, so it has NO store row
 *  (see turnRunner/channels). So `keepLastN` = count of kept messages that are neither. Both sequences
 *  are chronological suffixes of the same conversation, so the last `keepLastN` store rows ARE the clean
 *  tail (handles split-turn cuts too — a partial turn just contributes fewer kept messages). */
export function persistCompaction(store: BrainStore, session: AgentSession, sessionId: string): void {
  const messages = session.messages as { role?: string }[];
  const summary = messages.find((m) => m.role === 'compactionSummary');
  if (!summary) return; // no compaction actually present in the live context — nothing to mirror (defensive)
  let keepLastN = 0;
  for (const m of messages) {
    if (m.role === 'compactionSummary') continue; // → our inserted divider, not a tail row
    if (m.role === 'user' && extractText(m).trim() === NO_REPLY_NUDGE) continue; // nudge has no store row
    keepLastN++;
  }
  store.compactSessionMessages(sessionId, { id: randomUUID(), role: 'compaction', content: summary }, keepLastN);
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
