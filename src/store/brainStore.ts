import { randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import type { Db } from './db.js';
import { extractText } from '../brain/messageView.js';
import { dbTsToIso } from '../shared/time.js';
import { toolResultSpillDir } from '../shared/paths.js';
import { logger } from '../shared/logger.js';
import { CHANNEL_PREFIX, TASK_PREFIX } from '../brain/sessionId.js';
import {
  normalizeDelegatedExecutionScope,
  sameDelegatedExecutionScope,
  type DelegatedExecutionScope,
} from '../brain/delegatedScope.js';
import { BrainUsageStore, rollupDroppedUsage } from './brainUsageStore.js';
import { BrainDelegationStore } from './brainDelegationStore.js';
import type { BrainCard, BrainGoalState } from '../brain/events.js';

// The delegated-execution slice (sub-agent runs/results + workflow-run DAGs) lives in its own store;
// BrainStore is the facade that delegates to it. Re-export the parts of its surface external callers
// still import FROM here so those importers stay unchanged (statusService: BrainWorkflowRun;
// brainService + tests: syntheticRestartResultId). BrainSubagentRun/BrainSubagentResult have no external
// importer (consumed structurally), so they are not re-exported.
export { syntheticRestartResultId } from './brainDelegationStore.js';
export type { BrainWorkflowRun } from './brainDelegationStore.js';

export interface BrainSessionRow {
  id: string; user_id: number; title: string; model: string; work_dir: string; parent_session_id: string | null;
  delegated_access: string | null;
  created_at: string; updated_at: string;
}
export interface BrainMessageRow {
  id: string; session_id: string; parent_id: string | null; role: string; content: string; created_at: string;
}
/** Durable binding for an admin's interactive `elowen chat` terminal (BrainTerminalService): the tmux
 *  session name → the brain conversation it resumes + the per-terminal auth token minted for it. */
export interface BrainTerminalRow {
  terminal_name: string; user_id: number; brain_session_id: string; token: string; created_at: string;
}

/** One settled PI run, expressed without PI-specific types so the persistence layer remains the
 * only caller that translates agent messages. A `reusePreprojectedUser` entry keeps the clean user
 * row which was written before prompt() (and may differ from PI's ephemeral prompt framing). */
export interface BrainRunMessage {
  id?: string;
  parentId?: string | null;
  role: string;
  content?: unknown;
  reusePreprojectedUser?: boolean;
}
export interface BrainSearchHit {
  sessionId: string; sessionTitle: string; role: string; snippet: string; ts: string;
}
export type BrainGoalRow = BrainGoalState;
/** A visible, display-only marker of an owner-driven session-state change (see brain_session_events).
 *
 *  The ONE list. It is also the read boundary's validator (getSessionEvents) and must stay in step with
 *  the table's CHECK constraint in schema.sql — a kind the type allows but the boundary rejects writes
 *  fine and then vanishes on the next reload, which no compiler catches: the boundary narrows a `string`
 *  from SQLite, so a stale check there stays perfectly well-typed. */
export const SESSION_EVENT_KINDS = ['model', 'mode', 'rename', 'reasoning', 'cwd'] as const;
export type SessionEventKind = typeof SESSION_EVENT_KINDS[number];
/** Narrow a kind read back from SQLite. The stored value is only ever `string` to the type system. */
const isSessionEventKind = (kind: string): kind is SessionEventKind =>
  (SESSION_EVENT_KINDS as readonly string[]).includes(kind);
export interface BrainSessionEvent {
  id: string;
  kind: SessionEventKind;
  detail: string;
  /** ISO 8601 (from the row's SQLite UTC created_at) — the transcript interleaves markers by this. */
  at: string;
}
/** Radius of context kept around a search match in its snippet. */
const SNIPPET_RADIUS = 60;

/** Persistence for the embedded brain's conversations — the SOLE authoritative store (design D1).
 *  The PI agent session runs in-memory; every settled turn is projected here, and history is
 *  rehydrated from here on start. Exactly one writer (BrainService), so no dual-write drift. */
export class BrainStore {
  /** Usage-accounting views (per-day/per-model spend, descendant-tree totals) live in their own store;
   *  BrainStore is the facade that delegates to it so callers are unchanged. Shares only the Db handle. */
  private readonly usage: BrainUsageStore;
  /** Delegated-execution views (sub-agent runs/results, workflow-run DAGs) live in their own store;
   *  BrainStore is the facade that delegates to it so callers are unchanged. Shares only the Db handle. */
  private readonly delegation: BrainDelegationStore;
  constructor(private db: Db) {
    this.usage = new BrainUsageStore(db);
    this.delegation = new BrainDelegationStore(db);
  }

  /** Create a top-level or delegated session. A supplied parent must already exist and belong to the
   *  same owner: the relation is later traversed for billing, so accepting a foreign/missing parent
   *  would either leak another user's spend or silently lose the child's. Nested parents are valid. */
  createSession(input: {
    id: string; userId: number; title?: string; model: string; parentSessionId?: string | null;
    /** Immutable execution boundary for a newly-created delegated child. */
    delegatedAccess?: DelegatedExecutionScope;
  }): BrainSessionRow {
    const parentSessionId = input.parentSessionId ?? null;
    const delegatedAccess = input.delegatedAccess === undefined
      ? undefined
      : normalizeDelegatedExecutionScope(input.delegatedAccess);
    if (input.delegatedAccess !== undefined && !delegatedAccess) throw new Error('invalid delegated access');
    if (delegatedAccess && parentSessionId === null) throw new Error('delegated access requires a parent session');
    this.db.transaction(() => {
      if (parentSessionId !== null) {
        const parent = this.db.prepare('SELECT user_id FROM brain_sessions WHERE id = ?').get(parentSessionId) as { user_id: number } | undefined;
        if (!parent) throw new Error(`parent brain session not found: ${parentSessionId}`);
        if (parent.user_id !== input.userId) throw new Error('parent brain session belongs to another user');
      }
      this.db.prepare(
        `INSERT INTO brain_sessions (id, user_id, title, model, parent_session_id, delegated_access)
         VALUES (@id, @user_id, @title, @model, @parent_session_id, @delegated_access)`
      ).run({
        id: input.id, user_id: input.userId, title: input.title ?? '', model: input.model,
        parent_session_id: parentSessionId,
        delegated_access: delegatedAccess ? JSON.stringify(delegatedAccess) : null,
      });
    })();
    return this.getSession(input.id)!;
  }

  getSession(id: string): BrainSessionRow | undefined {
    return this.db.prepare('SELECT * FROM brain_sessions WHERE id = ?').get(id) as BrainSessionRow | undefined;
  }

  /** Read a child's immutable delegation boundary. Both legacy NULL rows and malformed DB JSON are
   * deliberately returned as undefined so callers fail closed before executing a continuation. */
  delegatedAccessFor(sessionId: string): DelegatedExecutionScope | undefined {
    const row = this.getSession(sessionId);
    if (!row?.parent_session_id || !row.delegated_access) return undefined;
    try { return normalizeDelegatedExecutionScope(JSON.parse(row.delegated_access)); }
    catch { return undefined; }
  }

  /** A respawn may only use the exact boundary originally minted for this durable child. It never writes
   * a missing/changed value: legacy or corrupt rows stay unusable rather than being upgraded by request input. */
  hasDelegatedAccess(sessionId: string, supplied: DelegatedExecutionScope): boolean {
    const stored = this.delegatedAccessFor(sessionId);
    const normalized = normalizeDelegatedExecutionScope(supplied);
    return !!stored && !!normalized && sameDelegatedExecutionScope(stored, normalized);
  }

  listSessions(userId: number): BrainSessionRow[] {
    return this.db.prepare('SELECT * FROM brain_sessions WHERE user_id = ? ORDER BY updated_at DESC, rowid ASC')
      .all(userId) as BrainSessionRow[];
  }

  /** The user's sessions that hold no message at all. A live session owns its row from the moment it
   *  spawns — that is what the delegation parent check, the work-dir binding and every ownership check
   *  read — but a row nobody has spoken into is not yet a CONVERSATION: it is the empty shell the CLI
   *  leaves behind simply by launching. One query, so a listing can filter without an N+1. */
  unspokenSessionIds(userId: number): Set<string> {
    const rows = this.db.prepare(
      `SELECT s.id FROM brain_sessions s
       WHERE s.user_id = ? AND NOT EXISTS (SELECT 1 FROM brain_messages m WHERE m.session_id = s.id)`
    ).all(userId) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  /** Ids of a user's own top-level conversations whose last activity is older than `days` — the
   *  candidates for the retention janitor. The DB-derivable exclusions live HERE so they are applied
   *  atomically and can never drift from the delete: a non-user session (channel/task shell), a delegated
   *  child (`parent_session_id` set — deleting one out from under its parent tree is wrong), and an
   *  unspoken empty shell are all filtered out. The live-state exclusions (running, active, running
   *  children) cannot be seen from SQLite and are the caller's to apply before deleting. `days` is clamped
   *  to a positive integer — it is interpolated into a SQLite date modifier, so it must never be a string. */
  staleConversationIds(userId: number, days: number): string[] {
    const d = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 90;
    const rows = this.db.prepare(
      `SELECT s.id FROM brain_sessions s
       WHERE s.user_id = ?
         AND s.parent_session_id IS NULL
         AND s.id NOT LIKE '${CHANNEL_PREFIX}%'
         AND s.id NOT LIKE '${TASK_PREFIX}%'
         AND s.updated_at < datetime('now', '-${d} days')
         AND EXISTS (SELECT 1 FROM brain_messages m WHERE m.session_id = s.id)`
    ).all(userId) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** Per-user overview stats for the users admin panel: total session count and the model used in the
   *  most sessions over the whole history (indexed on user_id). One count + one grouped query, no N+1.
   *  `topModel` is null when the user has no sessions with a recorded model. */
  userStats(userId: number): { sessionCount: number; topModel: string | null } {
    const sessionCount = (this.db.prepare('SELECT COUNT(*) AS n FROM brain_sessions WHERE user_id = ?').get(userId) as { n: number }).n;
    const top = this.db.prepare(
      "SELECT model, COUNT(*) AS c FROM brain_sessions WHERE user_id = ? AND model != '' GROUP BY model ORDER BY c DESC, model ASC LIMIT 1"
    ).get(userId) as { model: string; c: number } | undefined;
    return { sessionCount, topModel: top?.model ?? null };
  }

  /** Daily token/cost spend of the user's own brain sessions for the dashboard tiles — see
   *  {@link BrainUsageStore.usageByDay}. */
  usageByDay(userId: number, days = 7): { day: string; tokens: number; cost: number | null }[] {
    return this.usage.usageByDay(userId, days);
  }

  /** Per-model token/cost spend of the user's own brain chat sessions for the Stats page — see
   *  {@link BrainUsageStore.usageByModel}. */
  usageByModel(userId: number, window?: { fromIso?: string; toIso?: string }): ReturnType<BrainUsageStore['usageByModel']> {
    return this.usage.usageByModel(userId, window);
  }

  /** Cumulative token total per session (summed from each stored assistant message's usage) for the
   *  session-management panel. One grouped query — no N+1. Sessions with no usage-bearing messages
   *  come back 0. Persisted messages only, so a mid-turn session reads slightly stale (acceptable). */
  tokenTotals(userId: number): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT s.id AS id, COALESCE(SUM(json_extract(m.content, '$.usage.totalTokens')), 0) AS tokens
         FROM brain_sessions s LEFT JOIN brain_messages m ON m.session_id = s.id
        WHERE s.user_id = ? GROUP BY s.id`
    ).all(userId) as { id: string; tokens: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.id] = r.tokens ?? 0;
    return out;
  }

  /** Cumulative token/cost total of a session's whole delegated descendant tree — see
   *  {@link BrainUsageStore.descendantUsage}. */
  descendantUsage(sessionId: string): ReturnType<BrainUsageStore['descendantUsage']> {
    return this.usage.descendantUsage(sessionId);
  }

  appendMessage(input: { id: string; sessionId: string; parentId: string | null; role: string; content: unknown }): BrainMessageRow {
    this.db.prepare(
      `INSERT INTO brain_messages (id, session_id, parent_id, role, content)
       VALUES (@id, @session_id, @parent_id, @role, @content)`
    ).run({
      id: input.id, session_id: input.sessionId, parent_id: input.parentId,
      role: input.role, content: JSON.stringify(input.content),
    });
    return this.db.prepare('SELECT * FROM brain_messages WHERE id = ?').get(input.id) as BrainMessageRow;
  }

  /** Remove one message only from its expected session. Used to roll back a pre-projected user row when
   * PI rejects a prompt before its native preflight boundary; the session condition prevents a stale
   * caller from deleting a row that compaction/session migration moved elsewhere. */
  deleteMessage(sessionId: string, messageId: string): boolean {
    return this.db.prepare('DELETE FROM brain_messages WHERE id = ? AND session_id = ?')
      .run(messageId, sessionId).changes > 0;
  }

  /** Mirror ONE message the moment PI finishes it, so a daemon restart mid-turn no longer discards the
   *  whole run. Provisional by construction: these rows never outlive their turn — `persistAgentRun`
   *  drops every pending row in the same transaction that writes the settled run in PI's real execution
   *  order, and rows that survive at all are the remains of a turn that never settled, graduated by
   *  `settlePartialTurn` on respawn. The caller mints the id: PI's `message_end` carries the finished
   *  message but no entry id of its own. */
  appendPendingMessage(input: { id: string; sessionId: string; role: string; content: unknown }): void {
    this.db.prepare(
      `INSERT INTO brain_messages (id, session_id, parent_id, role, content, pending)
       VALUES (@id, @session_id, NULL, @role, @content, 1)
       ON CONFLICT(id) DO NOTHING`
    ).run({ id: input.id, session_id: input.sessionId, role: input.role, content: JSON.stringify(input.content) });
  }

  /** The session's provisional mid-turn rows, oldest first. */
  pendingMessages(sessionId: string): BrainMessageRow[] {
    return this.db.prepare('SELECT * FROM brain_messages WHERE session_id = ? AND pending = 1 ORDER BY rowid ASC')
      .all(sessionId) as BrainMessageRow[];
  }

  /** Promote the session's surviving mid-turn rows to durable history. Called when a session is respawned
   *  with rows still pending, which can only mean the turn that wrote them never settled (a restart or a
   *  crash) — so what it managed to produce is all the history that turn will ever have. */
  settlePendingMessages(sessionId: string): void {
    this.db.prepare('UPDATE brain_messages SET pending = 0 WHERE session_id = ? AND pending = 1').run(sessionId);
  }

  /**
   * Persist one settled agent run in the order PI actually executed it. User prompts are intentionally
   * projected before `prompt()` so compaction can see them, but a mid-turn steer can arrive after the
   * agent has already emitted assistant/tool output. At `agent_end`, reconstructing the run atomically
   * lets those existing clean user rows land between the matching generated messages instead of leaving
   * them prematurely at the end of the previous durable prefix. Message rowid is the canonical transcript
   * sequence: `created_at` remains the real wall-clock metadata and therefore cannot order an assistant
   * emitted before a later steer when that assistant is only persisted at agent_end.
   *
   * Returns false when the expected pre-projected user suffix is no longer present. Callers then retain
   * the safe legacy append path rather than guessing which historical rows belong to this run.
   *
   * EITHER WAY this drops the run's provisional mid-turn rows first, inside the same transaction: the
   * settled `agent_end` carries the very same messages, so leaving them would duplicate the entire turn.
   * That is why the drop happens here rather than at the call site — the fallback append path above must
   * never run against a store that still holds them.
   */
  persistAgentRun(sessionId: string, messages: BrainRunMessage[]): boolean {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ? AND pending = 1').run(sessionId);
      const userCount = messages.filter((message) => message.reusePreprojectedUser).length;
      if (userCount === 0) return false;
      const rows = this.db.prepare(
        'SELECT id, session_id, parent_id, role, content, created_at FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC'
      ).all(sessionId) as BrainMessageRow[];
      const users = rows.slice(-userCount);
      if (users.length !== userCount || users.some((row) => row.role !== 'user')) return false;

      const prefix = rows.slice(0, rows.length - userCount);
      let nextUser = 0;
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const ordered: BrainMessageRow[] = [...prefix];
      for (const message of messages) {
        if (message.reusePreprojectedUser) {
          const user = users[nextUser++];
          if (!user) return false; // defensive; the count check above should make this unreachable
          ordered.push(user);
          continue;
        }
        if (!message.id || message.content === undefined) return false;
        ordered.push({
          id: message.id,
          session_id: sessionId,
          parent_id: message.parentId ?? null,
          role: message.role,
          content: JSON.stringify(message.content),
          created_at: now,
        });
      }
      if (nextUser !== users.length) return false;

      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ?').run(sessionId);
      const insert = this.db.prepare(
        `INSERT INTO brain_messages (id, session_id, parent_id, role, content, created_at)
         VALUES (@id, @session_id, @parent_id, @role, @content, @created_at)`
      );
      for (const row of ordered) insert.run(row);
      return true;
    })();
  }

  /** created_at of the session's newest stored message (undefined when it has none) — drives the
   *  idle-rollover check without loading the whole history. */
  lastMessageAt(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT MAX(created_at) AS ts FROM brain_messages WHERE session_id = ?').get(sessionId) as { ts: string | null };
    return row.ts ?? undefined;
  }

  getMessages(sessionId: string): BrainMessageRow[] {
    return this.db.prepare('SELECT * FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC')
      .all(sessionId) as BrainMessageRow[];
  }

  /** Persist a display card (ctx.emitCard) so the panel outlives the live session — closing the chat
   *  disposes the session, and a memory-only todo list would die with it. An upsert keeps the row's
   *  rowid, so re-emitting a card updates it in place without jumping to the end of the panel. */
  upsertCard(sessionId: string, card: BrainCard): void {
    this.db.prepare(`INSERT INTO brain_cards (session_id, card_id, payload, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(session_id, card_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(sessionId, card.id, JSON.stringify(card));
  }

  deleteCard(sessionId: string, cardId: string): void {
    this.db.prepare('DELETE FROM brain_cards WHERE session_id = ? AND card_id = ?').run(sessionId, cardId);
  }

  /** Persist (or refresh) the terminal binding for an (admin, conversation) pair. The UNIQUE constraint
   *  guarantees one terminal per conversation; a re-open of a session whose tmux died updates the name +
   *  token in place (BrainTerminalService revokes the stale token before re-minting). */
  upsertBrainTerminal(input: { terminalName: string; userId: number; brainSessionId: string; token: string }): void {
    this.db.prepare(`INSERT INTO brain_terminals (terminal_name, user_id, brain_session_id, token)
      VALUES (@terminalName, @userId, @brainSessionId, @token)
      ON CONFLICT(user_id, brain_session_id) DO UPDATE SET terminal_name = excluded.terminal_name, token = excluded.token`)
      .run(input);
  }
  getBrainTerminalBySession(userId: number, brainSessionId: string): BrainTerminalRow | undefined {
    return this.db.prepare('SELECT * FROM brain_terminals WHERE user_id = ? AND brain_session_id = ?')
      .get(userId, brainSessionId) as BrainTerminalRow | undefined;
  }
  getBrainTerminal(terminalName: string): BrainTerminalRow | undefined {
    return this.db.prepare('SELECT * FROM brain_terminals WHERE terminal_name = ?').get(terminalName) as BrainTerminalRow | undefined;
  }
  deleteBrainTerminal(terminalName: string): void {
    this.db.prepare('DELETE FROM brain_terminals WHERE terminal_name = ?').run(terminalName);
  }
  listBrainTerminals(): BrainTerminalRow[] {
    return this.db.prepare('SELECT * FROM brain_terminals').all() as BrainTerminalRow[];
  }

  /** The conversation's persisted cards, in the order they were first emitted. A row that no longer parses
   *  (hand-edited DB, a payload written by an older shape) is skipped rather than taking the panel down. */
  getCards(sessionId: string): BrainCard[] {
    const rows = this.db.prepare('SELECT payload FROM brain_cards WHERE session_id = ? ORDER BY rowid ASC')
      .all(sessionId) as { payload: string }[];
    const cards: BrainCard[] = [];
    for (const row of rows) {
      try {
        const card = JSON.parse(row.payload) as BrainCard;
        if (card && typeof card.id === 'string' && card.id) cards.push(card);
      } catch { /* unparseable row — drop this card, keep the rest of the panel */ }
    }
    return cards;
  }

  /** Persist the newest progress snapshot for one delegate tool call — see
   *  {@link BrainDelegationStore.upsertSubagentRun}. */
  upsertSubagentRun(parentSessionId: string, raw: unknown): boolean {
    return this.delegation.upsertSubagentRun(parentSessionId, raw);
  }

  /** The still-valid direct same-owner sub-agent runs of a conversation — see
   *  {@link BrainDelegationStore.getSubagentRuns}. */
  getSubagentRuns(parentSessionId: string): ReturnType<BrainDelegationStore['getSubagentRuns']> {
    return this.delegation.getSubagentRuns(parentSessionId);
  }

  /** Persist the newest whole-DAG workflow snapshot for one tool call — see
   *  {@link BrainDelegationStore.upsertWorkflowRun}. */
  upsertWorkflowRun(parentSessionId: string, raw: unknown): boolean {
    return this.delegation.upsertWorkflowRun(parentSessionId, raw);
  }

  /** The durable workflow DAGs of one conversation, drill-in targets re-derived from the live relation —
   *  see {@link BrainDelegationStore.getWorkflowRuns}. */
  getWorkflowRuns(parentSessionId: string): ReturnType<BrainDelegationStore['getWorkflowRuns']> {
    return this.delegation.getWorkflowRuns(parentSessionId);
  }

  /** Append a display-only session-event marker (model/mode/rename/reasoning change). Insertion order
   *  (rowid) is the timeline; the marker never touches brain_messages, so it stays out of model context. */
  appendSessionEvent(sessionId: string, kind: SessionEventKind, detail: string): BrainSessionEvent {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO brain_session_events (session_id, event_id, kind, detail) VALUES (?, ?, ?, ?)'
    ).run(sessionId, id, kind, detail);
    const row = this.db.prepare(
      'SELECT created_at FROM brain_session_events WHERE session_id = ? AND event_id = ?'
    ).get(sessionId, id) as { created_at: string };
    return { id, kind, detail, at: dbTsToIso(row.created_at) };
  }

  /** The session's markers in event order, for the boot/reconnect snapshot (interleaved into the
   *  transcript client-side by `at`). Malformed rows are dropped at this boundary. */
  getSessionEvents(sessionId: string): BrainSessionEvent[] {
    const rows = this.db.prepare(
      'SELECT event_id, kind, detail, created_at FROM brain_session_events WHERE session_id = ? ORDER BY rowid ASC'
    ).all(sessionId) as { event_id: string; kind: string; detail: string; created_at: string }[];
    const out: BrainSessionEvent[] = [];
    for (const row of rows) {
      if (!isSessionEventKind(row.kind)) continue;
      out.push({ id: row.event_id, kind: row.kind, detail: row.detail, at: dbTsToIso(row.created_at) });
    }
    return out;
  }

  /** Persist a terminal child result before any attempt to wake the parent — see
   *  {@link BrainDelegationStore.enqueueSubagentResult}. */
  enqueueSubagentResult(parentSessionId: string, raw: unknown): boolean {
    return this.delegation.enqueueSubagentResult(parentSessionId, raw);
  }

  /** The parent's still-undelivered child results, oldest first — see
   *  {@link BrainDelegationStore.pendingSubagentResults}. */
  pendingSubagentResults(parentSessionId: string): ReturnType<BrainDelegationStore['pendingSubagentResults']> {
    return this.delegation.pendingSubagentResults(parentSessionId);
  }

  acknowledgeSubagentResult(parentSessionId: string, resultId: string): boolean {
    return this.delegation.acknowledgeSubagentResult(parentSessionId, resultId);
  }

  noteSubagentResultFailure(parentSessionId: string, resultId: string): void {
    this.delegation.noteSubagentResultFailure(parentSessionId, resultId);
  }

  /** Case-insensitive fulltext search across the user's OWN chat conversations. Shared platform
   *  sessions (`brain-ch-*`, which carry other members' messages) and ephemeral subagent runs
   *  (`brain-task-*`) are excluded — the search backs the personal chat sidebar, not the Discord logs.
   *  The LIKE over the raw content JSON is a coarse prefilter; each candidate is confirmed against its
   *  extracted display text (so JSON keys never match) and shaped into a ±60-char snippet. Newest first.
   *  The SQL row scan is bounded (recent-biased) so a broad `%q%` can't scan the whole table. */
  searchMessages(userId: number, query: string, limit = 50): BrainSearchHit[] {
    const q = query.trim();
    if (q.length < 2) return [];
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rows = this.db.prepare(
      `SELECT m.session_id, s.title, m.role, m.content, m.created_at
         FROM brain_messages m JOIN brain_sessions s ON s.id = m.session_id
        WHERE s.user_id = ? AND m.role IN ('user', 'assistant') AND m.content LIKE ? ESCAPE '\\'
          AND m.session_id NOT LIKE '${CHANNEL_PREFIX}%' AND m.session_id NOT LIKE '${TASK_PREFIX}%'
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT 500`
    ).all(userId, like) as { session_id: string; title: string; role: string; content: string; created_at: string }[];
    const needle = q.toLowerCase();
    const hits: BrainSearchHit[] = [];
    for (const r of rows) {
      if (hits.length >= limit) break;
      let text = '';
      try { text = extractText(JSON.parse(r.content)); } catch { continue; }
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue; // LIKE hit the JSON structure, not the display text
      const from = Math.max(0, at - SNIPPET_RADIUS);
      const to = Math.min(text.length, at + q.length + SNIPPET_RADIUS);
      const body = text.slice(from, to).replace(/\s+/g, ' ');
      hits.push({
        sessionId: r.session_id, sessionTitle: r.title, role: r.role,
        snippet: `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`, ts: r.created_at,
      });
    }
    return hits;
  }

  /** Bind a conversation to the client-reported working directory it was started/used from (already
   *  validated by the caller — see BrainService.stampWorkDir). Empty stays empty: a cwd-less legacy or
   *  web session is never stamped, so it keeps working as "matches nowhere" for the CLI resolution. */
  setWorkDir(id: string, workDir: string): void {
    this.db.prepare('UPDATE brain_sessions SET work_dir = ? WHERE id = ?').run(workDir, id);
  }

  /** Set a session's display title (derived from its first user message; set once). */
  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE brain_sessions SET title = ? WHERE id = ?').run(title, id);
  }

  /** Replace an automatically seeded title only while it is still the exact provisional value.
   *  Title generation runs in the background; this compare-and-set prevents its late result from
   *  overwriting a manual /rename that completed while inference was in flight. */
  setTitleIfCurrent(id: string, current: string, title: string): boolean {
    return this.db.prepare('UPDATE brain_sessions SET title = ? WHERE id = ? AND title = ?')
      .run(title, id, current).changes > 0;
  }

  renameSession(id: string, title: string): void {
    this.db.prepare("UPDATE brain_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id);
  }

  touchSession(id: string, model?: string): void {
    if (model === undefined) {
      this.db.prepare("UPDATE brain_sessions SET updated_at = datetime('now') WHERE id = ?").run(id);
    } else {
      this.db.prepare("UPDATE brain_sessions SET updated_at = datetime('now'), model = ? WHERE id = ?").run(model, id);
    }
  }

  /** Delete one conversation and its goal + messages atomically — a crash between the DELETEs would
   *  otherwise orphan goal/message rows against a gone session (no FK CASCADE here). */
  deleteSession(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM brain_subagent_results WHERE parent_session_id = ? OR child_session_id = ?').run(id, id);
      this.db.prepare('DELETE FROM brain_subagent_runs WHERE parent_session_id = ? OR child_session_id = ?').run(id, id);
      // A child remains a valid standalone transcript if its parent is deleted from history.
      this.db.prepare('UPDATE brain_sessions SET parent_session_id = NULL WHERE parent_session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_goals WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_cards WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_session_events WHERE session_id = ?').run(id);
      // Only as the ORIGIN: a workflow outlives any one of its node children (getWorkflowRuns simply
      // stops resolving that node's drill-in), so deleting a node session must not take the DAG with it.
      this.db.prepare('DELETE FROM brain_workflows WHERE parent_session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM brain_sessions WHERE id = ?').run(id);
    })();
    // Cleared tool-result spills live outside the DB, one directory per session — remove them with
    // their conversation. Best-effort: a missing or unwritable spill dir must not fail the delete.
    try { rmSync(toolResultSpillDir(process.env, id), { recursive: true, force: true }); }
    catch (e) { logger('brain-store').warn(`failed to remove tool-result spills for ${id}`, e); }
  }

  /** Re-key a session — its row, messages and goal — to a new id, atomically (a crash mid-move would
   *  otherwise split a conversation across two ids). Used by channel idle rollover to ARCHIVE the old
   *  transcript under a fresh unique id (freeing the deterministic channel id for a new session) while
   *  keeping the old conversation and its title fully browsable, exactly as owner-chat rollover keeps
   *  the prior conversation. Delegated children follow the archived parent id; `parent_id` on messages
   *  references message ids (not session ids), so that separate column needs no rewrite. */
  reassignSession(oldId: string, newId: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE brain_sessions SET id = ? WHERE id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_sessions SET parent_session_id = ? WHERE parent_session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_subagent_runs SET parent_session_id = ? WHERE parent_session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_subagent_runs SET child_session_id = ? WHERE child_session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_subagent_results SET parent_session_id = ? WHERE parent_session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_subagent_results SET child_session_id = ? WHERE child_session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_messages SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_goals SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_cards SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE brain_session_events SET session_id = ? WHERE session_id = ?').run(newId, oldId);
      // No JSON surgery for the node session ids inside `state`: only a session addressed by a
      // deterministic channel id is ever re-keyed, and node children run on single-use uuid channel ids,
      // so a node can never be `oldId`. getWorkflowRuns re-validates them on read regardless.
      this.db.prepare('UPDATE brain_workflows SET parent_session_id = ? WHERE parent_session_id = ?').run(newId, oldId);
    })();
    // Tool-result spills are keyed by session id too — move them with the conversation, or they stay
    // under the freed old id: orphaned forever (nothing would ever delete them) and readable by the
    // NEXT session minted onto that id. Best-effort: ENOENT just means there was nothing to move.
    try { renameSync(toolResultSpillDir(process.env, oldId), toolResultSpillDir(process.env, newId)); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger('brain-store').warn(`failed to move tool-result spills ${oldId} → ${newId}`, e);
      }
    }
  }

  /** Fold a context compaction into the store, atomically (ONE transaction — never a partial state):
   *  KEEP the last `keepLastN` message rows exactly as they already are (original id, role, content AND
   *  original created_at — the CLEAN persisted turns), DROP every row older than that tail, and insert
   *  the compaction summary as a `compaction` divider directly BEFORE the kept tail. So both
   *  `getMessages`/history and `rehydrate` return the model's shrunk context (summary + kept tail)
   *  instead of the full pre-compaction log — fixing the otherwise-ephemeral compaction (token savings
   *  were silently lost on the next respawn).
   *
   *  Why NOT re-serialize the live PI context: those user messages carry the ephemeral live-prompt
   *  framing (memory/permissions/turn-context blocks) + raw image bytes, so persisting them verbatim
   *  would leak internal framing into history and bloat SQLite. The store's own rows are the single
   *  clean source of history — this only rearranges rows already in it (see `persistCompaction`).
   *
   *  Implementation: the kept tail is deleted-and-reinserted with its ORIGINAL id/content/created_at so
   *  the summary is inserted first in the canonical rowid sequence while every kept row keeps its true
   *  timestamp (searchMessages / lastMessageAt stay truthful). `keepLastN >= total` keeps the whole log;
   *  `keepLastN <= 0` keeps just the summary. */
  compactSessionMessages(sessionId: string, summary: { id: string; role: string; content: unknown }, keepLastN: number): void {
    this.db.transaction(() => {
      const rows = this.db.prepare(
        'SELECT id, parent_id, role, content, created_at FROM brain_messages WHERE session_id = ? ORDER BY rowid ASC'
      ).all(sessionId) as BrainMessageRow[];
      const keep = keepLastN <= 0 ? [] : rows.slice(Math.max(0, rows.length - keepLastN));
      // Fold the token/cost usage of the rows about to be deleted onto the divider (under `$.usageRollup`)
      // so a compacted session's historical spend survives — the usage aggregates read it. Deleting these
      // rows would otherwise silently ERASE that spend from the Stats page / daily tiles.
      const dropped = rows.slice(0, rows.length - keep.length);
      const rollup = rollupDroppedUsage(dropped);
      const summaryContent = rollup && typeof summary.content === 'object' && summary.content !== null && !Array.isArray(summary.content)
        ? { ...(summary.content as Record<string, unknown>), usageRollup: rollup }
        : summary.content;
      this.db.prepare('DELETE FROM brain_messages WHERE session_id = ?').run(sessionId);
      const insert = this.db.prepare(
        `INSERT INTO brain_messages (id, session_id, parent_id, role, content, created_at)
         VALUES (@id, @session_id, @parent_id, @role, @content, @created_at)`
      );
      // Summary first → it gets the lowest rowid of the fresh batch. Pin its display/accounting timestamp
      // to the oldest kept row while rowid remains the authoritative transcript order.
      const summaryTs = keep[0]?.created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
      insert.run({ id: summary.id, session_id: sessionId, parent_id: null, role: summary.role, content: JSON.stringify(summaryContent), created_at: summaryTs });
      for (const r of keep) {
        insert.run({ id: r.id, session_id: sessionId, parent_id: r.parent_id, role: r.role, content: r.content, created_at: r.created_at });
      }
      // Markers annotate turns, so they die with the turns they annotate. Both tables stamp `datetime('now')`,
      // so this compares chronologically; `<` keeps any marker sharing the oldest kept row's second. Without
      // it a summarized-away marker outlives its turn and, being older than the divider, renders ABOVE it —
      // annotating a turn the reader can no longer see.
      this.db.prepare('DELETE FROM brain_session_events WHERE session_id = ? AND created_at < ?').run(sessionId, summaryTs);
    })();
  }

  /** Delete every conversation (+ goals + messages) for a user atomically — same orphan concern. */
  removeForUser(userId: number): void {
    this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM brain_subagent_results
          WHERE parent_session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)
             OR child_session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)`
      ).run(userId, userId);
      this.db.prepare(
        `DELETE FROM brain_subagent_runs
          WHERE parent_session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)
             OR child_session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)`
      ).run(userId, userId);
      this.db.prepare('DELETE FROM brain_goals WHERE user_id = ?').run(userId);
      // Every per-session sidecar goes too. These three were missing, so deleting a user left rows
      // holding their conversation content behind — keyed to session ids that no longer exist.
      this.db.prepare('DELETE FROM brain_workflows WHERE parent_session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_cards WHERE session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_session_events WHERE session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_messages WHERE session_id IN (SELECT id FROM brain_sessions WHERE user_id = ?)').run(userId);
      this.db.prepare('DELETE FROM brain_sessions WHERE user_id = ?').run(userId);
    })();
  }

  upsertGoal(input: { sessionId: string; userId: number; goal: string; status?: BrainGoalRow['status']; draft?: string; turnBudget?: number }): BrainGoalRow {
    this.db.prepare(
      `INSERT INTO brain_goals (session_id, user_id, status, goal, draft, turn_budget)
       VALUES (@session_id, @user_id, @status, @goal, @draft, @turn_budget)
       ON CONFLICT(session_id) DO UPDATE SET
         user_id = excluded.user_id,
         status = excluded.status,
         goal = excluded.goal,
         draft = excluded.draft,
         turns_used = 0,
         turn_budget = excluded.turn_budget,
         last_verdict = '',
         last_evidence = '',
         paused_reason = '',
         created_at = datetime('now'),
         updated_at = datetime('now')`
    ).run({
      session_id: input.sessionId,
      user_id: input.userId,
      status: input.status ?? 'active',
      goal: input.goal,
      draft: input.draft ?? '',
      turn_budget: input.turnBudget ?? 8,
    });
    return this.getGoal(input.sessionId)!;
  }

  getGoal(sessionId: string): BrainGoalRow | undefined {
    return this.db.prepare('SELECT * FROM brain_goals WHERE session_id = ?').get(sessionId) as BrainGoalRow | undefined;
  }

  /** All goals currently marked `active`. Used at daemon boot to reconcile restart zombies — their
   *  in-memory continuation timers died with the process, so the rows falsely claim to be running. */
  activeGoals(): BrainGoalRow[] {
    return this.db.prepare("SELECT * FROM brain_goals WHERE status = 'active'").all() as BrainGoalRow[];
  }

  updateGoal(sessionId: string, patch: Partial<Pick<BrainGoalRow, 'status' | 'subgoals' | 'turns_used' | 'last_verdict' | 'last_evidence' | 'paused_reason'>>): BrainGoalRow | undefined {
    // Runtime column whitelist — the keys are interpolated into SQL, so never trust the object's shape
    // (a route could forward a parsed body here); only these columns may be written.
    const ALLOWED = new Set(['status', 'subgoals', 'turns_used', 'last_verdict', 'last_evidence', 'paused_reason']);
    const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && ALLOWED.has(k));
    if (entries.length === 0) return this.getGoal(sessionId);
    const sets = entries.map(([k]) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE brain_goals SET ${sets}, updated_at = datetime('now') WHERE session_id = @session_id`)
      .run({ ...Object.fromEntries(entries), session_id: sessionId });
    return this.getGoal(sessionId);
  }

  clearGoal(sessionId: string): void {
    this.db.prepare('DELETE FROM brain_goals WHERE session_id = ?').run(sessionId);
  }
}
