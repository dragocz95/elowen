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
 *  (see turnRunner/channels). So the kept tail is `keptRoles.length` store-backed messages, and both
 *  sequences are chronological suffixes of the same conversation (handles split-turn cuts too — a partial
 *  turn just contributes fewer kept messages).
 *
 *  Trailing-row alignment: a positional "last N store rows" is WRONG when PI compacts BEFORE it has
 *  ingested the current turn's user message. Auto-compaction runs inside PI's `_checkCompaction` at the
 *  very start of `prompt()` — BEFORE the new user message is pushed to `session.messages` — yet
 *  `projectUserTurn` already wrote that user row to the store BEFORE calling `prompt()` (see
 *  turnRunner/channels). So at compaction time the store has one (or more) trailing user row(s) the kept
 *  tail does NOT contain; blindly keeping the last N rows would retain those unprocessed rows and DROP the
 *  oldest genuinely-kept message. We instead align the kept tail's role sequence against the store rows
 *  from the tail, allowing the newest store rows that PI hasn't ingested yet to sit AFTER the kept tail:
 *  the divider lands before the kept tail, and the in-flight user row stays as the newest row. When the
 *  sequences are already aligned (manual `/compact`, which runs OUTSIDE prompt(); overflow recovery) the
 *  match is at skip 0 and this is identical to the old count-only behaviour. */
export function persistCompaction(store: BrainStore, session: AgentSession, sessionId: string): void {
  const messages = session.messages as { role?: string }[];
  const summary = messages.find((m) => m.role === 'compactionSummary');
  if (!summary) return; // no compaction actually present in the live context — nothing to mirror (defensive)
  const keptRoles: string[] = [];
  for (const m of messages) {
    if (m.role === 'compactionSummary') continue; // → our inserted divider, not a tail row
    if (m.role === 'user' && extractText(m).trim() === NO_REPLY_NUDGE) continue; // nudge has no store row
    keptRoles.push(m.role ?? 'assistant');
  }
  const keepCount = alignedKeepCount(store.getMessages(sessionId).map((r) => r.role), keptRoles);
  store.compactSessionMessages(sessionId, { id: randomUUID(), role: 'compaction', content: summary }, keepCount);
}

/** How many trailing store rows to keep so the compaction divider lands directly before PI's kept tail.
 *  `keptRoles` is the ordered role sequence of PI's kept, store-backed messages. We find the SMALLEST
 *  number of newest store rows to skip (rows PI hasn't ingested yet — the in-flight user turn) such that
 *  the `keptRoles`-length window ending just before them matches by role, then keep that window PLUS the
 *  skipped rows (so the in-flight user turn survives as the newest row). Skip 0 = already aligned (manual
 *  `/compact`, overflow recovery) → identical to keeping the last `keptRoles.length` rows. Falls back to
 *  `keptRoles.length` when no alignment exists (e.g. the kept tail is longer than the whole store — the
 *  documented `keepLastN >= total` case that keeps the entire log). */
function alignedKeepCount(storeRoles: string[], keptRoles: string[]): number {
  const n = storeRoles.length;
  const k = keptRoles.length;
  for (let skip = 0; skip <= n - k; skip++) {
    const start = n - skip - k;
    let matches = true;
    for (let i = 0; i < k; i++) {
      if (storeRoles[start + i] !== keptRoles[i]) { matches = false; break; }
    }
    if (matches) return k + skip;
  }
  return k;
}

/** The stored rows of a session, JSON-parsed defensively: a single corrupt `content` blob skips just
 *  that row instead of aborting the whole rehydration (which would make the conversation un-spawnable
 *  and un-exportable). Carries each row's original `created_at` for callers that need real timestamps. */
function* parsedRows(store: BrainStore, sessionId: string): Generator<{ msg: { role: string; content: unknown }; createdAt: string }> {
  for (const row of store.getMessages(sessionId)) {
    let msg: { role: string; content: unknown };
    try { msg = JSON.parse(row.content) as { role: string; content: unknown }; }
    catch { continue; } // corrupt row — skip it, keep the rest of the history intact
    yield { msg, createdAt: row.created_at };
  }
}

/** Rebuild an in-memory PI session manager pre-seeded with the stored history (D1). Spike-proven:
 *  messages appended before createAgentSession appear as session.messages. */
export function rehydrate(store: BrainStore, sessionId: string, cwd: string): SessionManager {
  const sm = SessionManager.inMemory(cwd);
  for (const { msg } of parsedRows(store, sessionId)) sm.appendMessage(msg as never);
  return sm;
}

/** Like `rehydrate`, but also returns each appended message's original store timestamp (ISO 8601). The
 *  export path needs it because PI's `appendMessage` stamps `Date.now()`, which would otherwise make an
 *  exported transcript show the export time on every message instead of when it was actually said. */
export function rehydrateWithTimestamps(store: BrainStore, sessionId: string, cwd: string): { sm: SessionManager; timestamps: string[] } {
  const sm = SessionManager.inMemory(cwd);
  const timestamps: string[] = [];
  for (const { msg, createdAt } of parsedRows(store, sessionId)) {
    sm.appendMessage(msg as never);
    // SQLite stores UTC `YYYY-MM-DD HH:MM:SS`; normalize to ISO 8601 so PI's exporter renders it.
    timestamps.push(new Date(`${createdAt.replace(' ', 'T')}Z`).toISOString());
  }
  return { sm, timestamps };
}
